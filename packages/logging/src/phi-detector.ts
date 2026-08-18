/**
 * PHI Detection Utility for Logging Safety
 *
 * This module provides utilities to detect Protected Health Information (PHI)
 * in log messages and data structures. Use this to prevent accidental PHI
 * leakage through application logs.
 *
 * @module phi-detector
 */

/**
 * Patterns that indicate PHI might be present in a log message
 */
const PHI_PATTERNS = [
  // Transcription-related PHI
  /\btext\s*[:=]/i, // transcript text fields
  /\bwords\s*[:=]/i, // word arrays from transcription
  /\bsegments\s*[:=]/i, // speaker segments
  /\btranscript\s*[:=]/i, // full transcript data

  // Raw data dumps
  /\bfullData\b/i, // entire payloads
  /\brawData\b/i, // raw data dumps
  /\bpayload\s*[:=].*\{/i, // full payload objects

  // Speaker/biometric data
  /\bvoiceprint\b/i, // biometric voiceprint data
  /\bspeaker\s*[:=].*["']/i, // speaker names/labels with values
  /\bdiarization\s*[:=]/i, // speaker diarization results

  // Clinical notes
  /\bsoapNote\b/i, // SOAP notes
  /\bclinicalNote\b/i, // clinical documentation
  /\bpatientNote\b/i, // patient-specific notes

  // Patient identifiers
  /\bpatient\s*[:=].*["']/i, // patient names/identifiers with values
  /\bpatientId\s*[:=].*["']/i, // patient IDs with string values (not UUIDs alone)
  /\bmrn\s*[:=]/i, // medical record numbers

  // Suspicious JSON stringification
  /JSON\.stringify\(.*data.*\)/i, // stringifying data objects
];

/**
 * Field names that commonly contain PHI/PII and should never be logged.
 *
 * Enforced in three places:
 * 1. `extractPHIFields` / `detectPHI` — used by `assertPHISafe` to catch
 *    leaks at authoring time.
 * 2. `emitToEventSink` — before forwarding to any registered sink, values
 *    at these keys are stripped (see `logMetadata`).
 * 3. `redaction.ts` — `REDACTED_FIELD_NAMES` is built from this list, and
 *    `pino.config.ts` censors those names at every depth on the way to
 *    stdout.
 *
 * This is the single source of truth for all three. It used to cover only
 * the event sink while `pino.redact.paths` carried its own shorter list,
 * which meant the clinical fields below (`transcript`, `soapNote`, the S3
 * keys) were stripped from the audit sink but written to stdout — and
 * stdout is what ships to log aggregation. Adding a name here now protects
 * both channels; do not reintroduce a second list.
 */
export const PHI_FIELD_NAMES = [
  // Healthcare / transcription PHI
  'text',
  'words',
  'transcript',
  'soapNote',
  'clinicalNote',
  'patientNote',
  // Generic clinical free-text fields commonly present in EMR DTOs.
  // Treated as PHI by name because in a healthcare context these typically
  // carry patient instructions, alert flags, or document bodies. Consumers
  // logging non-PHI fields with these names should rename or convert via
  // `logMetadata` before logging.
  'notes',
  'alert',
  'content',
  'fullData',
  'rawData',
  'rawDataSample',
  'voiceprint',
  'segments',
  'diarization',
  'speaker',
  'patient',
  'patientId',
  'mrn',
  'medicalRecordNumber',
  'healthInsuranceNumber',
  'insuranceId',
  // General PII (mirrors pino.redact.paths so the event sink does not leak
  // fields that stdout already redacts)
  'ssn',
  'dob',
  'dateOfBirth',
  'email',
  'phone',
  'phoneNumber',
  'address',
  'creditCard',
  'bankAccount',
  // Auth / credentials (mirrors pino.redact.paths)
  'password',
  'token',
  'secret',
  'apiKey',
  'sessionId',
  // S3 URLs and keys (contain encounter IDs and provide access to PHI audio recordings)
  'audioFileUrl',
  'audioFileKey',
  'recordingUrl',
  'downloadUrl',
  'uploadUrl',
  'completeAudioFileKey',
  'inputKey',
  'outputKey',
  'compressedKey',
  'oggKey',
];

/**
 * Collapse a field name to a case- and separator-insensitive form.
 *
 * The stdout walk in `redaction.ts` matches names this way, so the detector
 * and the event sink must use the same rule or the two channels drift apart
 * again — which is precisely the defect that made this list the single source
 * of truth. `patientId`, `PatientId`, `patient_id` and `PATIENT-ID` are one
 * field wearing four house styles, and a healthcare backend meets all of them:
 * PascalCase is what .NET and most EMR vendor APIs emit.
 */
export function normalizePHIName(name: string): string {
  return name.toLowerCase().replace(/[_-]/g, '');
}

const NORMALIZED_PHI_FIELD_NAMES: ReadonlySet<string> = new Set(
  PHI_FIELD_NAMES.map(normalizePHIName),
);

/** True when `key` names a PHI/PII field, in any case or separator style. */
export function isPHIFieldName(key: string): boolean {
  return NORMALIZED_PHI_FIELD_NAMES.has(normalizePHIName(key));
}

/**
 * S3 URL/key field names, matched by the same normalized rule.
 *
 * Hoisted out of `logMetadataInner` so the set is built once rather than on
 * every nested object the sink walks.
 */
const NORMALIZED_S3_FIELD_NAMES: ReadonlySet<string> = new Set(
  [
    'audioFileUrl',
    'audioFileKey',
    'recordingUrl',
    'downloadUrl',
    'uploadUrl',
    'completeAudioFileKey',
    'inputKey',
    'outputKey',
    'compressedKey',
    'oggKey',
  ].map(normalizePHIName),
);

/**
 * JSON.stringify that returns `undefined` instead of throwing on circular
 * references. Request/response objects routinely contain back-refs (e.g.
 * `req.socket.parent === req`), and raw `JSON.stringify` crashes on them;
 * PHI detection should never take down the caller.
 */
function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/**
 * Detect potential PHI in a log message or data object
 *
 * @param logMessage - String or object that will be logged
 * @returns true if PHI patterns are detected, false otherwise
 *
 * @example
 * ```typescript
 * // Will return true (contains PHI)
 * detectPHI({ text: 'Patient said...' });
 * detectPHI('Processing transcript text: ...');
 *
 * // Will return false (safe metadata)
 * detectPHI({ textLength: 500, wordsCount: 100 });
 * detectPHI('Processing transcript with 500 characters');
 * ```
 */
export function detectPHI(logMessage: string | object): boolean {
  // First check if it's an object with PHI fields (cycle-safe)
  if (typeof logMessage === 'object' && logMessage !== null) {
    const phiFields = extractPHIFields(logMessage);
    if (phiFields.length > 0) {
      return true;
    }
  }

  // Then check string patterns. Circular objects already went through the
  // cycle-safe extractPHIFields above, so if the stringify-based pattern
  // check fails (returns undefined), treat as "no PHI detected in string
  // patterns" — the object-field check above is the real signal for
  // structured payloads.
  const str =
    typeof logMessage === 'string' ? logMessage : safeStringify(logMessage);
  if (str === undefined) {
    return false;
  }

  return PHI_PATTERNS.some((pattern) => pattern.test(str));
}

/**
 * Extract PHI field names found in a data object
 *
 * @param data - Object to scan for PHI field names
 * @returns Array of PHI field names found
 *
 * @example
 * ```typescript
 * const data = { text: '...', encounterId: '123', textLength: 500 };
 * extractPHIFields(data); // Returns: ['text']
 * ```
 */
export function extractPHIFields(data: unknown): string[] {
  return extractPHIFieldsInner(data, new WeakSet<object>());
}

function extractPHIFieldsInner(
  data: unknown,
  visited: WeakSet<object>,
): string[] {
  if (!data || typeof data !== 'object') {
    return [];
  }

  // Cycle guard: request/response objects routinely contain back-refs
  // (e.g. `req.socket.parent === req`). Without this, recursion would
  // stack-overflow on normal production payloads.
  if (visited.has(data as object)) {
    return [];
  }
  visited.add(data as object);

  const foundFields: string[] = [];

  for (const [key, value] of Object.entries(data)) {
    if (isPHIFieldName(key)) {
      foundFields.push(key);
    }

    if (typeof value === 'object' && value !== null) {
      const nestedFields = extractPHIFieldsInner(value, visited);
      foundFields.push(...nestedFields.map((f) => `${key}.${f}`));
    }
  }

  return foundFields;
}

/**
 * File extensions that may survive redaction.
 *
 * An allowlist rather than a shape test. "Short and alphanumeric" does not
 * separate a format hint from an identifier: `JaneDoe.MRN9987`,
 * `recording.20250817` and `note.Smith` all pass such a test, and each
 * publishes exactly the kind of value the rest of this function exists to
 * remove. Only a name already known to be a format carries no patient data.
 */
const SAFE_EXTENSIONS: ReadonlySet<string> = new Set([
  // Audio/video produced by the recording pipeline.
  'wav',
  'mp3',
  'ogg',
  'oga',
  'm4a',
  'aac',
  'flac',
  'opus',
  'webm',
  'mp4',
  'mov',
  // Documents and payloads the pipeline moves alongside them.
  'json',
  'txt',
  'csv',
  'xml',
  'pdf',
  'zip',
  'gz',
]);

/**
 * Redact an S3 URL or key for safe logging, keeping only the file extension.
 *
 * The filename is dropped, not preserved. Recording filenames routinely embed
 * exactly the identifiers this function exists to remove — an object key like
 * `encounters/123/JaneDoe-MRN9987-dob1975.wav` carries a patient name, an MRN
 * and a date of birth in the last path segment, so returning
 * `[REDACTED]/JaneDoe-MRN9987-dob1975.wav` redacted the part that was already
 * safe and published the part that was not.
 *
 * The extension survives because it is the only piece with diagnostic value
 * (which pipeline stage produced the object) and no identifying content.
 *
 * @param urlOrKey - S3 URL or key to redact
 * @returns `[REDACTED]` plus the extension, when one is present
 *
 * @example
 * ```typescript
 * redactS3Url('s3://bucket/encounters/123/audio.wav');
 * // Returns: '[REDACTED].wav'
 *
 * redactS3Url('https://bucket.s3.amazonaws.com/e/123/a.wav?X-Amz-Signature=...');
 * // Returns: '[REDACTED].wav'
 *
 * redactS3Url('s3://bucket/encounters/123/no-extension');
 * // Returns: '[REDACTED]'
 * ```
 */
function redactS3Url(urlOrKey: string): string {
  if (!urlOrKey || typeof urlOrKey !== 'string') {
    return '[REDACTED]';
  }

  // Drop the presigned query string and any fragment before looking at the
  // path — a signature is credential material, not part of the filename.
  const withoutQuery = urlOrKey.split(/[?#]/)[0] ?? '';
  const parts = withoutQuery.split('/');
  const filename = parts[parts.length - 1] ?? '';

  const dot = filename.lastIndexOf('.');
  // `dot < 1` covers both "no extension" and a dotfile like `.env`, whose
  // leading dot introduces a name rather than a format.
  if (dot < 1) {
    return '[REDACTED]';
  }

  const extension = filename.slice(dot + 1).toLowerCase();
  if (!SAFE_EXTENSIONS.has(extension)) {
    return '[REDACTED]';
  }

  return `[REDACTED].${extension}`;
}

/**
 * Create a PHI-safe version of a data object for logging
 *
 * Converts potentially sensitive fields to metadata (counts, lengths, flags)
 * instead of actual content.
 *
 * @param obj - Object to make PHI-safe
 * @returns PHI-safe metadata object
 *
 * @example
 * ```typescript
 * const data = { text: 'Patient said...', words: [...], encounterId: '123' };
 * const safe = logMetadata(data);
 * // Returns: { textLength: 16, wordsCount: 5, encounterId: '123' }
 * ```
 */
export function logMetadata(obj: unknown): Record<string, unknown> {
  return logMetadataInner(obj, new WeakSet<object>());
}

function logMetadataInner(
  obj: unknown,
  visited: WeakSet<object>,
): Record<string, unknown> {
  if (!obj || typeof obj !== 'object') {
    return { type: typeof obj };
  }

  // Cycle guard — same rationale as extractPHIFields.
  if (visited.has(obj as object)) {
    return { type: 'circular' };
  }
  visited.add(obj as object);

  const metadata: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    // Redact S3 URLs/keys, keeping only a recognized file extension
    if (
      NORMALIZED_S3_FIELD_NAMES.has(normalizePHIName(key)) &&
      typeof value === 'string'
    ) {
      metadata[key] = redactS3Url(value);
      continue;
    }

    // Skip other PHI fields entirely
    if (isPHIFieldName(key)) {
      if (Array.isArray(value)) {
        metadata[`${key}Count`] = value.length;
      } else if (typeof value === 'string') {
        metadata[`${key}Length`] = value.length;
      } else if (typeof value === 'object' && value !== null) {
        metadata[`has${key.charAt(0).toUpperCase()}${key.slice(1)}`] = true;
      }
      continue;
    }

    // Safe values can be logged directly
    if (Array.isArray(value)) {
      metadata[key] = value.map((item) =>
        typeof item === 'object' ? logMetadataInner(item, visited) : item,
      );
    } else if (typeof value === 'object' && value !== null) {
      metadata[key] = logMetadataInner(value, visited);
    } else {
      // Primitives (numbers, booleans, UUIDs) are generally safe
      metadata[key] = value;
    }
  }

  return metadata;
}

/**
 * Validate that a log statement is PHI-safe
 *
 * Throws an error if PHI is detected, otherwise returns true.
 * Useful for unit tests to enforce PHI-safe logging.
 *
 * @param logMessage - Message to validate
 * @param context - Optional context for error message
 * @throws Error if PHI is detected
 * @returns true if safe
 *
 * @example
 * ```typescript
 * // In tests
 * const logOutput = captureLogOutput(() => service.processTranscript(data));
 * expect(() => assertPHISafe(logOutput, 'processTranscript')).not.toThrow();
 * ```
 */
export function assertPHISafe(
  logMessage: string | object,
  context?: string,
): boolean {
  if (detectPHI(logMessage)) {
    const phiFields =
      typeof logMessage === 'object' ? extractPHIFields(logMessage) : [];

    const fieldInfo =
      phiFields.length > 0 ? `\nPHI fields found: ${phiFields.join(', ')}` : '';

    const rendered =
      typeof logMessage === 'string'
        ? logMessage
        : (safeStringify(logMessage) ?? '[circular or unstringifiable object]');

    throw new Error(
      `PHI detected in log message${context ? ` (${context})` : ''}${fieldInfo}\n` +
        `Message: ${rendered}`,
    );
  }

  return true;
}

/**
 * Type guard to check if a value contains PHI fields
 */
export function hasPHIFields(data: unknown): boolean {
  return extractPHIFields(data).length > 0;
}

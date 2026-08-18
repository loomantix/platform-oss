/**
 * Tests for PHI Detection Utility
 */

import {
  detectPHI,
  extractPHIFields,
  logMetadata,
  assertPHISafe,
  hasPHIFields,
} from './phi-detector';

// Helper function to extract error message
function getErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: string }).message);
  }
  return String(error);
}

describe('PHI Detector', () => {
  describe('detectPHI', () => {
    describe('should detect PHI in transcription data', () => {
      it('detects text field', () => {
        expect(detectPHI({ text: 'Patient said...' })).toBe(true);
        expect(detectPHI('Processing text: Patient said...')).toBe(true);
        expect(detectPHI('text: "Patient complained of..."')).toBe(true);
      });

      it('detects words field', () => {
        expect(detectPHI({ words: ['patient', 'said'] })).toBe(true);
        expect(detectPHI('words: [...]')).toBe(true);
        expect(detectPHI('words = data.words')).toBe(true);
      });

      it('detects transcript field', () => {
        expect(detectPHI({ transcript: 'Full transcript...' })).toBe(true);
        expect(detectPHI('transcript: "..."')).toBe(true);
      });

      it('detects segments field', () => {
        expect(detectPHI({ segments: [{ text: '...' }] })).toBe(true);
        expect(detectPHI('segments: [...]')).toBe(true);
      });
    });

    describe('should detect PHI in clinical notes', () => {
      it('detects SOAP notes', () => {
        expect(detectPHI({ soapNote: 'S: Patient reports...' })).toBe(true);
        expect(detectPHI('soapNote: "S: Patient..."')).toBe(true);
      });

      it('detects clinical notes', () => {
        expect(detectPHI({ clinicalNote: 'Patient history...' })).toBe(true);
        expect(detectPHI('clinicalNote: "..."')).toBe(true);
      });

      it('detects patient notes', () => {
        expect(detectPHI({ patientNote: 'Note about patient' })).toBe(true);
        expect(detectPHI('patientNote: "..."')).toBe(true);
      });
    });

    describe('should detect PHI in generic clinical free-text fields', () => {
      it('detects notes field', () => {
        expect(detectPHI({ notes: 'Patient instructions...' })).toBe(true);
      });

      it('detects alert field', () => {
        expect(detectPHI({ alert: 'Allergy: penicillin' })).toBe(true);
      });

      it('detects content field', () => {
        expect(detectPHI({ content: 'Referral letter body...' })).toBe(true);
      });
    });

    describe('should detect PHI in raw data dumps', () => {
      it('detects fullData field', () => {
        expect(detectPHI({ fullData: { text: '...' } })).toBe(true);
        expect(detectPHI('fullData: {...}')).toBe(true);
      });

      it('detects rawData field', () => {
        expect(detectPHI({ rawData: 'raw content' })).toBe(true);
        expect(detectPHI('rawData = response.data')).toBe(true);
      });

      it('detects JSON.stringify of data objects', () => {
        expect(detectPHI('JSON.stringify(data)')).toBe(true);
        expect(detectPHI('JSON.stringify(transcriptionData)')).toBe(true);
        expect(detectPHI('debug: JSON.stringify(responseData)')).toBe(true);
      });

      it('detects payload with object content', () => {
        expect(detectPHI('payload: { text: "..." }')).toBe(true);
        expect(detectPHI('payload = { data }')).toBe(true);
      });
    });

    describe('should detect PHI in speaker/biometric data', () => {
      it('detects voiceprint data', () => {
        expect(detectPHI({ voiceprint: 'base64data...' })).toBe(true);
        expect(detectPHI('voiceprint: "..."')).toBe(true);
      });

      it('detects speaker identification with values', () => {
        expect(detectPHI({ speaker: 'Dr. Smith' })).toBe(true);
        expect(detectPHI('speaker: "John Doe"')).toBe(true);
        expect(detectPHI("speaker = 'Patient'")).toBe(true);
      });

      it('detects diarization results', () => {
        expect(detectPHI({ diarization: [{ speaker: 'A' }] })).toBe(true);
        expect(detectPHI('diarization: [...]')).toBe(true);
      });
    });

    describe('should detect PHI in patient identifiers', () => {
      it('detects patient names with values', () => {
        expect(detectPHI({ patient: 'John Doe' })).toBe(true);
        expect(detectPHI('patient: "Jane Smith"')).toBe(true);
        expect(detectPHI("patient = 'Bob Jones'")).toBe(true);
      });

      it('detects patient IDs with string values', () => {
        expect(detectPHI({ patientId: 'P12345' })).toBe(true);
        expect(detectPHI('patientId: "MRN-12345"')).toBe(true);
      });

      it('detects medical record numbers', () => {
        expect(detectPHI({ mrn: '12345' })).toBe(true);
        expect(detectPHI('mrn: "MRN-67890"')).toBe(true);
      });
    });

    describe('should NOT detect PHI in safe metadata', () => {
      it('allows textLength instead of text', () => {
        expect(detectPHI({ textLength: 500 })).toBe(false);
        expect(detectPHI('textLength: 500')).toBe(false);
      });

      it('allows wordsCount instead of words', () => {
        expect(detectPHI({ wordsCount: 100 })).toBe(false);
        expect(detectPHI('wordsCount: 100')).toBe(false);
      });

      it('allows segment counts instead of segments', () => {
        expect(detectPHI({ segmentCount: 10 })).toBe(false);
        expect(detectPHI('segmentCount: 10')).toBe(false);
      });

      it('allows UUIDs and identifiers without field names', () => {
        expect(
          detectPHI({ encounterId: '123e4567-e89b-12d3-a456-426614174000' }),
        ).toBe(false);
        expect(detectPHI({ userId: 'usr_abc123' })).toBe(false);
      });

      it('allows structure/type information', () => {
        expect(detectPHI({ hasText: true, hasWords: true })).toBe(false);
        expect(detectPHI('hasText: true, hasSegments: false')).toBe(false);
      });

      it('allows safe event messages', () => {
        expect(detectPHI('Processing transcription')).toBe(false);
        expect(detectPHI('Transcription completed successfully')).toBe(false);
        expect(detectPHI('No segments found for encounter')).toBe(false);
      });
    });
  });

  describe('extractPHIFields', () => {
    it('extracts top-level PHI fields', () => {
      const data = {
        text: 'Patient said...',
        encounterId: '123',
        textLength: 500,
      };
      const fields = extractPHIFields(data);
      expect(fields).toContain('text');
      expect(fields).not.toContain('encounterId');
      expect(fields).not.toContain('textLength');
    });

    it('extracts nested PHI fields', () => {
      const data = {
        encounter: { transcript: 'Full text...' },
        metadata: { count: 10 },
      };
      const fields = extractPHIFields(data);
      expect(fields).toContain('encounter.transcript');
      expect(fields).not.toContain('metadata.count');
    });

    it('extracts multiple PHI fields', () => {
      const data = {
        text: '...',
        words: [],
        soapNote: '...',
        encounterId: '123',
      };
      const fields = extractPHIFields(data);
      expect(fields).toHaveLength(3);
      expect(fields).toContain('text');
      expect(fields).toContain('words');
      expect(fields).toContain('soapNote');
    });

    it('extracts generic clinical free-text fields', () => {
      const data = {
        notes: 'Patient instructions...',
        alert: 'Allergy: penicillin',
        content: 'Letter body...',
        encounterId: '123',
      };
      const fields = extractPHIFields(data);
      expect(fields).toContain('notes');
      expect(fields).toContain('alert');
      expect(fields).toContain('content');
      expect(fields).not.toContain('encounterId');
    });

    it('returns empty array for non-objects', () => {
      expect(extractPHIFields(null)).toEqual([]);
      expect(extractPHIFields(undefined)).toEqual([]);
      expect(extractPHIFields('string')).toEqual([]);
      expect(extractPHIFields(123)).toEqual([]);
    });

    it('returns empty array for objects without PHI', () => {
      const data = { encounterId: '123', textLength: 500, wordsCount: 100 };
      expect(extractPHIFields(data)).toEqual([]);
    });
  });

  describe('logMetadata', () => {
    it('converts text to textLength', () => {
      const data = { text: 'Patient said something' };
      const metadata = logMetadata(data);
      expect(metadata).toEqual({ textLength: 22 });
      expect(metadata).not.toHaveProperty('text');
    });

    it('converts words array to wordsCount', () => {
      const data = { words: ['word1', 'word2', 'word3'] };
      const metadata = logMetadata(data);
      expect(metadata).toEqual({ wordsCount: 3 });
      expect(metadata).not.toHaveProperty('words');
    });

    it('converts segments to segmentCount', () => {
      const data = { segments: [{}, {}, {}] };
      const metadata = logMetadata(data);
      expect(metadata).toEqual({ segmentsCount: 3 });
      expect(metadata).not.toHaveProperty('segments');
    });

    it('converts transcript to transcriptLength', () => {
      const data = { transcript: 'Full transcript text here' };
      const metadata = logMetadata(data);
      expect(metadata).toEqual({ transcriptLength: 25 });
      expect(metadata).not.toHaveProperty('transcript');
    });

    it('converts soapNote to length', () => {
      const data = { soapNote: 'S: Patient reports...' };
      const metadata = logMetadata(data);
      expect(metadata).toEqual({ soapNoteLength: 21 });
      expect(metadata).not.toHaveProperty('soapNote');
    });

    it('converts notes / alert / content to length', () => {
      const data = {
        notes: 'Patient instructions...',
        alert: 'Allergy: penicillin',
        content: 'Letter body...',
      };
      const metadata = logMetadata(data);
      expect(metadata).toEqual({
        notesLength: data.notes.length,
        alertLength: data.alert.length,
        contentLength: data.content.length,
      });
      expect(metadata).not.toHaveProperty('notes');
      expect(metadata).not.toHaveProperty('alert');
      expect(metadata).not.toHaveProperty('content');
    });

    it('preserves safe fields', () => {
      const data = {
        encounterId: '123',
        userId: 'usr_456',
        duration: 300,
        status: 'complete',
      };
      const metadata = logMetadata(data);
      expect(metadata).toEqual(data);
    });

    it('handles nested objects', () => {
      const data = {
        encounter: { text: 'Patient conversation', encounterId: '123' },
        metadata: { count: 10 },
      };
      const metadata = logMetadata(data);
      expect(metadata).toEqual({
        encounter: { textLength: 20, encounterId: '123' },
        metadata: { count: 10 },
      });
    });

    it('handles arrays of objects', () => {
      const data = {
        items: [
          { text: 'Item 1', id: '1' },
          { text: 'Item 2', id: '2' },
        ],
      };
      const metadata = logMetadata(data);
      expect(metadata).toEqual({
        items: [
          { textLength: 6, id: '1' },
          { textLength: 6, id: '2' },
        ],
      });
    });

    it('handles non-object inputs', () => {
      expect(logMetadata(null)).toEqual({ type: 'object' });
      expect(logMetadata(undefined)).toEqual({ type: 'undefined' });
      expect(logMetadata('string')).toEqual({ type: 'string' });
      expect(logMetadata(123)).toEqual({ type: 'number' });
    });
  });

  describe('assertPHISafe', () => {
    it('passes for safe log messages', () => {
      expect(() => assertPHISafe({ textLength: 500 })).not.toThrow();
      expect(() => assertPHISafe('Processing transcription')).not.toThrow();
      expect(() =>
        assertPHISafe({ encounterId: '123', wordsCount: 100 }),
      ).not.toThrow();
    });

    it('throws for log messages containing PHI', () => {
      expect(() => assertPHISafe({ text: 'Patient said...' })).toThrow(
        'PHI detected',
      );
      expect(() => assertPHISafe('text: "Patient..."')).toThrow('PHI detected');
    });

    it('includes context in error message', () => {
      try {
        assertPHISafe({ text: 'PHI content' }, 'processTranscript');
        throw new Error('Should have thrown');
      } catch (error) {
        expect(getErrorMessage(error)).toContain('processTranscript');
      }
    });

    it('includes PHI fields in error message for objects', () => {
      try {
        assertPHISafe({ text: '...', words: [] });
        throw new Error('Should have thrown');
      } catch (error) {
        expect(getErrorMessage(error)).toContain(
          'PHI fields found: text, words',
        );
      }
    });

    it('includes log message in error', () => {
      try {
        assertPHISafe({ text: 'secret data' });
        throw new Error('Should have thrown');
      } catch (error) {
        expect(getErrorMessage(error)).toContain('"text"');
      }
    });
  });

  describe('hasPHIFields', () => {
    it('returns true for objects with PHI fields', () => {
      expect(hasPHIFields({ text: '...' })).toBe(true);
      expect(hasPHIFields({ words: [] })).toBe(true);
      expect(hasPHIFields({ soapNote: '...' })).toBe(true);
    });

    it('returns false for objects without PHI fields', () => {
      expect(hasPHIFields({ encounterId: '123' })).toBe(false);
      expect(hasPHIFields({ textLength: 500 })).toBe(false);
      expect(hasPHIFields({ wordsCount: 100 })).toBe(false);
    });

    it('returns false for non-objects', () => {
      expect(hasPHIFields(null)).toBe(false);
      expect(hasPHIFields(undefined)).toBe(false);
      expect(hasPHIFields('string')).toBe(false);
      expect(hasPHIFields(123)).toBe(false);
    });
  });

  describe('auth/PII field names (merged into PHI_FIELD_NAMES)', () => {
    it('flags password, token, secret, apiKey, sessionId', () => {
      expect(hasPHIFields({ password: 'x' })).toBe(true);
      expect(hasPHIFields({ token: 'x' })).toBe(true);
      expect(hasPHIFields({ secret: 'x' })).toBe(true);
      expect(hasPHIFields({ apiKey: 'x' })).toBe(true);
      expect(hasPHIFields({ sessionId: 'x' })).toBe(true);
    });

    it('flags ssn, dob, email, phone, address, creditCard, bankAccount', () => {
      expect(hasPHIFields({ ssn: '123' })).toBe(true);
      expect(hasPHIFields({ dob: '1990-01-01' })).toBe(true);
      expect(hasPHIFields({ email: 'a@b.com' })).toBe(true);
      expect(hasPHIFields({ phone: '555' })).toBe(true);
      expect(hasPHIFields({ address: '1 St' })).toBe(true);
      expect(hasPHIFields({ creditCard: '4111...' })).toBe(true);
      expect(hasPHIFields({ bankAccount: '...' })).toBe(true);
    });

    it('logMetadata strips auth fields to length-only', () => {
      const data = { password: 'hunter2', encounterId: 'e-1' };
      expect(logMetadata(data)).toEqual({
        passwordLength: 7,
        encounterId: 'e-1',
      });
    });
  });

  describe('cycle safety (circular references)', () => {
    it('extractPHIFields does not stack-overflow on self-reference', () => {
      const a: Record<string, unknown> = { text: 'phi' };
      a['self'] = a;
      expect(() => extractPHIFields(a)).not.toThrow();
      expect(extractPHIFields(a)).toContain('text');
    });

    it('extractPHIFields does not stack-overflow on mutual reference', () => {
      const a: Record<string, unknown> = { mrn: '123' };
      const b: Record<string, unknown> = { parent: a };
      a['child'] = b;
      expect(() => extractPHIFields(a)).not.toThrow();
    });

    it('logMetadata does not stack-overflow on self-reference', () => {
      const a: Record<string, unknown> = { text: 'phi', userId: 'u1' };
      a['self'] = a;
      expect(() => logMetadata(a)).not.toThrow();
      const safe = logMetadata(a);
      expect(safe['textLength']).toBe(3);
      expect(safe['userId']).toBe('u1');
    });

    it('detectPHI does not throw on circular non-PHI object', () => {
      const a: Record<string, unknown> = { userId: 'u1' };
      a['self'] = a;
      expect(() => detectPHI(a)).not.toThrow();
      expect(detectPHI(a)).toBe(false);
    });

    it('detectPHI identifies PHI in a circular object via field names', () => {
      const a: Record<string, unknown> = { transcript: 'phi' };
      a['self'] = a;
      expect(detectPHI(a)).toBe(true);
    });

    it('assertPHISafe produces a stable message for circular objects with PHI', () => {
      const a: Record<string, unknown> = { text: 'phi' };
      a['self'] = a;
      expect(() => assertPHISafe(a)).toThrow(/PHI detected/);
    });
  });

  describe('realistic logging payloads', () => {
    describe('rawDataSample leak detection', () => {
      it('detects rawDataSample PHI leak', () => {
        const logMessage = {
          rawDataSample: JSON.stringify({
            text: 'Patient said...',
            words: [],
          }).substring(0, 500),
          textLength: 500,
        };
        expect(detectPHI(logMessage)).toBe(true);
        expect(extractPHIFields(logMessage)).toContain('rawDataSample');
      });

      it('allows PHI-safe alternative', () => {
        const logMessage = { textLength: 500, wordsCount: 100 };
        expect(detectPHI(logMessage)).toBe(false);
        expect(() => assertPHISafe(logMessage)).not.toThrow();
      });
    });

    describe('voiceprint and speaker payloads', () => {
      it('detects voiceprint in webhook payload', () => {
        const logMessage = {
          voiceprint: 'base64_encoded_data',
          speaker: 'Speaker A',
        };
        expect(detectPHI(logMessage)).toBe(true);
      });

      it('allows metadata logging', () => {
        const logMessage = { payloadSize: 1024, speakerCount: 2 };
        expect(detectPHI(logMessage)).toBe(false);
      });
    });

    describe('debug-mode data dumps', () => {
      it('detects debug mode data dumps', () => {
        const debugLog = 'Saving fullData to /tmp/debug.json';
        expect(detectPHI(debugLog)).toBe(true);
      });

      it('allows processing status logs', () => {
        const statusLog = 'Processing 10 segments for encounter abc123';
        expect(detectPHI(statusLog)).toBe(false);
      });
    });
  });
});

/**
 * Regression tests for the S3 filename leak found in the August 2026 security
 * review: `redactS3Url` hid the object path and kept the filename, which is
 * where recording pipelines put patient names, MRNs and dates of birth.
 */
describe('logMetadata — S3 redaction', () => {
  it('drops the filename and keeps only the extension', () => {
    expect(
      logMetadata({
        audioFileKey: 'encounters/123/JaneDoe-MRN9987-dob1975.wav',
      }),
    ).toEqual({ audioFileKey: '[REDACTED].wav' });
  });

  it('does not leak identifiers from the filename', () => {
    const out = JSON.stringify(
      logMetadata({ audioFileUrl: 's3://b/e/JohnDoe-MRN4471-1980-05-02.wav' }),
    );
    expect(out).not.toContain('JohnDoe');
    expect(out).not.toContain('MRN4471');
    expect(out).not.toContain('1980-05-02');
  });

  it('drops presigned query parameters', () => {
    const out = JSON.stringify(
      logMetadata({
        recordingUrl:
          'https://b.s3.amazonaws.com/e/1/a.wav?X-Amz-Signature=deadbeef',
      }),
    );
    expect(out).not.toContain('deadbeef');
    expect(out).toContain('[REDACTED].wav');
  });

  it('returns a bare marker when there is no extension', () => {
    expect(logMetadata({ inputKey: 'encounters/123/JaneDoe-MRN9987' })).toEqual(
      { inputKey: '[REDACTED]' },
    );
  });

  it('treats a dotfile as having no extension', () => {
    expect(logMetadata({ inputKey: 'some/path/.env' })).toEqual({
      inputKey: '[REDACTED]',
    });
  });

  it('rejects an over-long or non-alphanumeric extension', () => {
    // A crafted key could otherwise smuggle data through as an "extension".
    expect(
      logMetadata({ outputKey: 'p/a.JaneDoeMRN9987DobNineteenSeventyFive' }),
    ).toEqual({ outputKey: '[REDACTED]' });
    expect(logMetadata({ outputKey: 'p/a.wav-MRN9987' })).toEqual({
      outputKey: '[REDACTED]',
    });
  });

  it('still applies to every S3 field name', () => {
    for (const field of [
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
    ]) {
      expect(logMetadata({ [field]: 'a/b/Secret-Name.ogg' })).toEqual({
        [field]: '[REDACTED].ogg',
      });
    }
  });
});

describe('name matching is case- and separator-insensitive', () => {
  // The stdout walk matches names this way. When the sink and the detector
  // used exact matching instead, stdout was protected and the sink was not —
  // the same drift this list was made the single source of truth to prevent,
  // with the channels swapped.
  const spellings = ['PatientId', 'patient_id', 'PATIENT-ID', 'patientId'];

  it.each(spellings)('extractPHIFields finds %s', (name) => {
    expect(extractPHIFields({ [name]: 'P-1' })).toEqual([name]);
  });

  it.each(spellings)('hasPHIFields flags %s', (name) => {
    expect(hasPHIFields({ [name]: 'P-1' })).toBe(true);
  });

  it.each(spellings)('logMetadata strips %s from the sink payload', (name) => {
    const out = logMetadata({ [name]: 'P-1' });
    expect(out[name]).toBeUndefined();
    expect(out[`${name}Length`]).toBe(3);
  });

  it('strips a PascalCase clinical field the sink used to forward', () => {
    const out = logMetadata({ Transcript: 'Patient reports chest pain.' });
    expect(out['Transcript']).toBeUndefined();
    expect(out['TranscriptLength']).toBe(27);
  });

  it('redacts an S3 key named in a different style', () => {
    expect(logMetadata({ AudioFileKey: 's3://b/e/1/audio.wav' })).toEqual({
      AudioFileKey: '[REDACTED].wav',
    });
  });

  it('leaves an unrelated name alone', () => {
    expect(logMetadata({ encounterId: 'E-1' })).toEqual({ encounterId: 'E-1' });
    expect(hasPHIFields({ encounterId: 'E-1' })).toBe(false);
  });
});

describe('redactS3Url keeps only a recognized extension', () => {
  // "Short and alphanumeric" does not separate a format hint from an
  // identifier: recording keys embed exactly the values this function removes.
  it.each([
    ['s3://b/encounters/123/JaneDoe.MRN9987', '[REDACTED]'],
    ['s3://b/e/recording.20250817', '[REDACTED]'],
    ['s3://b/e/note.Smith', '[REDACTED]'],
    ['s3://b/e/audio.wav', '[REDACTED].wav'],
    ['s3://b/e/audio.OGG', '[REDACTED].ogg'],
    ['s3://b/e/x.wav?X-Amz-Signature=abc', '[REDACTED].wav'],
  ])('%s -> %s', (key, expected) => {
    expect(logMetadata({ audioFileKey: key })).toEqual({
      audioFileKey: expected,
    });
  });
});

# @loomantix/logging

Structured logging primitives for NestJS backends. Wraps
[pino](https://getpino.io) with:

- **NestJS `LoggerService` implementation** — drop into `NestFactory.create({ logger })`
  or inject via `createLogger(context)`.
- **OpenTelemetry trace context** — every log line gets `traceId` / `spanId` / `traceFlags`
  from the active OTel context, so logs correlate with traces in Grafana / Tempo.
- **PHI-safe redaction + detector** — every name in `PHI_FIELD_NAMES` is
  censored at **any depth** on the way to stdout, and request URLs have their
  sensitive query parameters stripped; `detectPHI` / `assertPHISafe` /
  `logMetadata` catch leaks in test or pre-emit.
- **Pluggable event sink** — register a callback via `setEventSink` to forward
  entries carrying an `event` field to a queue / audit store. PHI stripped
  before forwarding.
- **Pretty logs in dev, JSON in prod** — controlled by `NODE_ENV` + optional
  `LOG_FORMAT=json|pretty` override.

## Install

```bash
pnpm add @loomantix/logging
```

Published with [npm provenance](https://docs.npmjs.com/generating-provenance-statements) under Apache 2.0.

Peer deps (consumer app owns the install): `@nestjs/common`,
`@opentelemetry/api`, `pino`, `pino-pretty`, `reflect-metadata`, `rxjs`.

## Usage

### NestJS bootstrap

```ts
import { NestFactory } from '@nestjs/core';
import { PinoLoggerService } from '@loomantix/logging';

const app = await NestFactory.create(AppModule, {
  logger: new PinoLoggerService('Bootstrap'),
});
```

### Per-class logger

```ts
import { createLogger } from '@loomantix/logging';

export class MyService {
  private readonly logger = createLogger(MyService.name);

  someMethod() {
    this.logger.log('Processing request', { requestId: '123' });
    // → {"level":30,"time":"...","msg":"Processing request",
    //     "context":"MyService","requestId":"123",
    //     "traceId":"...","spanId":"..."}
  }
}
```

### Service name

Resolution order (first non-empty wins):

1. `serviceName` argument to `createLogger(context, serviceName)` / `new PinoLoggerService(context, serviceName)`
2. `SERVICE_NAME` environment variable
3. `'unknown'` (loud default — set one of the above in deployment)

### Event sink (for audit forwarding / external sinks)

```ts
import { setEventSink } from '@loomantix/logging';

setEventSink((entry) => {
  if (entry['event'] === 'encounter_created') {
    auditQueue.publish(entry);
  }
});
```

Only entries with an `event` field are forwarded. Before the callback fires,
values at any of the known PHI/PII field names (see `phi-detector.ts`
`PHI_FIELD_NAMES`) are stripped or reduced to metadata (lengths, counts,
sentinels), and the accompanying `msg` string is dropped if it matches one
of the PHI regex patterns. This is a best-effort defense — custom field
names outside the list are passed through unmodified, so application code
should still avoid logging sensitive values under novel keys.

Sink errors are caught — they never affect the logging pipeline.

### What gets redacted on the stdout path

`createPinoConfig` applies two layers:

1. **`formatters.log`** walks each entry and replaces the value of any field
   named in `REDACTED_FIELD_NAMES` with `[REDACTED]`, **at every depth** —
   including inside arrays and inside errors. That set is built from
   `PHI_FIELD_NAMES` plus auth headers and query-string signing parameters.
   Names are matched ignoring case and `_`/`-`, so one entry covers
   `patientId`, `PatientId` and `patient_id`.
2. **`redact.paths`** is derived from the same set and covers the root and
   depth 1. It is a backstop for consumers who spread this config and replace
   `formatters`, and it is the only layer that reaches `logger.child()`
   bindings (see below).

Name matching is shared with the event sink and `assertPHISafe`, so all three
enforcement points agree on what counts as a sensitive name — the list and the
match rule are both single-sourced.

A value that defines `toJSON` is judged by **what that method returns**, since
that projection is what `JSON.stringify` writes. An ORM document or a
`class-transformer` DTO that stores `#ssn` privately and exposes `ssn` is
therefore censored on the exposed name.

The `req` / `res` / `err` keys are walked **inside their serializers** rather
than by `formatters.log`. pino runs `formatters.log` _before_ its serializers,
so the walk would otherwise receive your live framework objects instead of the
plain shapes the serializers produce — and rebuilding a live object keeps only
its own enumerable properties, dropping the prototype accessors those
serializers read.

Two consequences worth knowing before you upgrade:

- A field whose **name** is sensitive is censored **including its subtree**.
  `{ patient: { id, nickname } }` becomes `patient: '[REDACTED]'`, matching
  what the event sink already did. Log correlation identifiers under a name
  that is not on the list (`encounterId`, `recordRef`) rather than under
  `patient` / `content` / `text` / `notes`.
- `req.url` and `referer` keep their path but have sensitive query-parameter
  **values** replaced, so `/api/e?token=abc&page=2` logs as
  `/api/e?token=[REDACTED]&page=2`. Credentials in a `user:pass@` prefix are
  censored too.

Redaction never mutates the object you logged, and an unchanged payload is
returned by reference, so the clean path costs a walk and no allocation. It
fails closed in three places: past `MAX_REDACT_DEPTH`, past `MAX_REDACT_NODES`
visited nodes, and on any property whose getter throws.

#### Child bindings are only covered to depth 1

pino renders `logger.child()` bindings once at `child()` time and resets any
custom `formatters.bindings` to its own before doing so, so no config-level
hook can walk them — `redact.paths` is the only layer and it stops at depth 1.
If you bind untrusted data to a child logger, walk it yourself first with the
same pass:

```typescript
import { redactTree } from '@loomantix/logging';

const scoped = logger.child(redactTree(bindings) as pino.Bindings);
```

This is still a best-effort, name-based defense: a sensitive value logged
under a novel key, or interpolated into the `msg` string, is passed through.
Use `assertPHISafe` in tests to catch that.

### PHI safety in tests

```ts
import { assertPHISafe } from '@loomantix/logging';

it('does not leak transcript text', () => {
  const captured = captureLogs(() => service.process(payload));
  expect(() => assertPHISafe(captured, 'process')).not.toThrow();
});
```

`assertPHISafe` throws if the message object contains any known PHI field
(e.g. `text`, `transcript`, `soapNote`, `patientId`, S3 URLs, …) or matches
one of the PHI regex patterns.

## Environment variables

- `LOG_LEVEL` — pino log level (default: `debug` in dev, `info` in prod)
- `LOG_FORMAT` — `json` or `pretty`; overrides auto-detection
- `NODE_ENV` — `development` / `staging` / `production` / `test`
- `SERVICE_NAME` — service name for structured logs
- `APP_VERSION` / `GIT_COMMIT` — included in every log's `base` fields

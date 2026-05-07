# @loomantix/logging

Structured logging primitives for NestJS backends. Wraps
[pino](https://getpino.io) with:

- **NestJS `LoggerService` implementation** — drop into `NestFactory.create({ logger })`
  or inject via `createLogger(context)`.
- **OpenTelemetry trace context** — every log line gets `traceId` / `spanId` / `traceFlags`
  from the active OTel context, so logs correlate with traces in Grafana / Tempo.
- **PHI-safe redaction + detector** — pino `redact.paths` covers ~30 common
  auth/PII/PHI fields; `detectPHI` / `assertPHISafe` / `logMetadata` catch
  leaks in test or pre-emit.
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

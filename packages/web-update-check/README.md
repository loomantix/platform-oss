# `@loomantix/web-update-check`

Framework-neutral detection for browser tabs that remain open across frontend
deployments. The package compares the opaque build identifier embedded in the
running JavaScript bundle with a separately fetched deployed manifest.

It provides:

- `createVersionUpdateMonitor()` for browser lifecycle checks and observable
  immutable state; and
- `webUpdateManifestPlugin()` from `@loomantix/web-update-check/vite` to embed
  `import.meta.env.VITE_APP_VERSION` and emit the matching `version.json`.

The package deliberately does not render UI or reload the page. Consumers own
their framework adapter, banner copy and styling, unsaved-work policy,
service-worker cleanup, and navigation behavior.

## Install

```bash
pnpm add @loomantix/web-update-check
```

## Build integration

Supply a non-empty identifier unique to the exact frontend artifact. A package
version or backend version is insufficient when frontend-only rebuilds and
deployments are possible.

The optional `/vite` entry point supports Vite 7. The runtime monitor itself
has no Vite dependency.

```typescript
import { defineConfig } from 'vite';
import { webUpdateManifestPlugin } from '@loomantix/web-update-check/vite';

const buildId = process.env['WEB_BUILD_ID'];
if (!buildId) throw new Error('WEB_BUILD_ID is required');

export default defineConfig({
  plugins: [webUpdateManifestPlugin({ version: buildId })],
});
```

The build emits:

```json
{ "version": "the-opaque-build-id" }
```

`builtAt` may be supplied explicitly to the plugin. It is omitted by default so
the plugin does not make otherwise reproducible builds time-dependent.

## Runtime integration

```typescript
import { createVersionUpdateMonitor } from '@loomantix/web-update-check';

export const versionMonitor = createVersionUpdateMonitor({
  currentVersion: import.meta.env.VITE_APP_VERSION,
  manifestUrl: `${import.meta.env.BASE_URL}version.json`,
});
```

Use `subscribe()` and `getSnapshot()` from a React, Preact, Vue, or other
framework adapter. Acquire lifecycle when the relevant app shell mounts:

```typescript
const release = versionMonitor.start();
// Later, when that owner unmounts:
release();
```

`start()` is lease-based: polling and browser listeners stay active until the
last caller releases its lease. `checkNow()` can be used independently for an
explicit check; concurrent calls share the in-flight request, and it resolves
whether or not the check succeeded — `onError` is the only failure signal.

## Error and data contract

`onError` receives `request`, `response`, `parse`, `manifest`, and `listener`
failures. Treat its payload as untrusted: `cause` on a `listener` error is
whatever a subscriber threw and may contain application text, so sanitize it
before it reaches logging or an error tracker. `latestVersion` comes from the
deployed manifest — render it as text, never as HTML.

In development the Vite plugin serves the manifest from the dev server, so a
monitor pointed at the same path works under `vite dev` as well as a build.

## Hosting contract

The library can make a no-cache request, but it cannot configure the origin or
edge that serves it. Consumers must ensure:

- `version.json` is never included in a service-worker precache;
- `version.json` is served with `Cache-Control: no-store`;
- HTML navigations revalidate so a refresh receives the current asset graph;
- deployments publish hashed assets before the manifest, or publish the entire
  frontend atomically; and
- reload and service-worker eviction are scoped to the consumer's deployment.

Version identifiers are opaque. The monitor uses inequality rather than semver
ordering, so rollback to a different artifact correctly asks an open tab to
refresh.

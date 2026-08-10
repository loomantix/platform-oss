import type { Plugin } from 'vite';

import { assertVersion, type VersionManifest } from './version';

/** Options for the Vite build-version manifest plugin. */
export interface WebUpdateManifestPluginOptions {
  /** Opaque, artifact-unique identifier embedded in the bundle and manifest. */
  readonly version: string;
  /** Output manifest path relative to the Vite build directory. */
  readonly fileName?: string;
  /** Optional reproducible build timestamp to include in the manifest. */
  readonly builtAt?: string;
}

/**
 * Embed an artifact identifier as `import.meta.env.VITE_APP_VERSION` and emit
 * a matching deployed manifest for runtime update detection.
 */
export function webUpdateManifestPlugin(
  options: WebUpdateManifestPluginOptions,
): Plugin {
  assertVersion(options.version, 'version');
  const version = options.version;
  const builtAt = options.builtAt;
  const fileName = options.fileName ?? 'version.json';
  assertFileName(fileName);

  const manifest: VersionManifest =
    builtAt === undefined ? { version } : { version, builtAt };
  const source = JSON.stringify(manifest);

  return {
    name: 'loomantix-web-update-manifest',
    config() {
      return {
        define: { 'import.meta.env.VITE_APP_VERSION': defineLiteral(version) },
      };
    },
    configureServer(server) {
      // Without this the manifest exists only after a build, so a monitor
      // running under `vite dev` 404s on every poll.
      const devPath = devManifestPath(server.config.base, fileName);
      server.middlewares.use((req, res, next) => {
        if (req.url === undefined || req.url.split('?')[0] !== devPath) {
          next();
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(source);
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName, source });
    },
  };
}

function devManifestPath(base: string, fileName: string): string {
  const basePath = /^https?:\/\//.test(base) ? new URL(base).pathname : base;
  const normalizedBase = basePath === './' ? '/' : basePath;
  return `${normalizedBase.endsWith('/') ? normalizedBase : `${normalizedBase}/`}${fileName}`;
}

/**
 * Serialize the version for `define`. `JSON.stringify` alone leaves `<` intact,
 * which breaks out of an inlined `<script>` in bundles served inside HTML.
 */
function defineLiteral(value: string): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function assertFileName(value: string): void {
  if (
    value.length === 0 ||
    value.startsWith('/') ||
    value.includes('\\') ||
    /^[A-Za-z]:/.test(value) ||
    value
      .split('/')
      .some(
        (segment) =>
          segment.length === 0 || segment === '.' || segment === '..',
      )
  ) {
    throw new TypeError(
      'fileName must be a safe path relative to the build directory',
    );
  }
}

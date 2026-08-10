import type { Plugin } from 'vite';

import { assertVersion } from './version';

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

  return {
    name: 'loomantix-web-update-manifest',
    config() {
      return {
        define: { 'import.meta.env.VITE_APP_VERSION': JSON.stringify(version) },
      };
    },
    generateBundle() {
      const manifest =
        builtAt === undefined ? { version } : { version, builtAt };
      this.emitFile({
        type: 'asset',
        fileName,
        source: JSON.stringify(manifest),
      });
    },
  };
}

function assertFileName(value: string): void {
  if (
    value.length === 0 ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    throw new TypeError(
      'fileName must be a safe path relative to the build directory',
    );
  }
}

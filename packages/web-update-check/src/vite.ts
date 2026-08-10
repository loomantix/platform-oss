import type { Plugin } from 'vite';

const MAX_VERSION_LENGTH = 256;

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
  assertVersion(options.version);
  const fileName = options.fileName ?? 'version.json';
  assertFileName(fileName);

  return {
    name: 'loomantix-web-update-manifest',
    apply: 'build',
    config() {
      return {
        define: {
          'import.meta.env.VITE_APP_VERSION': JSON.stringify(options.version),
        },
      };
    },
    generateBundle() {
      const manifest =
        options.builtAt === undefined
          ? { version: options.version }
          : { version: options.version, builtAt: options.builtAt };
      this.emitFile({
        type: 'asset',
        fileName,
        source: JSON.stringify(manifest),
      });
    },
  };
}

function assertVersion(value: string): void {
  if (
    value.length === 0 ||
    value.length > MAX_VERSION_LENGTH ||
    value.trim() !== value
  ) {
    throw new TypeError(
      `version must be a non-empty string no longer than ${MAX_VERSION_LENGTH} characters`,
    );
  }
}

function assertFileName(value: string): void {
  if (
    value.length === 0 ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.split('/').includes('..')
  ) {
    throw new TypeError(
      'fileName must be a safe path relative to the build directory',
    );
  }
}

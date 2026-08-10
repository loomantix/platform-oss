import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { build, resolveConfig } from 'vite';
import { webUpdateManifestPlugin } from './vite';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('webUpdateManifestPlugin', () => {
  it('emits the same version that it injects into the frontend bundle', async () => {
    const root = await temporaryDirectory();
    await writeFile(
      path.join(root, 'index.html'),
      '<script type="module" src="/src.ts"></script>',
    );
    await writeFile(
      path.join(root, 'src.ts'),
      'document.body.dataset.version = import.meta.env.VITE_APP_VERSION;',
    );

    await build({
      root,
      logLevel: 'silent',
      plugins: [webUpdateManifestPlugin({ version: 'artifact-abc123' })],
      build: { outDir: 'dist' },
    });

    const manifest = JSON.parse(
      await readFile(path.join(root, 'dist/version.json'), 'utf8'),
    ) as unknown;
    expect(manifest).toEqual({ version: 'artifact-abc123' });
    const builtFiles = await readFile(
      path.join(root, 'dist/index.html'),
      'utf8',
    );
    const scriptPath = /src="([^"]+\.js)"/.exec(builtFiles)?.[1];
    expect(scriptPath).toBeDefined();
    const bundle = await readFile(
      path.join(root, 'dist', scriptPath?.replace(/^\//, '') ?? ''),
      'utf8',
    );
    expect(bundle).toContain('artifact-abc123');
  });

  it('includes builtAt only when the caller supplies it', async () => {
    const plugin = webUpdateManifestPlugin({
      version: 'artifact-v1',
      builtAt: '2026-08-10T00:00:00.000Z',
    });
    const emitted: unknown[] = [];
    const generateBundle = plugin.generateBundle;
    expect(typeof generateBundle).toBe('function');
    if (typeof generateBundle !== 'function') return;

    await generateBundle.call(
      {
        emitFile: (asset: unknown) => (emitted.push(asset), 'asset-id'),
      } as never,
      {} as never,
      {} as never,
      false,
    );

    expect(emitted).toContainEqual(
      expect.objectContaining({
        fileName: 'version.json',
        source: JSON.stringify({
          version: 'artifact-v1',
          builtAt: '2026-08-10T00:00:00.000Z',
        }),
      }),
    );
  });

  it('defines the running version during development', async () => {
    const config = await resolveConfig(
      {
        configFile: false,
        logLevel: 'silent',
        plugins: [webUpdateManifestPlugin({ version: 'artifact-v1' })],
      },
      'serve',
    );

    expect(config.define?.['import.meta.env.VITE_APP_VERSION']).toBe(
      JSON.stringify('artifact-v1'),
    );
  });

  it('snapshots manifest values at plugin construction', async () => {
    const options = {
      version: 'artifact-v1',
      builtAt: '2026-08-10T00:00:00.000Z',
    };
    const plugin = webUpdateManifestPlugin(options);
    options.version = 'artifact-v2';
    options.builtAt = '2026-08-11T00:00:00.000Z';
    const emitted: unknown[] = [];
    const generateBundle = plugin.generateBundle;
    expect(typeof generateBundle).toBe('function');
    if (typeof generateBundle !== 'function') return;

    await generateBundle.call(
      {
        emitFile: (asset: unknown) => (emitted.push(asset), 'asset-id'),
      } as never,
      {} as never,
      {} as never,
      false,
    );

    expect(emitted).toContainEqual(
      expect.objectContaining({
        source: JSON.stringify({
          version: 'artifact-v1',
          builtAt: '2026-08-10T00:00:00.000Z',
        }),
      }),
    );
  });

  it('rejects invalid versions and unsafe output paths', () => {
    expect(() => webUpdateManifestPlugin({ version: '' })).toThrow(/version/);
    expect(() =>
      webUpdateManifestPlugin({ version: 'v1', fileName: '../version.json' }),
    ).toThrow(/fileName/);
    expect(() =>
      webUpdateManifestPlugin({ version: 'v1', fileName: '/version.json' }),
    ).toThrow(/fileName/);
    expect(() =>
      webUpdateManifestPlugin({ version: 'v1', fileName: './version.json' }),
    ).toThrow(/fileName/);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'web-update-check-'));
  temporaryDirectories.push(directory);
  return directory;
}

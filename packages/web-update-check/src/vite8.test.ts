import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  build,
  createServer,
  type InlineConfig,
  type ViteDevServer,
} from 'vite8';
import { webUpdateManifestPlugin } from './vite';

const temporaryDirectories: string[] = [];
const developmentServers: ViteDevServer[] = [];

afterEach(async () => {
  await Promise.all(
    developmentServers.splice(0).map((server) => server.close()),
  );
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('webUpdateManifestPlugin with Vite 8', () => {
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

    await build(
      vite8Config({
        root,
        logLevel: 'silent',
        plugins: [webUpdateManifestPlugin({ version: 'vite8-artifact' })],
        build: { outDir: 'dist' },
      }),
    );

    const manifest = JSON.parse(
      await readFile(path.join(root, 'dist/version.json'), 'utf8'),
    ) as unknown;
    expect(manifest).toEqual({ version: 'vite8-artifact' });
    const html = await readFile(path.join(root, 'dist/index.html'), 'utf8');
    const scriptPath = /src="([^"]+\.js)"/.exec(html)?.[1];
    expect(scriptPath).toBeDefined();
    const bundle = await readFile(
      path.join(root, 'dist', scriptPath?.replace(/^\//, '') ?? ''),
      'utf8',
    );
    expect(bundle).toContain('vite8-artifact');
  });

  it('serves the manifest at the configured path during development', async () => {
    const root = await temporaryDirectory();
    await writeFile(path.join(root, 'index.html'), '<main>test</main>');
    const server = await createServer(
      vite8Config({
        root,
        base: '/app/',
        configFile: false,
        logLevel: 'silent',
        plugins: [
          webUpdateManifestPlugin({
            version: 'vite8-artifact',
            fileName: 'meta/version.json',
          }),
        ],
        server: { host: '127.0.0.1', port: 0 },
      }),
    );
    developmentServers.push(server);
    await server.listen();
    const address = server.httpServer?.address();
    if (
      address === null ||
      typeof address === 'string' ||
      address === undefined
    ) {
      throw new Error('Vite 8 development server did not expose a TCP port');
    }

    const response = await fetch(
      `http://127.0.0.1:${address.port}/app/meta/version.json`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ version: 'vite8-artifact' });
  });
});

function vite8Config(config: InlineConfig): InlineConfig {
  return config;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'web-update-check-v8-'));
  temporaryDirectories.push(directory);
  return directory;
}

import { defineConfig } from 'tsup';
import pkg from './package.json' with { type: 'json' };

// Mirrors mobile-crypto: `main`/`exports` point at `src/index.ts` for
// `workspace:*` consumers, `publishConfig` overrides to `dist/*` at
// publish time. Externals are derived from peerDependencies (none today —
// WebCrypto is native to every browser runtime we target — but declared
// here so the pattern matches mobile-crypto if we ever add a peer).
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2022',
  external: Object.keys(pkg.peerDependencies ?? {}),
});

import { defineConfig } from 'tsup';
import pkg from './package.json' with { type: 'json' };

// Build config for the published tarball. During workspace development,
// `main`/`exports` in package.json point at `src/index.ts`, so in-repo
// consumers pick up TS source via pnpm's `workspace:*` symlink without
// a build. At publish time, `publishConfig` in package.json overrides
// those fields to point at `dist/*`, which is what this config produces.
//
// Externals are derived from `peerDependencies` so adding a new native
// peer in package.json is enough — no need to touch this file.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2022',
  external: Object.keys(pkg.peerDependencies ?? {}),
});

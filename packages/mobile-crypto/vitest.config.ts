import { defineConfig } from 'vitest/config';

// Node environment — the crypto layer is framework-neutral and runs
// against node:crypto mocks of react-native-quick-crypto in tests.
export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});

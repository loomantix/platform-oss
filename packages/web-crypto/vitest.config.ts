import { defineConfig } from 'vitest/config';

// happy-dom exposes crypto.subtle (real WebCrypto via node:crypto) but
// does NOT ship an IndexedDB implementation, so we layer fake-indexeddb
// on top via a setup file. fake-indexeddb supports structured cloning of
// CryptoKey — which real browsers also do — which is what lets us store
// the non-extractable AES-GCM key object directly in the keys store.
export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
    setupFiles: ['./src/test-setup.ts'],
  },
});

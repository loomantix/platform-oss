// Auto-installs fake-indexeddb shims (indexedDB, IDBKeyRange, etc.) onto
// globalThis. happy-dom already provides crypto.subtle so the combination
// gives us both halves of the real browser surface this package touches.
// fake-indexeddb's structured-clone supports CryptoKey, matching real
// browser behavior — that's what lets us store the key object directly.
import 'fake-indexeddb/auto';

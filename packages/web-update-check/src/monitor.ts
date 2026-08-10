import { assertVersion, isValidVersion } from './version';

const DEFAULT_MANIFEST_URL = '/version.json';
const DEFAULT_POLL_INTERVAL_MS = 5 * 60_000;
const MAX_TIMER_INTERVAL_MS = 2_147_483_647;

interface VersionManifest {
  readonly version: string;
}

/** Immutable state exposed by a version update monitor. */
export interface VersionUpdateSnapshot {
  /** Opaque identifier embedded in the JavaScript bundle currently running. */
  readonly currentVersion: string;
  /** Opaque identifier most recently read from the deployed manifest. */
  readonly latestVersion: string | null;
  /** Whether the deployed artifact differs from the running bundle. */
  readonly updateAvailable: boolean;
  /** Whether the current deployed update has been dismissed. */
  readonly dismissed: boolean;
  /** Whether an update notification should currently be presented. */
  readonly shouldNotify: boolean;
}

/** Configuration for a framework-neutral browser version monitor. */
export interface VersionUpdateMonitorOptions {
  /** Opaque identifier embedded in the running frontend artifact. */
  readonly currentVersion: string;
  /** URL of the deployed version manifest. Defaults to `/version.json`. */
  readonly manifestUrl?: string;
  /** Steady-state polling interval. Defaults to five minutes. */
  readonly pollIntervalMs?: number;
  /** Receives failed checks and subscriber errors without changing state. */
  readonly onError?: (error: VersionUpdateMonitorError) => void;
  /** Fetch implementation, primarily for non-browser runtimes and tests. */
  readonly fetch?: typeof globalThis.fetch;
  /** Document lifecycle source. Defaults to the global document when present. */
  readonly document?: Document | null;
  /** Window lifecycle source. Defaults to the global window when present. */
  readonly window?: Window | null;
}

/** A recoverable monitor failure reported through the optional error callback. */
export type VersionUpdateMonitorError =
  | { readonly type: 'request'; readonly cause: unknown }
  | { readonly type: 'response'; readonly status: number }
  | { readonly type: 'manifest' }
  | { readonly type: 'listener'; readonly cause: unknown };

/** Framework-neutral monitor for detecting a deployed frontend update. */
export interface VersionUpdateMonitor {
  /** Return the current immutable snapshot. */
  getSnapshot(): VersionUpdateSnapshot;
  /** Subscribe to snapshot changes. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /**
   * Acquire monitor lifecycle. The first lease starts polling and browser
   * listeners; releasing the final lease stops them and aborts pending work.
   */
  start(): () => void;
  /** Stop all lifecycle leases and abort pending work. */
  stop(): void;
  /** Trigger an immediate manifest check. */
  checkNow(): Promise<void>;
  /** Dismiss the currently detected deployed version. */
  dismiss(): void;
}

/** Create a browser update monitor without binding it to a UI framework. */
export function createVersionUpdateMonitor(
  options: VersionUpdateMonitorOptions,
): VersionUpdateMonitor {
  assertVersion(options.currentVersion, 'currentVersion');
  const currentVersion = options.currentVersion;
  const manifestUrl = options.manifestUrl ?? DEFAULT_MANIFEST_URL;
  if (manifestUrl.length === 0) {
    throw new TypeError('manifestUrl must not be empty');
  }
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  if (
    !Number.isInteger(pollIntervalMs) ||
    pollIntervalMs <= 0 ||
    pollIntervalMs > MAX_TIMER_INTERVAL_MS
  ) {
    throw new TypeError(
      `pollIntervalMs must be a positive integer no greater than ${MAX_TIMER_INTERVAL_MS}`,
    );
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('A fetch implementation is required');
  }
  const documentRef =
    options.document === undefined
      ? typeof document === 'undefined'
        ? null
        : document
      : options.document;
  const windowRef =
    options.window === undefined
      ? typeof window === 'undefined'
        ? null
        : window
      : options.window;

  let latestVersion: string | null = null;
  let dismissedVersion: string | null = null;
  let snapshot = buildSnapshot(currentVersion, latestVersion, dismissedVersion);
  const listeners = new Set<() => void>();
  const leases = new Set<symbol>();
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let inFlightController: AbortController | null = null;
  const onError = options.onError;

  const reportError = (error: VersionUpdateMonitorError): void => {
    try {
      onError?.(error);
    } catch {
      // Error reporting must not break polling or other subscribers.
    }
  };

  const publish = (): void => {
    const next = buildSnapshot(currentVersion, latestVersion, dismissedVersion);
    if (snapshotsEqual(snapshot, next)) return;
    snapshot = next;
    for (const listener of listeners) {
      try {
        listener();
      } catch (cause) {
        reportError({ type: 'listener', cause });
      }
    }
  };

  const checkNow = async (): Promise<void> => {
    inFlightController?.abort();
    const controller = new AbortController();
    inFlightController = controller;

    try {
      const response = await fetchImpl(cacheBustedUrl(manifestUrl), {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!response.ok) {
        reportError({ type: 'response', status: response.status });
        return;
      }
      const manifest: unknown = await response.json();
      if (controller.signal.aborted) return;
      if (!isVersionManifest(manifest)) {
        reportError({ type: 'manifest' });
        return;
      }
      latestVersion = manifest.version;
      publish();
    } catch (cause) {
      // Deploys and tab resumes routinely race network availability. A failed
      // check preserves the last trustworthy state and retries on the next
      // lifecycle event or interval.
      if (!controller.signal.aborted) {
        reportError({ type: 'request', cause });
      }
    } finally {
      if (inFlightController === controller) inFlightController = null;
    }
  };

  const onVisibilityChange = (): void => {
    if (documentRef?.visibilityState === 'visible') void checkNow();
  };
  const onPageShow = (event: PageTransitionEvent): void => {
    if (event.persisted) void checkNow();
  };

  const beginLifecycle = (): void => {
    void checkNow();
    intervalId = setInterval(() => void checkNow(), pollIntervalMs);
    documentRef?.addEventListener('visibilitychange', onVisibilityChange);
    windowRef?.addEventListener('pageshow', onPageShow);
  };

  const endLifecycle = (): void => {
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
    documentRef?.removeEventListener('visibilitychange', onVisibilityChange);
    windowRef?.removeEventListener('pageshow', onPageShow);
    inFlightController?.abort();
    inFlightController = null;
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start() {
      const lease = Symbol('version-update-monitor-lease');
      leases.add(lease);
      if (leases.size === 1) beginLifecycle();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        leases.delete(lease);
        if (leases.size === 0) endLifecycle();
      };
    },
    stop() {
      leases.clear();
      endLifecycle();
    },
    checkNow,
    dismiss() {
      if (!snapshot.updateAvailable || latestVersion === null) return;
      dismissedVersion = latestVersion;
      publish();
    },
  };
}

function buildSnapshot(
  currentVersion: string,
  latestVersion: string | null,
  dismissedVersion: string | null,
): VersionUpdateSnapshot {
  const updateAvailable =
    latestVersion !== null && latestVersion !== currentVersion;
  const dismissed = updateAvailable && dismissedVersion === latestVersion;
  return Object.freeze({
    currentVersion,
    latestVersion,
    updateAvailable,
    dismissed,
    shouldNotify: updateAvailable && !dismissed,
  });
}

function snapshotsEqual(
  left: VersionUpdateSnapshot,
  right: VersionUpdateSnapshot,
): boolean {
  return (
    left.currentVersion === right.currentVersion &&
    left.latestVersion === right.latestVersion &&
    left.updateAvailable === right.updateAvailable &&
    left.dismissed === right.dismissed &&
    left.shouldNotify === right.shouldNotify
  );
}

function cacheBustedUrl(manifestUrl: string): string {
  const hashIndex = manifestUrl.indexOf('#');
  const beforeHash =
    hashIndex === -1 ? manifestUrl : manifestUrl.slice(0, hashIndex);
  const hash = hashIndex === -1 ? '' : manifestUrl.slice(hashIndex);
  const separator = beforeHash.includes('?') ? '&' : '?';
  return `${beforeHash}${separator}updateCheck=${Date.now()}${hash}`;
}

function isVersionManifest(value: unknown): value is VersionManifest {
  if (typeof value !== 'object' || value === null) return false;
  const version = Reflect.get(value, 'version');
  return isValidVersion(version);
}

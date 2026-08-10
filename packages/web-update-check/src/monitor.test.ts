import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVersionUpdateMonitor } from './monitor';

const originalVisibilityState = Object.getOwnPropertyDescriptor(
  Document.prototype,
  'visibilityState',
);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, 'visibilityState');
  if (originalVisibilityState !== undefined) {
    Object.defineProperty(
      Document.prototype,
      'visibilityState',
      originalVisibilityState,
    );
  }
});

function setVisibilityState(value: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value,
  });
}

describe('createVersionUpdateMonitor', () => {
  it('compares the first manifest response with the running bundle', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ version: 'deployed-v2' }));
    const monitor = createVersionUpdateMonitor({
      currentVersion: 'running-v1',
      fetch: fetchMock,
    });

    await monitor.checkNow();

    expect(monitor.getSnapshot()).toEqual({
      currentVersion: 'running-v1',
      latestVersion: 'deployed-v2',
      updateAvailable: true,
      dismissed: false,
      shouldNotify: true,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/^\/version\.json\?updateCheck=\d+$/),
      expect.objectContaining({ cache: 'no-store' }),
    );
  });

  it('does not notify when the manifest matches the running bundle', async () => {
    const monitor = createVersionUpdateMonitor({
      currentVersion: 'same-version',
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(jsonResponse({ version: 'same-version' })),
    });

    await monitor.checkNow();

    expect(monitor.getSnapshot().updateAvailable).toBe(false);
    expect(monitor.getSnapshot().shouldNotify).toBe(false);
  });

  it('dismisses one deployed version and not the next one', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ version: 'deployed-v2' }))
      .mockResolvedValueOnce(jsonResponse({ version: 'deployed-v3' }));
    const monitor = createVersionUpdateMonitor({
      currentVersion: 'running-v1',
      fetch: fetchMock,
    });

    await monitor.checkNow();
    monitor.dismiss();
    expect(monitor.getSnapshot()).toMatchObject({
      latestVersion: 'deployed-v2',
      dismissed: true,
      shouldNotify: false,
    });

    await monitor.checkNow();
    expect(monitor.getSnapshot()).toMatchObject({
      latestVersion: 'deployed-v3',
      dismissed: false,
      shouldNotify: true,
    });
  });

  it.each([
    ['non-OK response', new Response(null, { status: 503 })],
    ['missing version', jsonResponse({ service: 'frontend' })],
    ['empty version', jsonResponse({ version: '' })],
    ['oversized version', jsonResponse({ version: 'v'.repeat(257) })],
  ])('preserves trustworthy state after a %s', async (_name, response) => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ version: 'deployed-v2' }))
      .mockResolvedValueOnce(response);
    const monitor = createVersionUpdateMonitor({
      currentVersion: 'running-v1',
      fetch: fetchMock,
    });

    await monitor.checkNow();
    const before = monitor.getSnapshot();
    await monitor.checkNow();

    expect(monitor.getSnapshot()).toBe(before);
  });

  it('preserves trustworthy state after a network failure', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ version: 'deployed-v2' }))
      .mockRejectedValueOnce(new TypeError('offline'));
    const monitor = createVersionUpdateMonitor({
      currentVersion: 'running-v1',
      fetch: fetchMock,
    });

    await monitor.checkNow();
    const before = monitor.getSnapshot();
    await monitor.checkNow();

    expect(monitor.getSnapshot()).toBe(before);
  });

  it('shares one request between concurrent checks instead of cancelling', async () => {
    let resolveFirst: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const monitor = createVersionUpdateMonitor({
      currentVersion: 'running-v1',
      fetch: fetchMock,
    });

    const first = monitor.checkNow();
    const second = monitor.checkNow();
    expect(fetchMock).toHaveBeenCalledOnce();

    resolveFirst?.(jsonResponse({ version: 'deployed-v2' }));
    await Promise.all([first, second]);

    expect(monitor.getSnapshot().latestVersion).toBe('deployed-v2');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('keeps polling when the manifest is slower than the poll interval', async () => {
    vi.useFakeTimers();
    const pending: ((response: Response) => void)[] = [];
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          pending.push(resolve);
        }),
    );
    const onError = vi.fn();
    const monitor = createVersionUpdateMonitor({
      currentVersion: 'running-v1',
      fetch: fetchMock,
      pollIntervalMs: 1_000,
      onError,
    });
    monitor.start();

    // Three interval ticks elapse while the first request is still open.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fetchMock).toHaveBeenCalledOnce();

    pending[0]?.(jsonResponse({ version: 'deployed-v2' }));
    await vi.advanceTimersByTimeAsync(0);

    expect(monitor.getSnapshot().latestVersion).toBe('deployed-v2');
    expect(onError).not.toHaveBeenCalled();
    monitor.stop();
  });

  it('does not report an abort caused by stopping mid-check', async () => {
    let signal: AbortSignal | undefined;
    let rejectFetch: ((cause: unknown) => void) | undefined;
    const onError = vi.fn();
    const monitor = createVersionUpdateMonitor({
      currentVersion: 'running-v1',
      fetch: vi.fn<typeof fetch>().mockImplementation((_input, init) => {
        signal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          rejectFetch = reject;
        });
      }),
      onError,
    });

    const check = monitor.checkNow();
    monitor.stop();
    expect(signal?.aborted).toBe(true);
    rejectFetch?.(new DOMException('The operation was aborted.', 'AbortError'));
    await check;

    expect(onError).not.toHaveBeenCalled();
  });

  it('starts a fresh opening check after an immediate stop and restart', async () => {
    const pending: Array<{
      readonly signal: AbortSignal | null;
      readonly resolve: (response: Response) => void;
    }> = [];
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      (_input, init) =>
        new Promise<Response>((resolve) => {
          pending.push({ signal: init?.signal ?? null, resolve });
        }),
    );
    const monitor = createVersionUpdateMonitor({
      currentVersion: 'running-v1',
      fetch: fetchMock,
    });

    const release = monitor.start();
    release();
    monitor.start();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(pending[0]?.signal?.aborted).toBe(true);
    pending[0]?.resolve(jsonResponse({ version: 'stale-v0' }));
    pending[1]?.resolve(jsonResponse({ version: 'deployed-v2' }));
    await vi.waitFor(() =>
      expect(monitor.getSnapshot().latestVersion).toBe('deployed-v2'),
    );
    monitor.stop();
  });

  it('times out a hung request and releases the dedupe slot', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => new Promise<Response>(() => undefined))
      .mockResolvedValueOnce(jsonResponse({ version: 'deployed-v2' }));
    const onError = vi.fn();
    const monitor = createVersionUpdateMonitor({
      currentVersion: 'running-v1',
      fetch: fetchMock,
      requestTimeoutMs: 1_000,
      onError,
    });

    const first = monitor.checkNow();
    await vi.advanceTimersByTimeAsync(1_000);
    await first;
    await monitor.checkNow();

    expect(onError).toHaveBeenCalledWith({ type: 'timeout' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(monitor.getSnapshot().latestVersion).toBe('deployed-v2');
  });

  it('notifies again when a dismissed version is rolled back and redeployed', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ version: 'deployed-v2' }))
      .mockResolvedValueOnce(jsonResponse({ version: 'running-v1' }))
      .mockResolvedValueOnce(jsonResponse({ version: 'deployed-v2' }));
    const monitor = createVersionUpdateMonitor({
      currentVersion: 'running-v1',
      fetch: fetchMock,
    });

    await monitor.checkNow();
    monitor.dismiss();
    expect(monitor.getSnapshot().shouldNotify).toBe(false);

    await monitor.checkNow(); // rollback to the running artifact
    await monitor.checkNow(); // the same update deployed again

    expect(monitor.getSnapshot()).toMatchObject({
      latestVersion: 'deployed-v2',
      dismissed: false,
      shouldNotify: true,
    });
  });

  it('checks on visible-tab and bfcache resume events', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ version: 'deployed-v2' }))
      .mockResolvedValueOnce(jsonResponse({ version: 'deployed-v3' }))
      .mockResolvedValueOnce(jsonResponse({ version: 'deployed-v4' }));
    const monitor = createVersionUpdateMonitor({
      currentVersion: 'running-v1',
      fetch: fetchMock,
      pollIntervalMs: 60_000,
      document,
      window,
    });
    const release = monitor.start();
    // Wait for the opening check to settle: concurrent checks share a request.
    await vi.waitFor(() =>
      expect(monitor.getSnapshot().latestVersion).toBe('deployed-v2'),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);

    setVisibilityState('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() =>
      expect(monitor.getSnapshot().latestVersion).toBe('deployed-v3'),
    );

    const pageShow = new Event('pageshow');
    Object.defineProperty(pageShow, 'persisted', { value: true });
    window.dispatchEvent(pageShow);
    await vi.waitFor(() =>
      expect(monitor.getSnapshot().latestVersion).toBe('deployed-v4'),
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);

    release();
    setVisibilityState('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    const afterRelease = new Event('pageshow');
    Object.defineProperty(afterRelease, 'persisted', { value: true });
    window.dispatchEvent(afterRelease);
    await Promise.resolve();

    // The released monitor must detach its listeners, not merely stop its
    // timer: an unmounted component that still fetches on every tab focus
    // leaks for the life of the page.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('reports an internal fault instead of rejecting the shared check', async () => {
    const onError = vi.fn();
    const monitor = createVersionUpdateMonitor({
      currentVersion: 'running-v1',
      // An injected fetch that does not resolve to a Response: reading
      // `.ok` throws outside the fetch and parse guards.
      fetch: vi.fn(async () => undefined) as unknown as typeof fetch,
      onError,
    });

    await expect(monitor.checkNow()).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'internal' }),
    );
    expect(monitor.getSnapshot().latestVersion).toBeNull();

    // The dedupe slot is released, so the monitor keeps checking.
    await monitor.checkNow();
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('keeps polling and surfaces the loss when onError itself throws', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('nope', { status: 500 }));
    const monitor = createVersionUpdateMonitor({
      currentVersion: 'running-v1',
      fetch: fetchMock,
      onError: () => {
        throw new Error('reporter is down');
      },
    });

    await monitor.checkNow();
    await monitor.checkNow();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(consoleError).toHaveBeenCalledWith(
      '[web-update-check] onError threw',
      expect.any(Error),
    );
  });

  it('notifies the listeners registered at publish time despite re-entrancy', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ version: 'deployed-v2' }));
    const monitor = createVersionUpdateMonitor({
      currentVersion: 'running-v1',
      fetch: fetchMock,
    });

    const lateListener = vi.fn();
    const second = vi.fn();
    const first = vi.fn(() => {
      // Mutating the set mid-publish must not change what this pass delivers.
      unsubscribeFirst();
      monitor.subscribe(lateListener);
    });
    const unsubscribeFirst = monitor.subscribe(first);
    monitor.subscribe(second);

    await monitor.checkNow();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(lateListener).not.toHaveBeenCalled();
  });

  it('ignores hidden-tab and non-bfcache lifecycle events', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ version: 'deployed-v2' }));
    const monitor = createVersionUpdateMonitor({
      currentVersion: 'running-v1',
      fetch: fetchMock,
      pollIntervalMs: 60_000,
      document,
      window,
    });
    const release = monitor.start();
    await vi.waitFor(() =>
      expect(monitor.getSnapshot().latestVersion).toBe('deployed-v2'),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);

    setVisibilityState('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    const pageShow = new Event('pageshow');
    Object.defineProperty(pageShow, 'persisted', { value: false });
    window.dispatchEvent(pageShow);
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledOnce();
    release();
  });

  it('keeps lifecycle active until the final lease is released', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ version: 'running-v1' }));
    const monitor = createVersionUpdateMonitor({
      currentVersion: 'running-v1',
      fetch: fetchMock,
      pollIntervalMs: 1_000,
    });
    const releaseOne = monitor.start();
    const releaseTwo = monitor.start();
    await vi.advanceTimersByTimeAsync(1_000);
    const activeCount = fetchMock.mock.calls.length;

    releaseOne();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(activeCount);
    const beforeFinalRelease = fetchMock.mock.calls.length;

    releaseTwo();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(beforeFinalRelease);
  });

  it('publishes immutable stable snapshots only when state changes', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ version: 'deployed-v2' }));
    const monitor = createVersionUpdateMonitor({
      currentVersion: 'running-v1',
      fetch: fetchMock,
    });
    const listener = vi.fn();
    monitor.subscribe(listener);

    await monitor.checkNow();
    const changed = monitor.getSnapshot();
    await monitor.checkNow();

    expect(listener).toHaveBeenCalledOnce();
    expect(monitor.getSnapshot()).toBe(changed);
    expect(Object.isFrozen(changed)).toBe(true);
  });

  it('isolates subscriber failures and reports them', async () => {
    const listenerError = new Error('subscriber failed');
    const onError = vi.fn();
    const laterListener = vi.fn();
    const monitor = createVersionUpdateMonitor({
      currentVersion: 'running-v1',
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(jsonResponse({ version: 'deployed-v2' })),
      onError,
    });
    monitor.subscribe(() => {
      throw listenerError;
    });
    monitor.subscribe(laterListener);

    await monitor.checkNow();

    expect(laterListener).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith({
      type: 'listener',
      cause: listenerError,
    });
  });

  it.each([
    [
      'response',
      new Response(null, { status: 503 }),
      { type: 'response', status: 503 },
    ],
    ['manifest', jsonResponse({ service: 'frontend' }), { type: 'manifest' }],
  ])('reports a failed %s check', async (_name, response, expectedError) => {
    const onError = vi.fn();
    const monitor = createVersionUpdateMonitor({
      currentVersion: 'running-v1',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(response),
      onError,
    });

    await monitor.checkNow();

    expect(onError).toHaveBeenCalledWith(expectedError);
  });

  it('reports request failures without reporting intentional aborts', async () => {
    const requestError = new TypeError('offline');
    const onError = vi.fn();
    const monitor = createVersionUpdateMonitor({
      currentVersion: 'running-v1',
      fetch: vi.fn<typeof fetch>().mockRejectedValue(requestError),
      onError,
    });

    await monitor.checkNow();

    expect(onError).toHaveBeenCalledWith({
      type: 'request',
      cause: requestError,
    });
  });

  it('reports an unparseable manifest body as a deployment fault', async () => {
    const onError = vi.fn();
    const monitor = createVersionUpdateMonitor({
      currentVersion: 'running-v1',
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response('<!doctype html><html></html>', {
            headers: { 'content-type': 'text/html' },
          }),
        ),
      onError,
    });

    await monitor.checkNow();

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'parse' }),
    );
    expect(monitor.getSnapshot().latestVersion).toBeNull();
  });

  it('rejects a manifest version that is padded or over-long', async () => {
    const onError = vi.fn();
    const monitor = createVersionUpdateMonitor({
      currentVersion: 'running-v1',
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ version: ' deployed-v2 ' }))
        .mockResolvedValueOnce(jsonResponse({ version: 'v'.repeat(257) })),
      onError,
    });

    await monitor.checkNow();
    await monitor.checkNow();

    expect(onError).toHaveBeenNthCalledWith(1, { type: 'manifest' });
    expect(onError).toHaveBeenNthCalledWith(2, { type: 'manifest' });
    expect(monitor.getSnapshot().latestVersion).toBeNull();
  });

  it('stops notifying subscribers after unsubscribe', async () => {
    const listener = vi.fn();
    const monitor = createVersionUpdateMonitor({
      currentVersion: 'running-v1',
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(jsonResponse({ version: 'deployed-v2' })),
    });
    const unsubscribe = monitor.subscribe(listener);
    unsubscribe();

    await monitor.checkNow();

    expect(listener).not.toHaveBeenCalled();
  });

  it('snapshots the running version at construction', async () => {
    const options = {
      currentVersion: 'running-v1',
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(jsonResponse({ version: 'running-v2' })),
    };
    const monitor = createVersionUpdateMonitor(options);
    options.currentVersion = 'running-v2';

    await monitor.checkNow();

    expect(monitor.getSnapshot()).toMatchObject({
      currentVersion: 'running-v1',
      updateAvailable: true,
    });
  });

  it('validates configuration at the boundary', () => {
    expect(() =>
      createVersionUpdateMonitor({ currentVersion: '', fetch }),
    ).toThrow(/currentVersion/);
    expect(() =>
      createVersionUpdateMonitor({
        currentVersion: 'v1',
        manifestUrl: '',
        fetch,
      }),
    ).toThrow(/manifestUrl/);
    expect(() =>
      createVersionUpdateMonitor({
        currentVersion: 'v1',
        pollIntervalMs: 0,
        fetch,
      }),
    ).toThrow(/pollIntervalMs/);
    expect(() =>
      createVersionUpdateMonitor({
        currentVersion: 'v1',
        requestTimeoutMs: 0,
        fetch,
      }),
    ).toThrow(/requestTimeoutMs/);
    expect(() =>
      createVersionUpdateMonitor({
        currentVersion: 'v1',
        pollIntervalMs: 1.5,
        fetch,
      }),
    ).toThrow(/pollIntervalMs/);
    expect(() =>
      createVersionUpdateMonitor({
        currentVersion: 'v1',
        pollIntervalMs: 2_147_483_648,
        fetch,
      }),
    ).toThrow(/pollIntervalMs/);
    expect(() =>
      createVersionUpdateMonitor({ currentVersion: ' v1 ', fetch }),
    ).toThrow(/currentVersion/);
    expect(() =>
      createVersionUpdateMonitor({
        currentVersion: 'v1',
        fetch: 'not-a-function' as unknown as typeof fetch,
      }),
    ).toThrow(/fetch/);
    expect(() =>
      createVersionUpdateMonitor({
        currentVersion: 'v'.repeat(256),
        pollIntervalMs: 2_147_483_647,
        fetch,
      }),
    ).not.toThrow();
  });

  it('preserves manifest query parameters and fragments when cache busting', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ version: 'v1' }));
    const monitor = createVersionUpdateMonitor({
      currentVersion: 'v1',
      manifestUrl: '/base/version.json?tenant=public#asset',
      fetch: fetchMock,
    });

    await monitor.checkNow();

    expect(fetchMock.mock.calls[0]?.[0]).toMatch(
      /^\/base\/version\.json\?tenant=public&updateCheck=\d+#asset$/,
    );
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
  });
}

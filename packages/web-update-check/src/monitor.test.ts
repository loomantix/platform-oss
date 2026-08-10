import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVersionUpdateMonitor } from './monitor';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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

  it('aborts a superseded request so an older response cannot win', async () => {
    let resolveFirst: ((response: Response) => void) | undefined;
    let firstSignal: AbortSignal | undefined;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce((_input, init) => {
        firstSignal = init?.signal ?? undefined;
        return new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        });
      })
      .mockResolvedValueOnce(jsonResponse({ version: 'deployed-v3' }));
    const monitor = createVersionUpdateMonitor({
      currentVersion: 'running-v1',
      fetch: fetchMock,
    });

    const first = monitor.checkNow();
    await monitor.checkNow();
    expect(firstSignal?.aborted).toBe(true);
    resolveFirst?.(jsonResponse({ version: 'deployed-v2' }));
    await first;

    expect(monitor.getSnapshot().latestVersion).toBe('deployed-v3');
  });

  it('checks on visible-tab and bfcache resume events', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ version: 'running-v1' }));
    const monitor = createVersionUpdateMonitor({
      currentVersion: 'running-v1',
      fetch: fetchMock,
      pollIntervalMs: 60_000,
      document,
      window,
    });
    const release = monitor.start();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const pageShow = new Event('pageshow');
    Object.defineProperty(pageShow, 'persisted', { value: true });
    window.dispatchEvent(pageShow);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
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

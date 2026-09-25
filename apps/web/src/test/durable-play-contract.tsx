import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { pendingPlayStorageKey } from '@/hooks/use-durable-play';

/** How one game page is driven by the shared durable-play contract. */
export interface DurablePlayPage {
  gameKey: string;
  userId: string;
  playGameMock: Mock;
  newIdempotencyKeySpy: Mock;
  renderPage: () => void;
  /** Resolves once the page can play. */
  ready: () => Promise<void>;
  /** Plays with the form as it is (selecting a default answer if needed). */
  play: () => void;
  /** Whether the play control is enabled again (the request settled or failed). */
  playEnabled: () => boolean;
  /** The body the first play sends. */
  firstBody: Record<string, unknown>;
  /** Changes the form; returns the body it now describes. */
  edit: () => Record<string, unknown>;
  /** Makes the page ready for another round after a settled one. */
  nextRound: () => Promise<void>;
  /** A play response of the real API shape for `body`. */
  response: (body: Record<string, unknown>, isReplay: boolean) => unknown;
  setUser: (user: { id: string; username: string; displayName: string } | null) => void;
}

const storageFailure = () => { throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); };
const lostResponse = () => new TypeError('Failed to fetch');
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

/**
 * The exactly-once contract every Coin-playing page keeps: a round's key and
 * exact request are kept before the first send; in memory they stay
 * authoritative for the page's lifetime, so a lost response is retried with
 * them even if storage then fails; a page that cannot store the round sends
 * nothing; edited values never reuse the key of an unresolved round; only a
 * conclusive answer ends it; another user never inherits it.
 */
export function durablePlayContract(page: DurablePlayPage) {
  const storageKey = () => pendingPlayStorageKey(page.userId, page.gameKey);

  /** The API's idempotency: the first request with a key settles a round,
   * an exact retry replays it. */
  function fakeServer() {
    const settled = new Map<string, unknown>();
    let loseNext = false;
    page.playGameMock.mockImplementation(async (_game: string, body: Record<string, unknown>, key: string) => {
      if (settled.has(key)) return page.response(settled.get(key) as Record<string, unknown>, true);
      settled.set(key, body);
      if (loseNext) { loseNext = false; throw lostResponse(); }
      return page.response(body, false);
    });
    return { settled, loseNextResponse: () => { loseNext = true; } };
  }

  // jsdom's sessionStorage does not resolve its methods through the global
  // Storage.prototype, so the failures are injected at window.sessionStorage:
  // the chosen methods throw, writes are silently dropped ('drop'), or (as
  // when the browser blocks site data) reading window.sessionStorage itself
  // throws.
  type StorageFailure = 'getItem' | 'setItem' | 'removeItem' | 'drop' | 'access';
  const failing = new Set<StorageFailure>();
  let storageSpy: { mockRestore: () => void } | null = null;
  const failStorage = (...failures: StorageFailure[]) => {
    for (const failure of failures) failing.add(failure);
    if (storageSpy) return;
    const real = window.sessionStorage;
    const guard = <A extends unknown[], R>(method: StorageFailure, run: (...args: A) => R) => (...args: A): R => {
      if (failing.has(method)) storageFailure();
      return run(...args);
    };
    const wrapper = {
      getItem: guard('getItem', (key: string) => real.getItem(key)),
      setItem: guard('setItem', (key: string, value: string) => { if (!failing.has('drop')) real.setItem(key, value); }),
      removeItem: guard('removeItem', (key: string) => real.removeItem(key)),
      clear: () => real.clear(),
      key: (index: number) => real.key(index),
      get length() { return real.length; },
    } as Storage;
    storageSpy = vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => {
      if (failing.has('access')) throw new DOMException('The operation is insecure.', 'SecurityError');
      return wrapper;
    });
  };
  const restoreStorage = () => {
    storageSpy?.mockRestore();
    storageSpy = null;
    failing.clear();
  };
  afterEach(restoreStorage);

  it('sends nothing when the browser cannot keep the round, and says so', async () => {
    fakeServer();
    failStorage('setItem');
    page.renderPage();
    await page.ready();
    page.play();
    expect(await screen.findByText(/cannot keep this round safe/i)).toBeInTheDocument();
    await settle();
    expect(page.playGameMock).not.toHaveBeenCalled();
  });

  it('sends nothing when the browser blocks storage entirely', async () => {
    fakeServer();
    failStorage('access');
    page.renderPage();
    await page.ready();
    page.play();
    expect(await screen.findByText(/cannot keep this round safe/i)).toBeInTheDocument();
    await settle();
    expect(page.playGameMock).not.toHaveBeenCalled();
    expect(page.newIdempotencyKeySpy).not.toHaveBeenCalled();
  });

  it('sends nothing when the browser silently drops what it stores', async () => {
    fakeServer();
    failStorage('drop');
    page.renderPage();
    await page.ready();
    page.play();
    expect(await screen.findByText(/cannot keep this round safe/i)).toBeInTheDocument();
    await settle();
    expect(page.playGameMock).not.toHaveBeenCalled();
  });

  it('a lost response is retried with the same key and request, even when storage then fails', async () => {
    const server = fakeServer();
    server.loseNextResponse();
    page.renderPage();
    await page.ready();
    page.play();
    await waitFor(() => expect(page.playGameMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(page.playEnabled()).toBe(true));
    failStorage('getItem', 'setItem', 'removeItem');
    page.play();
    await waitFor(() => expect(page.playGameMock).toHaveBeenCalledTimes(2));
    expect(page.playGameMock.mock.calls[1].slice(1)).toEqual(page.playGameMock.mock.calls[0].slice(1));
    expect(await screen.findByText('Replayed round — no new wager.')).toBeInTheDocument();
    expect(server.settled.size).toBe(1);
    expect(page.newIdempotencyKeySpy).toHaveBeenCalledTimes(1);

    // The confirmed round's stored copy could not be removed; once storage
    // works again, it is never resent, and the next round gets a new key.
    restoreStorage();
    await page.nextRound();
    page.play();
    await waitFor(() => expect(page.playGameMock).toHaveBeenCalledTimes(3));
    const [, nextBody, nextKey] = page.playGameMock.mock.calls[2];
    expect(nextKey).not.toBe(page.playGameMock.mock.calls[0][2]);
    expect(nextBody).toEqual(page.firstBody);
    expect(server.settled.size).toBe(2);
    expect(page.newIdempotencyKeySpy).toHaveBeenCalledTimes(2);
  });

  it('a response lost after the round settled is resumed exactly after a reload, and settles once', async () => {
    const server = fakeServer();
    server.loseNextResponse();
    page.renderPage();
    await page.ready();
    page.play();
    await waitFor(() => expect(page.playGameMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(page.playEnabled()).toBe(true));
    cleanup(); // the player reloads
    page.renderPage();
    expect(await screen.findByText('Replayed round — no new wager.')).toBeInTheDocument();
    expect(page.playGameMock).toHaveBeenCalledTimes(2);
    expect(page.playGameMock.mock.calls[1].slice(1)).toEqual(page.playGameMock.mock.calls[0].slice(1));
    expect(page.playGameMock.mock.calls[0][1]).toEqual(page.firstBody);
    expect(server.settled.size).toBe(1);
    expect(window.sessionStorage.getItem(storageKey())).toBeNull();
  });

  it('edited values never reuse the key of an unconfirmed round', async () => {
    const server = fakeServer();
    server.loseNextResponse();
    page.renderPage();
    await page.ready();
    page.play();
    await waitFor(() => expect(page.playGameMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(page.playEnabled()).toBe(true));
    const [, firstBody, firstKey] = page.playGameMock.mock.calls[0];
    const edited = page.edit();
    expect(await screen.findByText(/has not been confirmed yet/i)).toBeInTheDocument();
    page.play(); // confirms the unconfirmed round, unchanged
    await waitFor(() => expect(page.playGameMock).toHaveBeenCalledTimes(2));
    expect(page.playGameMock.mock.calls[1].slice(1)).toEqual([firstBody, firstKey]);
    await page.nextRound();
    page.edit();
    page.play();
    await waitFor(() => expect(page.playGameMock).toHaveBeenCalledTimes(3));
    const [, editedBody, editedKey] = page.playGameMock.mock.calls[2];
    expect(editedBody).toEqual(edited);
    expect(editedKey).not.toBe(firstKey);
    for (const [, body, key] of page.playGameMock.mock.calls) {
      if (key === firstKey) expect(body).toEqual(firstBody);
    }
  });

  it('a confirmed round is forgotten, and the next round gets a new key', async () => {
    fakeServer();
    page.renderPage();
    await page.ready();
    page.play();
    await waitFor(() => expect(page.playGameMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(window.sessionStorage.getItem(storageKey())).toBeNull());
    await page.nextRound();
    page.play();
    await waitFor(() => expect(page.playGameMock).toHaveBeenCalledTimes(2));
    expect(page.playGameMock.mock.calls[1][2]).not.toBe(page.playGameMock.mock.calls[0][2]);
    expect(page.newIdempotencyKeySpy).toHaveBeenCalledTimes(2);
  });

  it('another user never inherits a pending round, and a signed-out page never plays', async () => {
    fakeServer();
    window.sessionStorage.setItem(pendingPlayStorageKey('other-user', page.gameKey),
      JSON.stringify({ key: 'their-key', body: { ...page.firstBody, marker: 'theirs' } }));
    page.renderPage();
    await page.ready();
    await settle();
    expect(page.playGameMock).not.toHaveBeenCalled();
    page.play();
    await waitFor(() => expect(page.playGameMock).toHaveBeenCalledTimes(1));
    expect(page.playGameMock.mock.calls[0][2]).not.toBe('their-key');
    expect(page.playGameMock.mock.calls[0][1]).toEqual(page.firstBody);
    expect(JSON.parse(window.sessionStorage.getItem(pendingPlayStorageKey('other-user', page.gameKey))!).key).toBe('their-key');

    cleanup(); // sign out
    page.setUser(null);
    page.renderPage();
    await settle();
    try { page.play(); } catch { /* a signed-out page may not offer the control at all */ }
    await settle();
    expect(page.playGameMock).toHaveBeenCalledTimes(1);
  });
}

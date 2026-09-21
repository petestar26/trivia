import { afterEach, describe, expect, it, vi } from 'vitest';

// The wire contract of the two Unban endpoints, as the web client speaks it:
//   GET  /groups/:id/banned-members?page=&limit=
//   POST /groups/:id/members/:userId/unban        (no body)

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function loadApi(payload: unknown = { success: true, data: [] }) {
  vi.resetModules();
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => payload });
  vi.stubGlobal('fetch', fetchMock);
  const { api } = await import('./api');
  const { API_BASE, API_ORIGIN } = await import('./api-config');
  return { api, fetchMock, base: `${API_ORIGIN || window.location.origin}${API_BASE}` };
}

describe('group moderation API client', () => {
  it('listBannedMembers is a GET on the group\'s banned-members path with paging in the query string', async () => {
    const { api, fetchMock, base } = await loadApi();

    await api.listBannedMembers('g-1', { page: 2, limit: 20 });

    const [url, init] = fetchMock.mock.lastCall!;
    expect(url).toBe(`${base}/groups/g-1/banned-members?page=2&limit=20`);
    expect(init).toMatchObject({ method: 'GET', credentials: 'include' });
  });

  it('listBannedMembers works without paging parameters', async () => {
    const { api, fetchMock, base } = await loadApi();

    await api.listBannedMembers('g-1');

    expect(fetchMock.mock.lastCall![0]).toBe(`${base}/groups/g-1/banned-members`);
  });

  it('unbanGroupMember is a bodyless POST on the member\'s unban path', async () => {
    const { api, fetchMock, base } = await loadApi({ success: true, data: { message: 'Member unbanned' } });

    const res = await api.unbanGroupMember('g-1', 'u-9');

    const [url, init] = fetchMock.mock.lastCall!;
    expect(url).toBe(`${base}/groups/g-1/members/u-9/unban`);
    expect(init).toMatchObject({ method: 'POST', credentials: 'include' });
    // No body, and so no JSON content type: Fastify rejects an empty JSON body.
    expect(init.body).toBeUndefined();
    expect(init.headers).not.toHaveProperty('Content-Type');
    expect(res.data).toEqual({ message: 'Member unbanned' });
  });

  it('a refusal reaches the caller as an Error whose message carries the status and the server\'s message', async () => {
    vi.resetModules();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({ success: false, error: { code: 'CONFLICT', message: 'This member is not banned' } }),
      })
    );
    const { api } = await import('./api');

    const failure = await api.unbanGroupMember('g-1', 'u-9').catch((e: Error) => e);

    expect(failure).toBeInstanceOf(Error);
    expect(JSON.parse((failure as Error).message)).toMatchObject({ status: 409, message: 'This member is not banned' });
  });
});

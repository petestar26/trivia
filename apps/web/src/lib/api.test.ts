import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('API destination', () => {
  it.each([
    ['https://api.example.com', 'https://api.example.com'],
    ['https://api.example.com/', 'https://api.example.com'],
    ['https://api.example.com///', 'https://api.example.com'],
    ['https://api.example.com/api/v1/', 'https://api.example.com'],
    ['https://api.example.com/api/v1/api/v1///', 'https://api.example.com'],
    ['', ''],
    [undefined, ''],
  ])('routes requests with VITE_API_URL=%s', async (configured, origin) => {
    vi.stubEnv('VITE_API_URL', configured ?? '');
    if (configured === undefined) {
      // Vitest 1 coerces stubEnv(undefined) to the string "undefined".
      Reflect.deleteProperty(import.meta.env, 'VITE_API_URL');
      Reflect.deleteProperty(process.env, 'VITE_API_URL');
    }
    vi.resetModules();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: {} }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { api, voiceMessageUrl, getApiHealth } = await import('./api');
    const { API_ORIGIN } = await import('./api-config');
    expect(API_ORIGIN).toBe(origin); // Also used as the Socket.IO origin.
    const base = `${origin || window.location.origin}/api/v1`;

    await api.post('/auth/register', { username: 'test' });
    expect(fetchMock).toHaveBeenLastCalledWith(`${base}/auth/register`, expect.objectContaining({
      method: 'POST', credentials: 'include', body: '{"username":"test"}',
    }));
    await api.get('/auth/me', { page: 1, query: 'a & b', absent: undefined });
    expect(fetchMock.mock.lastCall?.[0]).toBe(`${base}/auth/me?page=1&query=a+%26+b`);
    const form = new FormData();
    await api.upload('/groups/group/voice-messages', form);
    expect(fetchMock).toHaveBeenLastCalledWith(`${base}/groups/group/voice-messages`, {
      method: 'POST', body: form, credentials: 'include',
    });
    expect(voiceMessageUrl('group', 'message')).toBe(`${origin}/api/v1/groups/group/voice-messages/message`);
    await api.post('/auth/logout');
    expect(fetchMock).toHaveBeenLastCalledWith(`${base}/auth/logout`, expect.objectContaining({
      method: 'POST', credentials: 'include',
    }));
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'ok' }) });
    await expect(getApiHealth()).resolves.toEqual({ status: 'ok' });
    expect(fetchMock).toHaveBeenLastCalledWith(`${origin}/health`);
    fetchMock.mockResolvedValueOnce({ ok: false });
    await expect(getApiHealth()).rejects.toThrow('API health check failed');
  });

  it.each(['https://api.example.com/other', 'https://api.example.com?query=1', 'ftp://api.example.com']) (
    'rejects an invalid API origin %s', async (origin) => {
      vi.stubEnv('VITE_API_URL', origin);
      await expect(import('./api-config')).rejects.toThrow('VITE_API_URL must be');
    },
  );
});

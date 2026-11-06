import { afterEach, expect, it, vi } from 'vitest';
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});
async function load(provider: string) {
  vi.stubEnv('DATABASE_URL', 'postgresql://unused@localhost/unused');
  vi.stubEnv('JWT_ACCESS_SECRET', 'disposable-test-access-secret-12345678');
  vi.stubEnv('JWT_REFRESH_SECRET', 'disposable-test-refresh-secret-12345678');
  vi.stubEnv('STORAGE_PROVIDER', provider);
  return import('./index.js');
}
it.each(['s3', 'r2', 'minio', 'unknown'])(
  'rejects unsupported %s storage at startup',
  async (provider) => {
    await expect(load(provider)).rejects.toThrow('Only local storage is implemented');
  }
);
it('accepts the implemented local provider', async () => {
  expect((await load('local')).config.STORAGE_PROVIDER).toBe('local');
});

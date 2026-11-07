import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { createHash, createHmac } from 'node:crypto';
import { Writable } from 'node:stream';
import { redactedRequestSerializer } from '../../middleware/log-redaction.js';
import { requestLogger } from '../../middleware/request-logger.js';
import { afterEach, expect, it, vi } from 'vitest';
import { providerTestCallbackRoutes } from './callback-routes.js';
import { registerMonitorSignals } from '../../monitoring/signals.js';
const apply = vi.hoisted(() => vi.fn());
const sportsApply = vi.hoisted(() => vi.fn());
vi.mock('./sports-wallet.js', () => ({ createSportsWallet: () => ({ apply: sportsApply }) }));
vi.mock('@socialplay/database', () => ({ prisma: {} }));
vi.mock('./test-wallet.js', async () => ({
  ...(await vi.importActual<typeof import('./test-wallet.js')>('./test-wallet.js')),
  createTestWallet: () => ({ apply }),
}));
const salt = 'test-callback-salt-123',
  gateway = 'private-fixture-gateway-key-32-characters';
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});
function request(ip = '85.122.129.59', realm = 'st') {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const q = {
    username: realm + '_' + 'b'.repeat(32),
    currency: 'ETB',
    action: 'credit',
    call_id: 'bonus-123',
    amount: '450',
    timestamp,
    key: createHash('md5')
      .update(timestamp + salt)
      .digest('hex'),
  };
  const url = '/sg/callback?' + new URLSearchParams(q);
  const signature = createHmac('sha256', salt)
    .update(
      Object.entries(q)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => `${k}=${v}`)
        .join('&')
    )
    .digest('hex');
  const t = String(Date.now());
  return {
    url,
    headers: {
      'x-signature': signature,
      'x-playqube-client-ip': ip,
      'x-playqube-client-time': t,
      'x-playqube-client-signature': createHmac('sha256', gateway)
        .update(JSON.stringify([t, 'GET', url, ip]))
        .digest('hex'),
    },
  };
}
async function server() {
  vi.stubEnv('SOFTAGGREGATOR_TEST_CALLBACK_ENABLED', 'true');
  vi.stubEnv('SOFTAGGREGATOR_SALT_KEY', salt);
  vi.stubEnv('WEB_GATEWAY_SECRET', gateway);
  const s = Fastify();
  registerMonitorSignals(s, true);
  await s.register(rateLimit, { global: true, max: 1, timeWindow: '1 minute' });
  await s.register(providerTestCallbackRoutes);
  return s;
}
it('routes a signed sports callback only to the real wallet and never to practice', async () => {
  const s = await server();
  vi.stubEnv('SOFTAGGREGATOR_SPORTS_CALLBACK_ENABLED', 'true');
  sportsApply.mockResolvedValue({ error: 0, balance: 0 });
  try {
    const r = await s.inject(request('85.122.129.59', 'sr'));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ error: 0, balance: 0 });
    expect(sportsApply).toHaveBeenCalledOnce();
    expect(apply).not.toHaveBeenCalled();
  } finally {
    await s.close();
  }
});
it('accepts authenticated provider GETs repeatedly with HTTP 200 and cents', async () => {
  const s = await server();
  apply.mockResolvedValue({ error: 0, balance: 100450 });
  try {
    for (let i = 0; i < 3; i++) {
      const r = await s.inject(request());
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ error: 0, balance: 100450 });
      expect(r.headers['cache-control']).toContain('no-store');
    }
    expect(apply).toHaveBeenCalledTimes(3);
    expect(s.salemMonitor!.take().callbacks).toEqual({ accepted: 3 });
  } finally {
    await s.close();
  }
});
it('rejects spoofed source headers, missing signatures and wrong provider IP with HTTP 200', async () => {
  const s = await server();
  try {
    const original = request();
    for (const req of [
      request('203.0.113.1'),
      {
        url: original.url,
        headers: { 'x-forwarded-for': '85.122.129.59', 'x-real-ip': '85.122.129.59' },
      },
      { ...original, headers: { ...original.headers, 'x-signature': 'bad' } },
      {
        ...original,
        headers: { ...original.headers, 'x-playqube-client-signature': '0'.repeat(64) },
      },
    ]) {
      const r = await s.inject(req);
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ error: 2, balance: 0 });
    }
    expect(apply).not.toHaveBeenCalled();
    expect(s.salemMonitor!.take().callbacks).toEqual({
      untrusted_source: 3,
      invalid_signature_or_payload: 1,
    });
  } finally {
    await s.close();
  }
});
it('returns HTTP 200 JSON errors on database failures, disabled callbacks and unsupported methods', async () => {
  const s = await server();
  apply.mockRejectedValue(Error('private database URL'));
  try {
    const failed = await s.inject(request());
    expect(failed.statusCode).toBe(200);
    expect(failed.body).not.toContain('private');
    expect(failed.json()).toEqual({ error: 2, balance: 0 });
    vi.stubEnv('SOFTAGGREGATOR_TEST_CALLBACK_ENABLED', 'false');
    expect((await s.inject(request())).json()).toEqual({ error: 2, balance: 0 });
    const post = await s.inject({
      method: 'POST',
      url: '/sg/callback',
      payload: 'invalid',
      headers: { 'content-type': 'application/json' },
    });
    expect(post.statusCode).toBe(200);
    expect(post.json()).toEqual({ error: 2, balance: 0 });
    const metrics = s.salemMonitor!.take();
    expect(metrics.callbacks).toEqual({ failed: 2, disabled: 1 });
    expect(metrics.http.casino.serverErrors).toBe(0);
    expect(JSON.stringify(metrics)).not.toContain('private');
  } finally {
    await s.close();
  }
});
it('keeps provider query values out of automatic and application request logs', async () => {
  const lines: string[] = [];
  const s = Fastify({
    logger: {
      level: 'trace',
      serializers: { req: redactedRequestSerializer },
      stream: new Writable({
        write(chunk, _enc, done) {
          lines.push(String(chunk));
          done();
        },
      }),
    },
  });
  s.addHook('onRequest', requestLogger);
  await s.register(providerTestCallbackRoutes);
  const input = request();
  try {
    await s.inject(input);
    const logs = lines.join('');
    expect(logs).toContain('/sg/callback');
    expect(logs).not.toContain('bonus-123');
    expect(logs).not.toContain('st_' + 'b'.repeat(32));
    expect(logs).not.toContain(input.headers['x-signature']);
    expect(logs).not.toContain(new URLSearchParams(input.url.split('?')[1]).get('key'));
  } finally {
    await s.close();
  }
});

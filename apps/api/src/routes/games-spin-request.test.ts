import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { gameRoutes } from './games.js';
import { playGame } from '../games/game-play.js';
vi.mock('../middleware', () => ({
  authenticate: async (request: FastifyRequest) => {
    request.user = { sub: 'spin-user' } as FastifyRequest['user'];
  },
}));
vi.mock('../games/game-play.js', () => ({
  playGame: vi.fn(async () => ({ isReplay: false })),
  getGameHistory: vi.fn(),
}));
vi.mock('../games/game-catalog.js', () => ({ listActiveGames: vi.fn() }));
const servers: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  vi.clearAllMocks();
});
async function send(payload: unknown) {
  const server = Fastify({ ajv: { customOptions: { coerceTypes: false } } });
  servers.push(server);
  await server.register(gameRoutes, { prefix: '/games' });
  return server.inject({
    method: 'POST',
    url: '/games/spin_win/play',
    headers: { 'idempotency-key': 'spin-round-1' },
    payload: payload as object,
  });
}
describe('Spin Win HTTP request', () => {
  it('passes the exact ticket and idempotency key into settlement', async () => {
    const bets = [{ marketId: 'red', amount: 10 }];
    expect((await send({ betAmount: 10, bets })).statusCode).toBe(201);
    expect(playGame).toHaveBeenCalledWith(
      expect.objectContaining({
        gameKey: 'spin_win',
        userId: 'spin-user',
        idempotencyKey: 'spin-round-1',
        betAmount: 10,
        clientData: expect.objectContaining({ bets }),
      })
    );
  });
  it.each(
    [
      [],
      [{ marketId: 'red', amount: -1 }],
      [{ marketId: 'red', amount: 1.5 }],
      Array.from({ length: 53 }, () => ({ marketId: 'red', amount: 1 })),
    ].map((bets) => ({ bets }))
  )('rejects malformed ticket before settlement $bets', async ({ bets }) => {
    expect((await send({ betAmount: 10, bets })).statusCode).toBe(400);
    expect(playGame).not.toHaveBeenCalled();
  });
});

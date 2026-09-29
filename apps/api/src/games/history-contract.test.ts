// API side of the game-history contract with the web client. The web history
// page is tested against apps/web/src/test/fixtures/game-history.contract.json;
// this proves the real route answers exactly that shape, and that a contest
// round (challenge or competition) carries no stake and no settlement: its
// Game Points entry fee was escrowed once on the contest, never per round.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@socialplay/database';
import { config } from '@socialplay/config';
import { buildServer } from '../server.js';
import { executeBalanceChange, getOrCreateWallet } from '../economy/wallet-service.js';
import { acceptChallenge, createChallenge, playChallengeTurn } from '../challenges/challenge-service.js';
import { createCompetition, joinCompetition, playCompetition } from '../competitions/competition-service.js';

const CONTRACT = JSON.parse(readFileSync(fileURLToPath(
  new URL('../../../web/src/test/fixtures/game-history.contract.json', import.meta.url)), 'utf8')) as {
  data: Record<string, unknown>[]; meta: Record<string, unknown>;
};

let server: Awaited<ReturnType<typeof buildServer>>;
const tag = randomUUID().replaceAll('-', '').slice(0, 10);

async function user(label: string) {
  return prisma.user.create({ data: {
    email: `hist-contract-${label}-${tag}@test.local`, username: `hc_${label}_${tag}`,
    displayName: `History contract ${label}`, passwordHash: 'fixture-only',
  } });
}

async function gamePoints(userId: string, amount: number) {
  await getOrCreateWallet(userId);
  await executeBalanceChange({
    userId,
    changes: [{ currency: 'GAME_POINTS', amount, ledgerType: 'CREDIT', transactionType: 'GAME_POINT_CREDIT',
      referenceType: 'ADMIN', description: 'History contract fixture' }],
    operationName: 'test_fund_gp',
  });
}

beforeAll(async () => {
  server = await buildServer();
  await server.ready();
});
afterAll(async () => {
  if (server) await server.close();
  await prisma.$disconnect();
});

describe('game history API contract with the web client', () => {
  it('answers the fixture shape, and contest rounds carry no stake and no settlement', async () => {
    const a = await user('a');
    const b = await user('b');
    await gamePoints(a.id, 100);
    await gamePoints(b.id, 100);

    const challenge = await createChallenge(a.id, b.id, 'dice', 10);
    await acceptChallenge(b.id, challenge.id);
    await playChallengeTurn(a.id, challenge.id);
    await playChallengeTurn(b.id, challenge.id);

    const group = await prisma.group.create({ data: { ownerId: b.id, name: `History contract ${tag}`, description: 'fixture' } });
    await prisma.groupMember.createMany({ data: [
      { groupId: group.id, userId: b.id, role: 'OWNER', status: 'ACTIVE' },
      { groupId: group.id, userId: a.id, role: 'MEMBER', status: 'ACTIVE' },
    ] });
    const now = Date.now();
    const competition = await createCompetition(b.id, {
      groupId: group.id, gameKey: 'number_challenge', title: `History contract ${tag}`, entryAmount: 10,
      startsAt: new Date(now - 1000).toISOString(), endsAt: new Date(now + 3_600_000).toISOString(),
    });
    await joinCompetition(a.id, competition.id);
    await playCompetition(a.id, competition.id, { guess: 50 });
    await playCompetition(a.id, competition.id, { guess: 60 });

    const token = server.jwt.sign({ sub: a.id, roles: ['USER'], username: a.username, email: a.email! });
    const response = await server.inject({
      method: 'GET', url: `${config.API_PREFIX}/games/history?limit=100`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { success: boolean; data: Record<string, unknown>[]; meta: Record<string, unknown> };
    expect(body.success).toBe(true);
    expect(Object.keys(body.meta).sort()).toEqual(Object.keys(CONTRACT.meta).sort());

    // Every row the API answers has exactly the fields the web client reads.
    const contractKeys = Object.keys(CONTRACT.data[0]).sort();
    for (const row of CONTRACT.data) expect(Object.keys(row).sort()).toEqual(contractKeys);
    expect(body.data.length).toBe(3);
    for (const row of body.data) expect(Object.keys(row).sort()).toEqual(contractKeys);

    const contestRows = body.data.filter((row) => row.playContext === 'CHALLENGE_ROUND' || row.playContext === 'COMPETITION_ROUND');
    expect(contestRows.map((row) => row.playContext).sort()).toEqual(['CHALLENGE_ROUND', 'COMPETITION_ROUND', 'COMPETITION_ROUND']);
    for (const row of contestRows) {
      expect(row).toMatchObject({ betAmount: 0, settlementDebitCurrency: null, settlementCreditCurrency: null });
      expect(row.resultSchemaVersion).toEqual(expect.any(Number));
    }
    // The fixture's contest rows promise the web client exactly this.
    for (const row of CONTRACT.data.filter((r) => String(r.playContext).endsWith('_ROUND'))) {
      expect(row).toMatchObject({ betAmount: 0, settlementDebitCurrency: null, settlementCreditCurrency: null });
    }

    // The entry fees were paid once each, in Game Points, into the escrows.
    const entries = await prisma.walletTransaction.findMany({
      where: { userId: a.id, ledgerType: 'DEBIT' }, select: { currency: true, amount: true, description: true },
    });
    expect(entries.sort((x, y) => x.description!.localeCompare(y.description!))).toEqual([
      { currency: 'GAME_POINTS', amount: 10, description: 'Challenge entry: dice' },
      { currency: 'GAME_POINTS', amount: 10, description: `Competition entry: History contract ${tag}` },
    ]);
  });
});

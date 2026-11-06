import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import {
  TOGETHER_RULES_ID,
  TOGETHER_FEE_POLICY,
  togetherSeedCommitment,
  togetherTermsHash,
  togetherRosterHash,
  deriveTogetherOutcome,
  rankTogether,
  settleTogether,
  type TogetherRoundView,
} from '@socialplay/shared';
import { PUBLIC_PROOF } from '@/test/spin-public-proof-fixture';
import { verifyTogetherRound } from './together-proof';
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
});
afterEach(() => {
  vi.unstubAllGlobals();
});
export function verifiedRound(): TogetherRoundView {
  const seed = 'ab'.repeat(32);
  const round: TogetherRoundView = {
    id: 'group-proof-fixture',
    groupId: null,
    creatorId: null,
    groupName: null,
    game: 'spin_win',
    currency: 'ETB',
    entryAmount: 5000,
    feeBps: 700,
    settingsVersion: 1,
    minPlayers: 2,
    maxPlayers: 20,
    closesAt: PUBLIC_PROOF.commitment.closesAtMs,
    rulesId: TOGETHER_RULES_ID,
    feePolicy: TOGETHER_FEE_POLICY,
    seedCommitment: togetherSeedCommitment('group-proof-fixture', seed),
    beaconRound: 1,
    state: 'PAID',
    termsHash: '',
    rosterHash: null,
    entries: ['a', 'b', 'c'].map((id) => ({
      id,
      userId: 'user-' + id,
      username: 'Player ' + id,
      selection: [],
      state: 'SETTLED',
      amount: 5000,
      payout: 0,
      createdAt: 0,
      walletTransactionId: '',
      payoutTransactionId: null,
      requestId: null,
    })),
    outcome: null,
    ranking: [],
    settlement: null,
    voidReason: null,
    proof: { seed, beacon: structuredClone(PUBLIC_PROOF.reveal!.beacon) },
    recoveryDeadline: PUBLIC_PROOF.commitment.closesAtMs + 600000,
    paidAt: 1692803368000,
  };
  const tickets = round.entries.map((e) => ({ ...e, selection: [] }));
  round.termsHash = togetherTermsHash(round);
  round.rosterHash = togetherRosterHash(
    tickets.map(({ id, userId, selection }) => ({ id, userId, selection }))
  );
  round.outcome = deriveTogetherOutcome(round, tickets, round.proof!);
  round.ranking = rankTogether(round.game, tickets, round.outcome);
  round.settlement = settleTogether(round.entryAmount, round.feeBps, round.ranking, round.id);
  round.entries.forEach((e) => {
    e.payout = round.settlement!.payouts.find((p) => p.entryId === e.id)!.amount;
  });
  return round;
}
it('verifies a genuine signed beacon, locked roster, result and full payout offline', async () => {
  const round = verifiedRound(),
    fetch = vi.fn(() => {
      throw Error('No network allowed');
    });
  vi.stubGlobal('fetch', fetch);
  await expect(verifyTogetherRound(round, round.termsHash)).resolves.toContain(
    'Verified: saved terms'
  );
  expect(fetch).not.toHaveBeenCalled();
});
it.each([
  'terms',
  'seed',
  'beacon',
  'signature',
  'roster',
  'outcome',
  'payout',
  'receipt',
  'ranking',
])('rejects tampered %s', async (kind) => {
  const r = verifiedRound(),
    saved = r.termsHash;
  if (kind === 'terms') {
    r.feeBps = 100;
    r.termsHash = togetherTermsHash(r);
  }
  if (kind === 'seed') r.proof!.seed = 'cd'.repeat(32);
  if (kind === 'beacon') r.proof!.beacon.randomness = '00'.repeat(32);
  if (kind === 'signature') r.proof!.beacon.signature = '00'.repeat(48);
  if (kind === 'roster') r.entries[0].userId = 'different';
  if (kind === 'outcome') r.outcome!.numbers[0] = (r.outcome!.numbers[0] + 1) % 3;
  if (kind === 'payout') r.settlement!.payouts[0].amount++;
  if (kind === 'receipt') r.entries[0].payout!++;
  if (kind === 'ranking') r.ranking[0].score++;
  await expect(verifyTogetherRound(r, saved)).rejects.toThrow();
});

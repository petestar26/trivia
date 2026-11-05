import { fetchBeacon, type ChainClient } from 'drand-client';
import {
  QUICKNET_CHAIN_HASH,
  QUICKNET_CHAIN_INFO,
  quicknetTargetForCutoff,
  requireCanonicalQuicknetSignature,
  deriveTogetherOutcome,
  rankTogether,
  settleTogether,
  togetherTermsHash,
  togetherRosterHash,
  canonicalJson,
  type TogetherRoundView,
} from '@socialplay/shared';

export async function verifyTogetherRound(
  round: TogetherRoundView,
  savedTermsHash?: string | null
) {
  if (!round.proof || !round.outcome || !round.settlement)
    throw Error('The completed result is not available yet.');
  if (
    togetherTermsHash(round) !== round.termsHash ||
    (savedTermsHash && savedTermsHash !== round.termsHash)
  )
    throw Error('The published terms do not match the saved commitment.');
  const target = quicknetTargetForCutoff(round.closesAt);
  if (round.beaconRound !== target.beaconRound || round.proof.beacon.round !== target.beaconRound)
    throw Error('The randomness round differs from the published deadline.');
  requireCanonicalQuicknetSignature(round.proof.beacon.signature);
  const client: ChainClient = {
    options: {
      disableBeaconVerification: false,
      noCache: true,
      chainVerificationParams: {
        chainHash: QUICKNET_CHAIN_HASH,
        publicKey: QUICKNET_CHAIN_INFO.public_key,
      },
    },
    latest: async () => {
      throw Error('A substitute beacon is not allowed.');
    },
    get: async (n) => {
      if (n !== target.beaconRound) throw Error('Beacon differs.');
      return round.proof!.beacon;
    },
    chain: () => ({ baseUrl: 'offline:salem-group-proof', info: async () => QUICKNET_CHAIN_INFO }),
  };
  await fetchBeacon(client, target.beaconRound);
  const ids = new Set(round.settlement.payouts.map((p) => p.entryId));
  const tickets = round.entries
    .filter((e) => ids.has(e.id))
    .map((e) => ({
      id: e.id,
      userId: e.userId,
      selection: e.selection!,
    }));
  if (
    tickets.some((t) => !Array.isArray(t.selection)) ||
    togetherRosterHash(tickets) !== round.rosterHash
  )
    throw Error('The confirmed entries do not match the locked roster.');
  const result = deriveTogetherOutcome(round, tickets, round.proof);
  if (canonicalJson(result) !== canonicalJson(round.outcome))
    throw Error('The result does not match the verified draw.');
  const ranking = rankTogether(round.game, tickets, result);
  if (canonicalJson(ranking) !== canonicalJson(round.ranking))
    throw Error('Displayed player results differ.');
  const settlement = settleTogether(round.entryAmount, round.feeBps, ranking, round.id);
  if (canonicalJson(settlement) !== canonicalJson(round.settlement))
    throw Error('The payout calculation differs.');
  for (const payout of settlement.payouts) {
    const entry = round.entries.find((e) => e.id === payout.entryId);
    if (
      !entry ||
      entry.payout !== payout.amount ||
      entry.amount !== round.entryAmount ||
      entry.state !== (settlement.refunds ? 'REFUNDED' : 'SETTLED')
    )
      throw Error('The player receipt differs from the payout.');
  }
  return savedTermsHash
    ? 'Verified: saved terms, independent randomness, result and payouts match.'
    : 'Verified: the published terms, independent randomness, result and payouts match.';
}

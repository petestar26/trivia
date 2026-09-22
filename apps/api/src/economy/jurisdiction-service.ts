import { ApiError } from '../middleware';

export interface JurisdictionResolution {
  country: { id: string; code: string } | null;
  policy: {
    id: string;
    version: number;
    playthroughMultiplier: { toNumber(): number } | number;
    qualifyingGames: unknown;
    maxQualifyingStake: number;
    status: string;
  } | null;
}

export interface PlayableJurisdiction {
  countryCode: string;
  policy: {
    id: string;
    version: number;
    playthroughMultiplier: number;
    qualifyingGames: unknown;
    maxQualifyingStake: number;
  };
}

/**
 * Resolve the user's verified country and the active versioned casino policy
 * inside a solo Coin-play transaction — and LOCK both rows for the
 * remainder of this transaction.
 *
 * The user's country comes from EXACTLY ONE source: the user's own ACTIVE
 * UserPayoutAccount. There is deliberately no fallback to `Agent.countryId`.
 * `Agent` is a B2B reseller/distributor identity (see the Agent model) — it
 * proves where a reseller operates, not where the player who is actually
 * playing resides, and treating it as a jurisdiction signal would let any
 * player linked to an agent in a permissive country bypass every other
 * country's restrictions. A user with no ACTIVE payout account has no
 * verified jurisdiction, full stop, and resolves to
 * `{ country: null, policy: null }` — the caller is responsible for failing
 * closed (see requirePlayableJurisdiction).
 *
 * Both the payout-account/country row and the resolved policy row are read
 * with `FOR SHARE` inside the caller's transaction: a concurrent policy
 * disable, country reassignment, or account-status change must either
 * commit BEFORE this lock is acquired (in which case this transaction reads
 * the fresh, already-committed state) or wait behind this transaction until
 * it commits or rolls back — it can never land in the middle of settlement.
 */
export async function resolveJurisdictionForPlay(
  tx: any,
  userId: string
): Promise<JurisdictionResolution> {
  const accountRows = (await tx.$queryRaw`
    SELECT c."id" AS "countryId", c."code" AS "countryCode"
    FROM "user_payout_accounts" upa
    JOIN "countries" c ON c."id" = upa."countryId"
    WHERE upa."userId" = ${userId} AND upa."status" = 'ACTIVE'
    ORDER BY upa."createdAt" DESC
    LIMIT 1
    FOR SHARE
  `) as { countryId: string; countryCode: string }[];

  const account = accountRows[0];
  if (!account) return { country: null, policy: null };

  const country = { id: account.countryId, code: account.countryCode };

  const policyRows = (await tx.$queryRaw`
    SELECT "id", "version", "playthroughMultiplier", "qualifyingGames", "maxQualifyingStake",
           "status"::text AS "status"
    FROM "country_casino_policies"
    WHERE "countryCode" = ${country.code} AND "status" = 'ENABLED'
    ORDER BY "version" DESC
    LIMIT 1
    FOR SHARE
  `) as {
    id: string;
    version: number;
    playthroughMultiplier: unknown;
    qualifyingGames: unknown;
    maxQualifyingStake: number;
    status: string;
  }[];

  const policy = policyRows[0];
  if (!policy) return { country, policy: null };

  return {
    country,
    policy: {
      id: policy.id,
      version: policy.version,
      playthroughMultiplier: policy.playthroughMultiplier as { toNumber(): number },
      qualifyingGames: policy.qualifyingGames,
      maxQualifyingStake: policy.maxQualifyingStake,
      status: policy.status,
    },
  };
}

/**
 * Fail-closed gate. Throws ApiError.forbidden when the jurisdiction cannot be
 * resolved or the country has no ENABLED policy. Otherwise returns the
 * numeric playthroughMultiplier plus the qualifying-wager fields for the
 * resolved policy.
 */
export function requirePlayableJurisdiction(
  resolution: JurisdictionResolution
): PlayableJurisdiction {
  if (!resolution.country) {
    throw ApiError.forbidden('Jurisdiction could not be resolved; play is unavailable');
  }
  if (!resolution.policy) {
    throw ApiError.forbidden('Gaming is not available in your jurisdiction');
  }
  const rawMultiplier = resolution.policy.playthroughMultiplier;
  const playthroughMultiplier =
    typeof rawMultiplier === 'number' ? rawMultiplier : rawMultiplier.toNumber();
  return {
    countryCode: resolution.country.code,
    policy: {
      id: resolution.policy.id,
      version: resolution.policy.version,
      playthroughMultiplier: Number(playthroughMultiplier),
      qualifyingGames: resolution.policy.qualifyingGames,
      maxQualifyingStake: resolution.policy.maxQualifyingStake,
    },
  };
}

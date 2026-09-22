import { ApiError } from '../middleware';

export interface JurisdictionResolution {
  country: { id: string; code: string } | null;
  policy: {
    id: string;
    version: number;
    playthroughMultiplier: { toNumber(): number };
    status: string;
  } | null;
}

export interface PlayableJurisdiction {
  countryCode: string;
  policy: {
    id: string;
    version: number;
    playthroughMultiplier: number;
  };
}

/**
 * Resolve the user's verified country and the active versioned casino policy
 * inside a solo Coin-play transaction.
 *
 * Priority for the user's country:
 *   1. The user's ACTIVE UserPayoutAccount (join Country -> code).
 *   2. Fallback: the user's Agent.countryId (join Country -> code).
 *
 * Missing country resolves to { country: null, policy: null } — the caller is
 * responsible for failing closed (see requirePlayableJurisdiction).
 */
export async function resolveJurisdictionForPlay(
  tx: any,
  userId: string
): Promise<JurisdictionResolution> {
  const payoutAccount = await tx.userPayoutAccount.findFirst({
    where: { userId, status: 'ACTIVE' },
    select: { country: { select: { id: true, code: true } } },
    orderBy: { createdAt: 'desc' },
  });

  let country = payoutAccount?.country ?? null;

  if (!country) {
    const agent = await tx.agent.findUnique({
      where: { userId },
      select: { country: { select: { id: true, code: true } } },
    });
    country = agent?.country ?? null;
  }

  if (!country) return { country: null, policy: null };

  const policy = await tx.countryCasinoPolicy.findFirst({
    where: { countryCode: country.code, status: 'ENABLED' },
    select: { id: true, version: true, playthroughMultiplier: true, status: true },
    orderBy: { version: 'desc' },
  });

  return { country, policy: policy ?? null };
}

/**
 * Fail-closed gate. Throws ApiError.forbidden when the jurisdiction cannot be
 * resolved or the country has no ENABLED policy. Otherwise returns the numeric
 * playthroughMultiplier for the resolved policy.
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
  return {
    countryCode: resolution.country.code,
    policy: {
      id: resolution.policy.id,
      version: resolution.policy.version,
      playthroughMultiplier: Number(resolution.policy.playthroughMultiplier.toNumber()),
    },
  };
}
import { createHash } from 'crypto';

// ─── Canonical Selection Normalization ─────────────────────────
// Play requests carry client selections (guesses, trivia answers).
// For replay/fingerprinting they are serialized deterministically so
// the same logical request always yields the same SHA-256 fingerprint.

export function normalizeSelections(
  sel: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  if (!sel || typeof sel !== 'object' || Array.isArray(sel)) {
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(sel).sort()) {
    const value = sel[key];
    if (Array.isArray(value)) {
      out[key] = value.map((item) =>
        item && typeof item === 'object'
          ? normalizeSelections(item as Record<string, unknown>)
          : item
      );
    } else if (value && typeof value === 'object') {
      out[key] = normalizeSelections(value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export interface FingerprintParams {
  gameKey: string;
  rulesVersion: number | null;
  stake: number;
  selections?: Record<string, unknown> | null;
}

/**
 * SHA-256 hex fingerprint of the canonical request. Two requests that
 * differ only in how their selections were keyed/ordered produce the same
 * fingerprint; a request with a different stake, game, rules version or
 * selection set produces a different one.
 */
export function fingerprintPlay(params: FingerprintParams): string {
  const canonical = JSON.stringify({
    gameKey: params.gameKey,
    rulesVersion: params.rulesVersion ?? null,
    stake: params.stake,
    selections: normalizeSelections(params.selections ?? null),
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
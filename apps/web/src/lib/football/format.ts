/** Odds are stored in hundredths. Display is always truncated, never rounded up. */
export const formatOdds = (cents: number | null | undefined) =>
  cents === null || cents === undefined
    ? '—'
    : `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
export const formatCredits = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : n.toLocaleString('en-US');
export const formatClock = (ms: number) => {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

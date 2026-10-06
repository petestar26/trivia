/** Parse an integer field without silently rounding or truncating its value. */
export function parseWholeNumberInput(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;

  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function wholeNumberRangeError(
  value: string,
  min: number,
  max: number,
  label: string,
): string | null {
  const parsed = parseWholeNumberInput(value);
  if (parsed === null) return `${label} must be a whole number.`;
  if (parsed < min) return `${label} must be at least ${min}.`;
  if (parsed > max) return `${label} must be no more than ${max}.`;
  return null;
}

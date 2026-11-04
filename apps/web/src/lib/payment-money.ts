export function currencyMinorDigits(currency: string): number {
  return (
    new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions()
      .maximumFractionDigits ?? 2
  );
}

export function inputToMinor(value: string, digits: number): number | null {
  if (value.length > 20 || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > digits) return null;
  const n = BigInt(whole) * 10n ** BigInt(digits) + BigInt(fraction.padEnd(digits, '0') || '0');
  return n > 0n && n <= 2147483647n ? Number(n) : null;
}

export function formatMinor(
  value: string | number,
  currency: string,
  digits = currencyMinorDigits(currency)
): string {
  // Exact rendering also covers bigint withdrawal DTOs beyond safe JS integers.
  const signed = BigInt(value),
    n = signed < 0n ? -signed : signed,
    scale = 10n ** BigInt(digits);
  return `${signed < 0n ? '-' : ''}${n / scale}${digits ? '.' + (n % scale).toString().padStart(digits, '0') : ''} ${currency}`;
}

export function formatEtb(minor: string | number | null | undefined) {
  if (
    minor === null ||
    minor === undefined ||
    (typeof minor === 'number' ? !Number.isSafeInteger(minor) : !/^-?\d+$/.test(minor))
  )
    return '—';
  return formatMinor(minor, 'ETB', 2);
}

export function etbMinimumMinor(localPerUsd: string, usdCents: number, exclusive = false) {
  if (!/^\d+(?:\.\d{1,8})?$/.test(localPerUsd) || !Number.isSafeInteger(usdCents) || usdCents <= 0)
    return null;
  const [w, f = ''] = localPerUsd.split('.');
  const numerator = BigInt(w + f) * BigInt(usdCents),
    denominator = 10n ** BigInt(f.length);
  const n = exclusive ? numerator / denominator + 1n : (numerator + denominator - 1n) / denominator;
  return n > 0n && n <= 1_000_000_000n ? Number(n) : null;
}

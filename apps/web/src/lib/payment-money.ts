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
  const n = BigInt(value),
    scale = 10n ** BigInt(digits);
  return `${n / scale}${digits ? '.' + (n % scale).toString().padStart(digits, '0') : ''} ${currency}`;
}

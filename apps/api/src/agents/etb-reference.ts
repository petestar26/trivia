/** Public reference feed. This is a quote source, not a money-transfer service. */
export const ETB_REFERENCE_URL = 'https://ethioblackmarket.com/api/latest-prices?period=all';
export const ETB_REFERENCE_SOURCE = 'https://ethioblackmarket.com/';
export const ETB_REFRESH_MS = 15 * 60_000;
export const ETB_MAX_AGE_MS = 30 * 60_000;

export type EtbReference = { localPerUsd: string; observedAt: string; expiresAt: string };

export function parseEtbReference(
  value: unknown,
  now = new Date(),
  previous?: string
): EtbReference {
  const body = value as {
    usdCurrentBlackPrice?: unknown;
    allLastprice?: { USD?: unknown };
    historicalPrices?: { time?: unknown; value?: { USD?: unknown } }[];
  } | null;
  const current = body?.usdCurrentBlackPrice;
  if (
    typeof current !== 'number' ||
    !Number.isFinite(current) ||
    current <= 0 ||
    current > 100_000 ||
    body?.allLastprice?.USD !== current ||
    !Array.isArray(body.historicalPrices) ||
    !body.historicalPrices.length ||
    body.historicalPrices.length > 10_000
  ) {
    throw new Error('Invalid ETB reference response');
  }
  // Never substitute our fetch time for the source's observation time.
  const latest = body.historicalPrices.reduce((a, b) => (Number(b.time) > Number(a.time) ? b : a));
  if (
    typeof latest.time !== 'number' ||
    !Number.isSafeInteger(latest.time) ||
    latest.time <= 0 ||
    latest.value?.USD !== current
  )
    throw new Error('ETB reference timestamp does not match the price');
  const observed = latest.time * 1000;
  if (observed > now.getTime() || now.getTime() - observed >= ETB_MAX_AGE_MS) {
    throw new Error('ETB reference is stale or future-dated');
  }
  // A sudden 10% move needs an operator's investigation, not automatic repricing.
  if (previous && Math.abs(current / Number(previous) - 1) > 0.1) {
    throw new Error('ETB reference movement requires review');
  }
  const localPerUsd = current.toFixed(8);
  if (Number(localPerUsd) <= 0) throw new Error('ETB reference precision is invalid');
  return {
    localPerUsd,
    observedAt: new Date(observed).toISOString(),
    expiresAt: new Date(observed + ETB_MAX_AGE_MS).toISOString(),
  };
}

export async function fetchEtbReference(
  now = new Date(),
  previous?: string,
  fetcher: typeof fetch = fetch
) {
  const response = await fetcher(ETB_REFERENCE_URL, {
    headers: { Accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('ETB reference provider is unavailable');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('ETB reference response is empty');
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2_000_000) throw new Error('ETB reference response is too large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return parseEtbReference(JSON.parse(Buffer.concat(chunks).toString('utf8')), now, previous);
}

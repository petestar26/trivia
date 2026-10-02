/**
 * Minimal TypeSafe HTTP client shared by the pilot runners. Credentials come from
 * TYPESAFE_API_KEY (Bearer) when set; otherwise no auth header is sent, which works only where a
 * proxy injects credentials. The key is never logged or returned.
 */
export const DEFAULT_BASE = 'https://api.typesafe.ai';
export const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function callOnce(
  body,
  { base = process.env.TYPESAFE_API_BASE ?? DEFAULT_BASE } = {}
) {
  const headers = { 'content-type': 'application/json' };
  if (process.env.TYPESAFE_API_KEY)
    headers.authorization = `Bearer ${process.env.TYPESAFE_API_KEY}`;
  const started = performance.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/v1/systemone`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* keep text */
    }
    return {
      status: res.status,
      latencyMs: Math.round(performance.now() - started),
      json,
      text: json ? undefined : text.slice(0, 500),
    };
  } catch (err) {
    return {
      status: 0,
      latencyMs: Math.round(performance.now() - started),
      error: String(err?.cause?.code ?? err?.message ?? err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Retries only transient failures (network error, 429, 5xx); a 4xx or a bad 200 is not retried. */
export async function callWithRetry(body, opts) {
  let last;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    last = await callOnce(body, opts);
    const transient = last.status === 0 || last.status === 429 || last.status >= 500;
    if (!transient) return { ...last, attempts: attempt };
    if (attempt < MAX_ATTEMPTS) await sleep(1000 * 2 ** (attempt - 1));
  }
  return { ...last, attempts: MAX_ATTEMPTS };
}

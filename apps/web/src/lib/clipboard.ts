export type CopyOutcome = 'copied' | 'failed' | 'unavailable';

/**
 * Copy text to the clipboard and report what happened, without ever throwing.
 *
 * - 'unavailable': there is no async clipboard to ask (an insecure context, an
 *   old or embedded browser). Nothing was attempted.
 * - 'failed': the browser refused (permission denied, no user activation, the
 *   document not focused).
 *
 * The two are told apart because the honest recovery message differs, but
 * neither is an exceptional condition for the caller: it always gets a value.
 */
export async function copyText(text: string): Promise<CopyOutcome> {
  if (typeof navigator === 'undefined' || typeof navigator.clipboard?.writeText !== 'function') {
    return 'unavailable';
  }
  try {
    await navigator.clipboard.writeText(text);
    return 'copied';
  } catch {
    return 'failed';
  }
}

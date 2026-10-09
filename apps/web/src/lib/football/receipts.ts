import { parseTicketInput, type LineInput, type TicketInput } from '@socialplay/shared';

/** A confirmation that was sent but may not have reached the server. Retried verbatim. */
export interface PendingReceipt {
  idempotencyKey: string;
  matchweekId: string;
  rulesId: string;
  lines: LineInput[];
}

const memory = new Map<string, string>();
const storageKey = (userId: string) => `playqube.vf3d.pending.${userId}`;

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function savePending(userId: string, receipt: PendingReceipt): void {
  const text = JSON.stringify(receipt);
  memory.set(userId, text);
  try {
    storage()?.setItem(storageKey(userId), text);
  } catch {
    /* in-memory copy still protects this session */
  }
}

export function clearPending(userId: string): void {
  memory.delete(userId);
  try {
    storage()?.removeItem(storageKey(userId));
  } catch {
    /* nothing to do */
  }
}

/** Strictly re-validates whatever is stored. Returns 'unreadable' instead of guessing. */
export function loadPending(userId: string): PendingReceipt | null | 'unreadable' {
  let text: string | null = null;
  try {
    text = storage()?.getItem(storageKey(userId)) ?? null;
  } catch {
    text = null;
  }
  text ??= memory.get(userId) ?? null;
  if (text === null) return null;
  try {
    const parsed: TicketInput = parseTicketInput(JSON.parse(text));
    return {
      idempotencyKey: parsed.idempotencyKey,
      matchweekId: parsed.matchweekId,
      rulesId: parsed.rulesId,
      lines: parsed.lines,
    };
  } catch {
    clearPending(userId);
    return 'unreadable';
  }
}

/** 128 bits of browser randomness; refuses to continue rather than weaken the key. */
export function newReceiptKey(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function')
    throw new Error('Secure randomness is unavailable in this browser');
  crypto.getRandomValues(bytes);
  return `vf-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

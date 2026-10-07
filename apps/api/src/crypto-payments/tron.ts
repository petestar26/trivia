import { createHash } from 'node:crypto';
import { z } from 'zod';

export const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
export const TRANSFER_TOPIC = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const sha = (v: Buffer) => createHash('sha256').update(v).digest();
/** Base58Check, TRON mainnet prefix, canonical length; no private keys. */
export function tronHex(address: string): string {
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) throw new Error('Invalid TRON address');
  let n = 0n;
  for (const c of address) n = n * 58n + BigInt(alphabet.indexOf(c));
  const bytes = Buffer.from(n.toString(16).padStart(50, '0'), 'hex');
  if (
    bytes.length !== 25 ||
    bytes[0] !== 0x41 ||
    !sha(sha(bytes.subarray(0, 21)))
      .subarray(0, 4)
      .equals(bytes.subarray(21))
  ) {
    throw new Error('Invalid TRON address checksum');
  }
  if (bytes.subarray(1, 21).every((v) => v === 0))
    throw new Error('Zero address is not a payment destination');
  return bytes.subarray(1, 21).toString('hex');
}
export function validAddress(address: string): boolean {
  try {
    tronHex(address);
    return address !== USDT_CONTRACT;
  } catch {
    return false;
  }
}
export function parseUsdt(value: string): bigint {
  if (!/^(?:0|[1-9]\d{0,7})(?:\.\d{1,6})?$/.test(value))
    throw new Error('Enter USDT with at most six decimal places');
  const [whole, fraction = ''] = value.split('.');
  const amount = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  if (amount <= 0n) throw new Error('USDT amount must be positive');
  return amount;
}
export function formatUsdt(amount: bigint): string {
  return `${amount / 1_000_000n}.${(amount % 1_000_000n).toString().padStart(6, '0')}`;
}
export function depositCoins(amount: bigint): number {
  const coins = (amount * 96n) / 1_000_000n;
  if (coins <= 0n || coins > 1_000_000_000n) throw new Error('Amount is outside supported limits');
  return Number(coins);
}
export function withdrawalUsdt(coins: number): bigint {
  if (!Number.isSafeInteger(coins) || coins <= 0 || coins > 1_000_000_000)
    throw new Error('Invalid Coin amount');
  return (BigInt(coins) * 1_000_000n) / 96n;
}
const hash = z
  .string()
  .regex(/^[a-fA-F0-9]{64}$/)
  .transform((v) => v.toLowerCase());
const receiptSchema = z.object({
  id: hash,
  blockNumber: z.number().int().positive().safe(),
  blockTimeStamp: z.number().int().positive().safe(),
  receipt: z.object({ result: z.literal('SUCCESS') }),
  log: z
    .array(z.object({ address: z.string(), topics: z.array(z.string()), data: z.string() }))
    .max(5000),
});
export type Transfer = {
  txHash: string;
  logIndex: number;
  amount: bigint;
  blockNumber: number;
  blockTime: Date;
  fromHex: string;
};
/** Accept only a successful solidified receipt and the pinned token's actual Transfer logs. */
export function receiptTransfers(value: unknown, txHash: string, destination: string): Transfer[] {
  const r = receiptSchema.parse(value);
  if (r.id !== txHash.toLowerCase()) throw new Error('Receipt transaction mismatch');
  const contract = tronHex(USDT_CONTRACT),
    to = tronHex(destination);
  return r.log.flatMap((log, logIndex) => {
    if (
      log.address.toLowerCase() !== contract ||
      log.topics.length !== 3 ||
      log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC
    )
      return [];
    if (
      !log.topics.slice(1).every((t) => /^0{24}[a-fA-F0-9]{40}$/.test(t)) ||
      !/^[a-fA-F0-9]{64}$/.test(log.data)
    )
      throw new Error('Malformed transfer log');
    if (log.topics[2].slice(24).toLowerCase() !== to) return [];
    const amount = BigInt(`0x${log.data}`);
    if (amount <= 0n || amount > 9223372036854775807n)
      throw new Error('Transfer amount outside supported range');
    return [
      {
        txHash: r.id,
        logIndex,
        amount,
        blockNumber: r.blockNumber,
        blockTime: new Date(r.blockTimeStamp),
        fromHex: log.topics[1].slice(24).toLowerCase(),
      },
    ];
  });
}

/** Discovery is not evidence. Every returned transaction is independently fetched from solidity. */
export class TronGrid {
  constructor(
    private apiKey: string,
    private fetcher: typeof fetch = fetch
  ) {
    if (!apiKey) throw new Error('TRONGRID_API_KEY is required');
  }
  private async request(path: string, body?: unknown): Promise<unknown> {
    const response = await this.fetcher(`https://api.trongrid.io${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'TRON-PRO-API-KEY': this.apiKey, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`TRON provider unavailable (${response.status})`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Missing provider body');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 2_000_000) throw new Error('Provider response too large');
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  async discover(address: string, since: Date, until: Date, fingerprint?: string) {
    tronHex(address);
    const params = new URLSearchParams({
      only_confirmed: 'true',
      only_to: 'true',
      contract_address: USDT_CONTRACT,
      limit: '200',
      order_by: 'block_timestamp,asc',
      min_timestamp: String(since.getTime()),
      max_timestamp: String(until.getTime()),
    });
    if (fingerprint) params.set('fingerprint', fingerprint);
    const result = z
      .object({
        success: z.literal(true),
        data: z.array(z.object({ transaction_id: hash })).max(200),
        meta: z.object({ fingerprint: z.string().max(4096).optional() }).optional(),
      })
      .parse(await this.request(`/v1/accounts/${address}/transactions/trc20?${params}`));
    return {
      hashes: [...new Set(result.data.map((r) => r.transaction_id))],
      next: result.meta?.fingerprint,
    };
  }
  async transfers(txHash: string, address: string) {
    hash.parse(txHash);
    return receiptTransfers(
      await this.request('/walletsolidity/gettransactioninfobyid', {
        value: txHash,
        visible: false,
      }),
      txHash,
      address
    );
  }
}

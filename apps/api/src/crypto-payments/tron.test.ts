import { describe, it, expect, vi } from 'vitest';
import {
  tronHex,
  validAddress,
  USDT_CONTRACT,
  TRANSFER_TOPIC,
  parseUsdt,
  formatUsdt,
  depositCoins,
  withdrawalUsdt,
  receiptTransfers,
  TronGrid,
} from './tron.js';
const address = 'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7';
const txHash = 'ab'.repeat(32);
const receipt = () => ({
  id: txHash,
  blockNumber: 100,
  blockTimeStamp: Date.now(),
  receipt: { result: 'SUCCESS' },
  log: [
    {
      address: tronHex(USDT_CONTRACT),
      topics: [TRANSFER_TOPIC, '0'.repeat(24) + '12'.repeat(20), '0'.repeat(24) + tronHex(address)],
      data: 10_000_000n.toString(16).padStart(64, '0'),
    },
  ],
});
it('validates full TRON checksum and rejects token-contract, malformed and other network destinations', () => {
  expect(tronHex(USDT_CONTRACT)).toBe('a614f803b6fd780986a42c78ec9c7f77e6ded13c');
  expect(validAddress(address)).toBe(true);
  for (const a of [
    USDT_CONTRACT,
    address.slice(0, -1) + '8',
    `0x${'11'.repeat(20)}`,
    'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb',
    address.toLowerCase(),
    ' ' + address,
  ])
    expect(validAddress(a)).toBe(false);
});
it('converts decimal amounts with exact integer arithmetic and bounded rounding', () => {
  expect(parseUsdt('10.000001')).toBe(10_000_001n);
  expect(formatUsdt(10_000_001n)).toBe('10.000001');
  expect(depositCoins(parseUsdt('10'))).toBe(960);
  expect(depositCoins(parseUsdt('10.010416'))).toBe(960);
  expect(withdrawalUsdt(2017)).toBe(21_010_416n);
  expect(() => withdrawalUsdt(2.5)).toThrow();
  expect(() => depositCoins(parseUsdt('99999999'))).toThrow();
  for (const v of ['0', '-1', '1e3', 'NaN', '10.0000001', '01', '1,000', ' 10', 'Infinity'])
    expect(() => parseUsdt(v)).toThrow();
});
it('accepts only exact USDT destination logs from a successful solidified receipt', () => {
  expect(receiptTransfers(receipt(), txHash, address)).toEqual([
    {
      txHash,
      logIndex: 0,
      amount: 10_000_000n,
      blockNumber: 100,
      blockTime: expect.any(Date),
      fromHex: '12'.repeat(20),
    },
  ]);
  const wrong = receipt();
  wrong.log[0].address = 'ff'.repeat(20);
  expect(receiptTransfers(wrong, txHash, address)).toEqual([]);
  const other = receipt();
  other.log[0].topics[2] = '0'.repeat(24) + '13'.repeat(20);
  expect(receiptTransfers(other, txHash, address)).toEqual([]);
  expect(() =>
    receiptTransfers({ ...receipt(), receipt: { result: 'REVERT' } }, txHash, address)
  ).toThrow();
  expect(() => receiptTransfers({}, txHash, address)).toThrow();
  expect(() => receiptTransfers(receipt(), 'cd'.repeat(32), address)).toThrow();
  const malformed = receipt();
  malformed.log[0].data = 'xyz';
  expect(() => receiptTransfers(malformed, txHash, address)).toThrow();
});
it('pins endpoint, token, finality, time window and bounded provider errors', async () => {
  const fetcher = vi
    .fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
    .mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: [{ transaction_id: txHash }],
          meta: { fingerprint: 'next' },
        })
      )
    );
  const provider = new TronGrid('fixture-api-key', fetcher);
  const since = new Date(1000),
    until = new Date(2000);
  expect(await provider.discover(address, since, until)).toEqual({
    hashes: [txHash],
    next: 'next',
  });
  const url = new URL(fetcher.mock.calls[0][0] as string);
  expect(url.origin).toBe('https://api.trongrid.io');
  expect(url.searchParams.get('contract_address')).toBe(USDT_CONTRACT);
  expect(url.searchParams.get('only_confirmed')).toBe('true');
  expect(url.searchParams.get('max_timestamp')).toBe('2000');
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify(receipt())));
  await provider.transfers(txHash, address);
  expect(fetcher.mock.calls[1][0]).toBe(
    'https://api.trongrid.io/walletsolidity/gettransactioninfobyid'
  );
  expect(fetcher.mock.calls[1][1]).toMatchObject({
    redirect: 'error',
    body: JSON.stringify({ value: txHash, visible: false }),
  });
  fetcher.mockResolvedValueOnce(new Response('{}', { status: 429 }));
  await expect(provider.discover(address, since, until)).rejects.toThrow('429');
  fetcher.mockResolvedValueOnce(new Response('x'.repeat(2_000_001)));
  await expect(provider.discover(address, since, until)).rejects.toThrow('too large');
});

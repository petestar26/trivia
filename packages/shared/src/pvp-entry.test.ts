import { expect, it } from 'vitest';
import { PVP_GAME_POLICY } from './house-game-policy.js';
import { quotePvpEntry } from './pvp-entry.js';

it('discloses the complete entry split and full void refund as JSON-safe units', () => {
  const quote = quotePvpEntry(PVP_GAME_POLICY.id, '100');
  expect(JSON.parse(JSON.stringify(quote))).toEqual({
    policyId: 'pvp-entry-fee7-v1', entryAmount: '100', platformFee: '7',
    prizeContribution: '93', voidRefundAmount: '100',
    feeChargeOn: 'COMPLETED_CONTEST', additionalWinnerFeeBps: 0,
  });
  expect(Object.isFrozen(quote)).toBe(true);
});

it('keeps exact amounts beyond JavaScript safe integers', () => {
  const quote = quotePvpEntry(PVP_GAME_POLICY.id, '9223372036854775800');
  expect(quote.platformFee).toBe('645636042579834306');
  expect(quote.prizeContribution).toBe('8577735994274941494');
  expect(BigInt(quote.platformFee) + BigInt(quote.prizeContribution)).toBe(BigInt(quote.entryAmount));
});

it.each(['0', '-100', '100.0', '1e2', '0100', ' 100', '100 ', '100\n', '100\r\n', '', '20', '150',
  '9223372036854775808', '10000000000000000000', 100, null, undefined])(
  'rejects invalid or inexact entry %j', (amount) => {
    expect(() => quotePvpEntry(PVP_GAME_POLICY.id, amount as string)).toThrow(RangeError);
  },
);

it.each(['scheduled-economics-v1', 'unknown', '', null])('requires the exact disclosed policy %j', (policy) => {
  expect(() => quotePvpEntry(policy as string, '100')).toThrow('Unsupported PVP entry policy');
});

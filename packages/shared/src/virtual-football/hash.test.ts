import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from './hash.js';

describe('pure SHA-256', () => {
  it('matches node:crypto across padding boundaries and unicode', () => {
    for (const length of [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 1000]) {
      const bytes = randomBytes(length);
      expect(sha256Hex(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'));
    }
    for (const text of ['', 'abc', 'Ünïcödé ⚽ 日本語', 'vf3d|x'.repeat(40)])
      expect(sha256Hex(text)).toBe(createHash('sha256').update(text).digest('hex'));
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });
});

describe('canonical JSON', () => {
  it('is independent of key order and rejects non-integers', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 'x', c: null }] })).toBe(
      '{"a":[2,{"c":null,"d":"x"}],"b":1}'
    );
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(() => canonicalJson({ a: 1.5 })).toThrow();
    expect(() => canonicalJson({ a: () => 1 })).toThrow();
  });
});

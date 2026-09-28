import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  LABELS,
  evaluateShortlist,
  jaccard,
  parseSeedQuestions,
  tokenize,
  validate,
} from './evaluate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync(join(HERE, 'pairs.json'), 'utf8'));
const seedSource = readFileSync(
  join(HERE, '..', '..', 'packages', 'database', 'prisma', 'seed.ts'),
  'utf8'
);

test('tokenize strips set suffixes, stopwords and plurals', () => {
  assert.deepEqual(
    [...tokenize('How many strings does a standard guitar have? (set 3)')],
    ['many', 'string', 'standard', 'guitar']
  );
  assert.ok(tokenize('What is 15% of 200?').has('percent'));
});

test('jaccard basics', () => {
  assert.equal(jaccard(new Set(['a']), new Set(['a'])), 1);
  assert.equal(jaccard(new Set(['a']), new Set(['b'])), 0);
  assert.equal(jaccard(new Set(), new Set()), 0);
});

test('seed.ts parser finds the base pool', () => {
  assert.equal(parseSeedQuestions(seedSource).length, 20);
});

test('shipped pair set validates against seed.ts', () => {
  assert.deepEqual(validate(data, parseSeedQuestions(seedSource)), []);
});

test('every label is used and every pair label is known', () => {
  for (const label of LABELS)
    assert.ok(
      data.pairs.some((p) => p.label === label),
      label
    );
});

test('validate catches broken data', () => {
  const bad = {
    questions: [
      { id: 'a', question: 'Q?', choices: ['x', 'y'], correctIndex: 5, source: 'handwritten' },
      { id: 'a', question: 'Q2?', choices: ['x', 'x'], correctIndex: 0, source: 'handwritten' },
    ],
    pairs: [
      { id: 'p1', candidate: 'a', existing: 'zzz', label: 'nope' },
      { id: 'p2', candidate: 'a', existing: 'a', label: 'duplicate_question' },
    ],
  };
  const errors = validate(bad).join('\n');
  for (const needle of [
    'duplicate question id',
    'correctIndex out of range',
    'repeated choice',
    'unknown label',
    'unknown existing',
    'with itself',
  ]) {
    assert.ok(errors.includes(needle), needle);
  }
});

test('shortlist recall is deterministic and exact-copy variants rank first', () => {
  const a = evaluateShortlist(data, [1, 10]);
  const b = evaluateShortlist(data, [1, 10]);
  assert.deepEqual(a, b);
  const variants = a.rows.filter((r) => r.label === 'seed_variant');
  assert.ok(variants.every((r) => r.forwardRank <= 3));
});

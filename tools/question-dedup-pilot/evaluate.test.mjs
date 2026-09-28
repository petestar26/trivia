import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  LABELS,
  SPLITS,
  answerGuard,
  answerInText,
  buildAnswerGuards,
  containsSequence,
  evaluateShortlist,
  jaccard,
  parseSeedQuestions,
  prepare,
  rankPairs,
  tokenList,
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

test('every pair has a known split and both splits are populated for each label', () => {
  for (const p of data.pairs) assert.ok(SPLITS.includes(p.split), p.id);
  for (const split of SPLITS) {
    for (const label of LABELS) {
      assert.ok(
        data.pairs.some((p) => p.split === split && p.label === label),
        `${split}/${label}`
      );
    }
  }
});

test('validate rejects a missing split', () => {
  const bad = {
    questions: [
      { id: 'a', question: 'Q?', choices: ['x', 'y'], correctIndex: 0 },
      { id: 'b', question: 'R?', choices: ['x', 'y'], correctIndex: 0 },
    ],
    pairs: [{ id: 'p1', candidate: 'a', existing: 'b', label: 'duplicate_question' }],
  };
  assert.ok(validate(bad).join('\n').includes('split must be one of'));
});

test('summary reports labels separately with no blended overall', () => {
  const { summary } = evaluateShortlist(data, [3]);
  assert.deepEqual(Object.keys(summary), SPLITS);
  for (const split of SPLITS) assert.deepEqual(Object.keys(summary[split]), LABELS);
});

const q = (id, question, choices, correctIndex = 0) => ({ id, question, choices, correctIndex });

test('containsSequence matches whole tokens only', () => {
  assert.ok(containsSequence(tokenList('What is 12 x 12?'), ['12']));
  assert.ok(!containsSequence(tokenList('What is 120 x 3?'), ['12']));
  assert.ok(containsSequence(tokenList('Painted by Leonardo Da Vinci'), ['da', 'vinci']));
  assert.ok(!containsSequence(tokenList('Da Something Vinci'), ['da', 'vinci']));
});

test('answerInText fires in either direction and respects guards', () => {
  const a = prepare(q('a', 'What is the square root of 144?', ['12', '10']));
  const b = prepare(q('b', 'What is 12 x 12?', ['144', '124']));
  const guards = new Map([
    ['a', null],
    ['b', null],
  ]);
  const hit = answerInText(a, b, guards);
  assert.ok(hit.aInB && hit.bInA && hit.either);
  const oneWay = prepare(q('c', 'How many days are in a leap year?', ['366', '365']));
  const stemHasIt = prepare(q('d', 'Is 366 days the length of a leap year?', ['Yes', 'No']));
  const r = answerInText(
    oneWay,
    stemHasIt,
    new Map([
      ['c', null],
      ['d', null],
    ])
  );
  assert.ok(r.aInB && !r.bInA);
  assert.ok(
    !answerInText(
      a,
      b,
      new Map([
        ['a', 'too-short'],
        ['b', 'too-short'],
      ])
    ).either
  );
});

test('guards ignore single characters, single digits and very common answers', () => {
  assert.equal(answerGuard(tokenList('D'), 1, 100), 'too-short');
  assert.equal(answerGuard(tokenList('7'), 1, 100), 'too-short');
  assert.equal(answerGuard(tokenList('12'), 1, 100), null);
  assert.equal(answerGuard(tokenList('Earth'), 30, 100), 'too-common');
  assert.equal(answerGuard(tokenList('Earth'), 2, 100), null);
  assert.equal(answerGuard([], 0, 100), 'empty');
  // a small pool never lets the cap drop below the floor
  assert.equal(answerGuard(tokenList('Earth'), 3, 10), null);
});

test('a single-digit answer inside another stem does not cause a match', () => {
  const pool = new Map(
    [
      q('a', 'How many sides does a hexagon have?', ['5', '6']),
      q('b', 'A 6 sided die is what shape?', ['Cube', 'Sphere']),
    ].map((x) => [x.id, prepare(x)])
  );
  const guards = buildAnswerGuards(pool);
  assert.equal(guards.get('a'), 'too-short'); // answer "5"
  assert.ok(!answerInText(pool.get('a'), pool.get('b'), guards).either);
});

test('trap: a common-word answer is guarded in the real pool', () => {
  const prepared = new Map(data.questions.map((x) => [x.id, prepare(x)]));
  const guards = buildAnswerGuards(prepared);
  const earth = data.questions.find((x) => x.question === 'Which planet do humans live on?');
  assert.equal(guards.get(earth.id), 'too-common');
});

// Regression tests only: the answer-in-text rule was motivated by p027 and p028, so passing them
// is not evidence that the rule generalizes. The holdout split is the (weak) generalization check.
test('regression: p027 and p028 are missed without the signal and found with it', () => {
  const withLeak = rankPairs(data, { leak: true, guards: true }).rows;
  const without = rankPairs(data, { leak: false, guards: true }).rows;
  for (const id of ['p027', 'p028']) {
    assert.ok(without.find((r) => r.id === id).forwardRank > 10, `${id} baseline`);
    const row = withLeak.find((r) => r.id === id);
    assert.ok(row.forwardRank <= 10, `${id} with signal`);
    assert.ok(row.leakFires, `${id} fires the signal`);
  }
});

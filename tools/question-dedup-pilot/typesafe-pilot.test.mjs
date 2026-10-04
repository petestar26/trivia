import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyze, latestGood } from './analyze-judgments.mjs';
import { LABELS } from './evaluate.mjs';
import {
  QUESTIONS,
  THRESHOLDS,
  buildRequest,
  buildState,
  isSeedVariantByRule,
  readProbabilities,
  samplePairIds,
  verdictFor,
} from './typesafe-questions.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync(join(HERE, 'pairs.json'), 'utf8'));
const byId = new Map(data.questions.map((q) => [q.id, q]));
const pair = (id) => data.pairs.find((p) => p.id === id);

test('thresholds and question set are the ones declared before the run', () => {
  assert.deepEqual(THRESHOLDS, { high: 0.9, review: 0.4, sameAnswerMin: 0.8 });
  assert.deepEqual(Object.keys(QUESTIONS), ['same_fact', 'same_answer', 'leakage']);
  for (const q of Object.values(QUESTIONS)) assert.equal(q.type, 'noul');
});

test('the request state is neutral: no ids, labels, splits, categories or notes', () => {
  const p = pair('p001');
  const body = JSON.stringify(buildRequest(byId.get(p.candidate), byId.get(p.existing)));
  for (const leak of [
    p.id,
    p.candidate,
    p.existing,
    p.label,
    p.split,
    'category',
    'source',
    'candidate',
    'existing',
  ]) {
    assert.ok(!body.includes(`"${leak}"`) && !body.includes(leak + '"'), `state leaks ${leak}`);
  }
  assert.deepEqual(Object.keys(buildState(byId.get(p.candidate), byId.get(p.existing))), [
    'question_a',
    'question_b',
  ]);
});

test('verdict priority and inclusive boundaries', () => {
  const v = (same_fact, same_answer, leakage, extra) =>
    verdictFor({ same_fact, same_answer, leakage }, extra);
  assert.equal(v(0.9, 0.8, 0.1), 'duplicate');
  assert.equal(v(0.9, 0.79, 0.95), 'leakage'); // same fact but answers differ: not a duplicate
  assert.equal(v(0.5, 0.9, 0.9), 'leakage');
  assert.equal(v(0.4, 0.1, 0.1), 'review');
  assert.equal(v(0.1, 0.1, 0.4), 'review');
  assert.equal(v(0.39, 0.99, 0.39), 'distinct');
  assert.equal(v(0.99, 0.99, 0.99, { seedVariantByRule: true }), 'seed_variant');
  assert.equal(verdictFor(null), 'error');
});

test('readProbabilities rejects incomplete or mistyped answers', () => {
  const ok = {
    answers: Object.fromEntries(
      Object.keys(QUESTIONS).map((n) => [n, { type: 'noul', noul: 0.5 }])
    ),
  };
  assert.deepEqual(readProbabilities(ok), { same_fact: 0.5, same_answer: 0.5, leakage: 0.5 });
  assert.equal(readProbabilities({ answers: { same_fact: { type: 'noul', noul: 0.5 } } }), null);
  assert.equal(
    readProbabilities({ answers: { ...ok.answers, leakage: { type: 'score', noul: 0.5 } } }),
    null
  );
  assert.equal(readProbabilities(undefined), null);
});

test('seed-copy code rule needs a suffix, matching text and identical choices', () => {
  const rule = (id) =>
    isSeedVariantByRule(byId.get(pair(id).candidate), byId.get(pair(id).existing));
  const variants = data.pairs.filter((p) => p.label === 'seed_variant');
  assert.ok(variants.every((p) => rule(p.id)));
  const others = data.pairs.filter((p) => p.label !== 'seed_variant');
  assert.ok(
    others.every((p) => !rule(p.id)),
    'no non-variant pair may match the rule'
  );
  const q = { question: 'Same?', choices: ['a', 'b'], correctIndex: 0 };
  assert.ok(
    !isSeedVariantByRule(q, { ...q }),
    'exact text without a suffix is a real duplicate, not a seed copy'
  );
});

test('sample is deterministic and stratified: 3 dev pairs per label', () => {
  const ids = samplePairIds(data.pairs, LABELS);
  assert.deepEqual(ids, samplePairIds(data.pairs, LABELS));
  assert.equal(ids.length, 12);
  for (const label of LABELS) {
    assert.equal(
      ids.filter((id) => pair(id).label === label && pair(id).split === 'dev').length,
      3
    );
  }
});

const fakeRow = (p, probs, ok = true) => ({
  pairId: p.id,
  ok,
  latencyMs: 100,
  response: ok
    ? {
        model: 'm',
        usage: { input_tokens: 600, output_tokens: 50 },
        answers: Object.fromEntries(
          Object.entries(probs).map(([k, v]) => [k, { type: 'noul', noul: v }])
        ),
      }
    : undefined,
});

test('analyze counts verdicts by split and label and ignores failed rows', () => {
  const dup = pair('p001');
  const rel = data.pairs.find((p) => p.label === 'related_distinct' && p.split === 'dev');
  const rows = [
    fakeRow(dup, { same_fact: 0.99, same_answer: 0.99, leakage: 0.95 }),
    fakeRow(rel, { same_fact: 0.95, same_answer: 0.95, leakage: 0.95 }), // a false positive
    { pairId: 'p002', ok: false, status: 500 },
  ];
  const a = analyze(rows, data);
  assert.equal(a.pairsJudged, 2);
  assert.equal(a.failedRequests, 1);
  assert.equal(a.cells.dev.duplicate_question.counts.duplicate, 1);
  assert.equal(a.cells.dev.related_distinct.counts.duplicate, 1);
  assert.equal(latestGood(rows).size, 2);
});

test('committed raw results cover every labeled pair exactly once, all ok, no credentials', () => {
  const text = readFileSync(join(HERE, 'results', 'raw-judgments.jsonl'), 'utf8');
  assert.ok(!/authorization|bearer /i.test(text));
  const rows = text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  assert.equal(rows.length, data.pairs.length);
  assert.deepEqual(new Set(rows.map((r) => r.pairId)), new Set(data.pairs.map((p) => p.id)));
  assert.ok(rows.every((r) => r.ok && r.response.model && readProbabilities(r.response) !== null));
});

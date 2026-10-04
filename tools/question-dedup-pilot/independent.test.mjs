// Pipeline tests. The fixture below is synthetic, exists only inside these tests, and is NOT
// independent evaluation data. The "API" is a local mock server: no real TypeSafe call is made.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeFlow, formatFlowReport, loadVerified } from './analyze-flow.mjs';
import { runFlow, readRaw } from './flow.mjs';
import {
  FINAL_LABELS,
  MINIMUMS,
  finalLabel,
  findResultsBeforeFreeze,
  freezeLabels,
  pairKey,
  shortlistPairs,
  validateLabels,
  verifyFrozen,
} from './independent-set.mjs';
import { judgeResponse, readProbabilities } from './typesafe-questions.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TINY = { candidates: 1, duplicate_question: 1, answer_leakage: 1, related_distinct: 1 };

// ---- mock API ---------------------------------------------------------------------------
let server;
let base;
let mode = 'answer-equality';
const received = [];
const noul = (v) => ({ type: 'noul', noul: v });
before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body);
      received.push(parsed);
      const { question_a: a, question_b: b } = parsed.state;
      const same = a.correct_answer === b.correct_answer;
      let answers = same
        ? { same_fact: noul(0.95), same_answer: noul(0.99), leakage: noul(0.95) }
        : { same_fact: noul(0.02), same_answer: noul(0.02), leakage: noul(0.05) };
      if (mode === 'missing-leakage') delete answers.leakage;
      if (mode === 'out-of-range') answers = { ...answers, same_fact: noul(1.2) };
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          model: 'mock-1',
          answers,
          usage: { input_tokens: 600, output_tokens: 50 },
        })
      );
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

// ---- fixture ----------------------------------------------------------------------------
const q = (id, role, question, choices, answer) => ({
  id,
  role,
  question,
  choices,
  correctIndex: choices.indexOf(answer),
  category: 'x',
});
function fixture() {
  const questions = [
    q('p1', 'pool', 'What is the capital of France?', ['Paris', 'Rome', 'Madrid', 'Oslo'], 'Paris'),
    q(
      'p2',
      'pool',
      'Which planet is known as the Red Planet?',
      ['Mars', 'Venus', 'Saturn', 'Earth'],
      'Mars'
    ),
    q('p3', 'pool', 'How many strings does a guitar have?', ['4', '5', '6', '7'], '6'),
    q(
      'p4',
      'pool',
      'Who painted the Mona Lisa?',
      ['Da Vinci', 'Monet', 'Picasso', 'Dali'],
      'Da Vinci'
    ),
    q('p5', 'pool', 'What is the currency of Japan?', ['Yen', 'Won', 'Yuan', 'Baht'], 'Yen'),
    q(
      'p6',
      'pool',
      'What is the tallest mountain above sea level?',
      ['Everest', 'K2', 'Fuji', 'Denali'],
      'Everest'
    ),
    q('p7', 'pool', 'Which vitamin comes from sunlight?', ['D', 'C', 'A', 'K'], 'D'),
    q('p8', 'pool', 'What do bees produce?', ['Honey', 'Milk', 'Silk', 'Oil'], 'Honey'),
    q(
      'c1',
      'candidate',
      'Which city is the capital of France?',
      ['Lyon', 'Paris', 'Nice', 'Lille'],
      'Paris'
    ), // duplicate of p1
    q(
      'c2',
      'candidate',
      'Mars is the Red Planet. Which planet gets that nickname?',
      ['Venus', 'Mars', 'Mercury', 'Neptune'],
      'Mars'
    ), // leakage of p2
    q(
      'c3',
      'candidate',
      'Who painted the Starry Night?',
      ['Da Vinci', 'Van Gogh', 'Monet', 'Dali'],
      'Da Vinci'
    ), // hard negative of p4, mock says same answer
    q('c4', 'candidate', 'How many strings does a violin have?', ['3', '4', '5', '6'], '4'), // leakage labeled, mock says distinct
    q(
      'c5',
      'candidate',
      'What is the currency of Japan? (set 2)',
      ['Yen', 'Won', 'Yuan', 'Baht'],
      'Yen'
    ),
    q(
      'c6',
      'candidate',
      'Name the insect that makes hexagonal wax combs',
      ['Bumblebee', 'Wasp', 'Ant', 'Beetle'],
      'Bumblebee'
    ),
  ];
  // the seed-copy pair needs a pool question whose text is the base of c5
  const overrides = {
    'c1|p1': 'duplicate_question',
    'c2|p2': 'answer_leakage',
    'c3|p4': 'related_distinct',
    'c4|p3': 'answer_leakage',
    'c5|p5': 'seed_variant',
    'c6|p8': 'answer_leakage', // real relation that the shortlist should not surface (p8 sorts last)
  };
  const data = {
    labeler: 'Test Labeler',
    attestation: { blindToTypeSafe: true },
    questions,
    pairs: [],
  };
  let n = 0;
  const seen = new Set();
  const add = (candidate, existing, label) => {
    const key = pairKey(candidate, existing);
    if (seen.has(key)) return;
    seen.add(key);
    n += 1;
    data.pairs.push({ id: `t${n}`, candidate, existing, label });
  };
  for (const [key, label] of Object.entries(overrides)) add(...key.split('|'), label);
  for (const p of shortlistPairs(data)) add(p.candidate, p.existing, 'unrelated');
  return data;
}
const workdir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'dedup-'));
  writeFileSync(join(dir, 'labels.json'), JSON.stringify(fixture(), null, 2));
  return dir;
};

// ---- runner hardening -------------------------------------------------------------------
test('a 200 is only successful when all three probabilities are present and valid', () => {
  const good = { answers: { same_fact: noul(0.5), same_answer: noul(0), leakage: noul(1) } };
  assert.equal(judgeResponse(200, good).ok, true);
  const without = (name) => ({
    answers: Object.fromEntries(Object.entries(good.answers).filter(([k]) => k !== name)),
  });
  for (const name of Object.keys(good.answers)) {
    const r = judgeResponse(200, without(name));
    assert.deepEqual([r.ok, r.reason], [false, 'invalid-probabilities'], `missing ${name}`);
  }
  for (const bad of [1.2, -0.1, '0.5', null, undefined, Number.NaN]) {
    const r = judgeResponse(200, {
      answers: { ...good.answers, leakage: { type: 'noul', noul: bad } },
    });
    assert.equal(r.ok, false, `value ${String(bad)}`);
  }
  assert.equal(
    judgeResponse(200, { answers: { ...good.answers, leakage: { type: 'score', noul: 0.5 } } }).ok,
    false
  );
  assert.equal(judgeResponse(200, null).ok, false);
  assert.equal(judgeResponse(500, good).reason, 'http-500');
  assert.equal(
    readProbabilities({ answers: { ...good.answers, extra: noul(0.1) } }) !== null,
    true
  );
});

// The mock is on localhost, so the child must not route through the environment proxy.
function childEnv() {
  const env = { ...process.env, TYPESAFE_API_BASE: base, NO_PROXY: '127.0.0.1,localhost' };
  delete env.NODE_USE_ENV_PROXY;
  return env;
}

// Async on purpose: the mock server lives in this process, so a blocking spawn would deadlock it.
function runPilot(outDir) {
  return new Promise((resolve) => {
    const child = spawn(
      'node',
      [join(HERE, 'typesafe-pilot.mjs'), '--stage', 'sample', '--out-dir', outDir],
      { env: childEnv() }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('pilot runner records a 200 with a missing probability as a failure and retries it next run', async () => {
  const out = mkdtempSync(join(tmpdir(), 'pilot-'));
  mode = 'missing-leakage';
  const first = await runPilot(out);
  assert.equal(first.status, 1, first.stderr);
  const rows = readRaw(join(out, 'raw-judgments.jsonl'));
  assert.equal(rows.length, 12);
  assert.ok(
    rows.every((r) => r.ok === false && r.failure === 'invalid-probabilities' && r.status === 200)
  );
  mode = 'out-of-range';
  assert.equal((await runPilot(out)).status, 1, 'an out-of-range probability also fails');
  mode = 'answer-equality';
  const third = await runPilot(out);
  assert.equal(third.status, 0, third.stderr);
  const all = readRaw(join(out, 'raw-judgments.jsonl'));
  assert.equal(all.filter((r) => r.ok).length, 12, 'failed pairs were re-sent, not skipped');
  const fourth = await runPilot(out);
  assert.match(fourth.stdout, /pairs to send: 0/, 'successful pairs are not re-sent');
});

// ---- label validation -------------------------------------------------------------------
test('validateLabels rejects AI labelers, missing attestation, examples and unresolved ambiguity', () => {
  const ok = validateLabels(fixture(), { minimums: TINY });
  assert.deepEqual(ok.errors, []);
  const asAi = { ...fixture(), labeler: 'Claude' };
  assert.ok(validateLabels(asAi, { minimums: TINY }).errors.some((e) => e.includes('AI system')));
  const noAttest = { ...fixture(), attestation: { blindToTypeSafe: false } };
  assert.ok(
    validateLabels(noAttest, { minimums: TINY }).errors.some((e) => e.includes('blindToTypeSafe'))
  );
  const ex = fixture();
  ex.questions[0].example = true;
  assert.ok(validateLabels(ex, { minimums: TINY }).errors.some((e) => e.includes('example')));
  const amb = fixture();
  const target = amb.pairs.find((p) => p.label === 'unrelated');
  target.ambiguous = true;
  const errs = validateLabels(amb, { minimums: TINY }).errors.join('\n');
  assert.ok(
    errs.includes('resolution.label') && errs.includes('resolvedBy') && errs.includes('rationale')
  );
  target.resolution = {
    label: 'related_distinct',
    resolvedBy: 'Second Person',
    rationale: 'answer appears in the stem',
  };
  const resolved = validateLabels(amb, { minimums: TINY });
  assert.deepEqual(resolved.errors, []);
  assert.equal(finalLabel(target), 'related_distinct');
  target.resolution.resolvedBy = 'Test Labeler';
  assert.ok(
    validateLabels(amb, { minimums: TINY }).warnings.some((w) => w.includes('second person'))
  );
  assert.ok(
    validateLabels(fixture()).errors.some((e) => e.includes('at least')),
    'default minimums apply'
  );
  assert.deepEqual(MINIMUMS, {
    candidates: 30,
    duplicate_question: 12,
    answer_leakage: 12,
    related_distinct: 20,
  });
  assert.ok(FINAL_LABELS.includes('unrelated'));
});

test('freeze requires every shortlisted pair to be labeled', () => {
  const dir = workdir();
  const data = JSON.parse(readFileSync(join(dir, 'labels.json'), 'utf8'));
  data.pairs = data.pairs.filter((p) => p.label !== 'unrelated');
  writeFileSync(join(dir, 'labels.json'), JSON.stringify(data));
  const r = freezeLabels(dir, { minimums: TINY });
  assert.ok(r.errors.some((e) => e.includes('not labeled yet')));
});

test('labels edited after the freeze are detected, and the flow refuses to run', async () => {
  const dir = workdir();
  assert.deepEqual(freezeLabels(dir, { minimums: TINY }).errors, []);
  assert.equal(verifyFrozen(dir, { minimums: TINY }).ok, true);
  const data = JSON.parse(readFileSync(join(dir, 'labels.json'), 'utf8'));
  data.pairs[0].label = 'related_distinct';
  writeFileSync(join(dir, 'labels.json'), JSON.stringify(data, null, 2));
  assert.match(verifyFrozen(dir, { minimums: TINY }).reason, /changed after it was frozen/);
  const before = received.length;
  await assert.rejects(runFlow({ dir, base, minimums: TINY, log: () => {} }), /not runnable/);
  assert.equal(received.length, before, 'nothing was sent');
});

// ---- full flow --------------------------------------------------------------------------
test('full flow: shortlist, TypeSafe, confusion, missed pairs and workload', async () => {
  const dir = workdir();
  assert.deepEqual(freezeLabels(dir, { minimums: TINY }).errors, []);
  mode = 'answer-equality';
  received.length = 0;
  const cap = runFlow({ dir, base, minimums: TINY, maxRequests: 3, log: () => {} });
  await assert.rejects(cap, /over the --max-requests cap/);
  assert.equal(received.length, 0);

  const first = await runFlow({ dir, base, minimums: TINY, limit: 2, log: () => {} });
  assert.equal(first.sent, 2);
  const rest = await runFlow({ dir, base, minimums: TINY, log: () => {} });
  assert.equal(rest.pending, 0);
  const again = await runFlow({ dir, base, minimums: TINY, log: () => {} });
  assert.equal(again.sent, 0, 'a finished run sends nothing more');

  const data = JSON.parse(readFileSync(join(dir, 'labels.json'), 'utf8'));
  const raw = readRaw(join(dir, 'results', 'raw-judgments.jsonl'));
  assert.ok(raw.filter((r) => !r.apiSkipped).every((r) => r.ok && r.response.usage));
  assert.equal(raw.filter((r) => r.apiSkipped).length >= 1, true, 'seed copy handled by code rule');
  assert.ok(
    !received.some(
      (r) =>
        r.state.question_a.question.includes('(set 2)') &&
        r.state.question_b.question.includes('Japan')
    ),
    'seed copy is never sent'
  );

  const a = analyzeFlow(data, raw);
  assert.equal(a.confusion.duplicate_question.duplicate, 1);
  assert.equal(
    a.confusion.answer_leakage.duplicate,
    1,
    'c2/p2 shares an answer, so it is caught but typed as duplicate'
  );
  assert.equal(a.confusion.answer_leakage.distinct, 1, 'c4/p3: labeled leakage, judged distinct');
  assert.equal(a.confusion.answer_leakage.not_shortlisted, 1, 'c6/p8: never surfaced');
  assert.equal(a.confusion.related_distinct.duplicate, 1, 'c3/p4: hard negative flagged');
  assert.equal(a.confusion.seed_variant.seed_variant, 1);
  assert.equal(a.funnel.missedAtShortlist.length, 1);
  assert.equal(a.funnel.missedAtTypeSafe.length, 1);
  assert.equal(a.funnel.wrongType.length, 1);
  assert.equal(a.falsePositives.length, 1);
  assert.equal(a.workload.review, 0);
  const report = formatFlowReport(
    a,
    data,
    JSON.parse(readFileSync(join(dir, 'freeze.json'), 'utf8'))
  );
  for (const heading of [
    'Category confusion',
    'Missed at the shortlist',
    'False positives on hard negatives',
    'Human-review workload',
  ]) {
    assert.ok(report.includes(heading), heading);
  }
});

test('a result that predates the freeze blocks the flow', async () => {
  const dir = workdir();
  freezeLabels(dir, { minimums: TINY });
  mkdirSync(join(dir, 'results'), { recursive: true });
  writeFileSync(
    join(dir, 'results', 'raw-judgments.jsonl'),
    JSON.stringify({ pairId: 'c1|p1', ok: true, requestedAt: '2000-01-01T00:00:00.000Z' }) + '\n'
  );
  await assert.rejects(
    runFlow({ dir, base, minimums: TINY, log: () => {} }),
    /predate the label freeze/
  );
});

// ---- analyze-flow verifies the freeze ---------------------------------------------------
async function finishedRun() {
  const dir = workdir();
  assert.deepEqual(freezeLabels(dir, { minimums: TINY }).errors, []);
  mode = 'answer-equality';
  await runFlow({ dir, base, minimums: TINY, log: () => {} });
  return dir;
}
const rawPath = (dir) => join(dir, 'results', 'raw-judgments.jsonl');
const runAnalyze = (dir) =>
  new Promise((resolve) => {
    const child = spawn('node', [join(HERE, 'analyze-flow.mjs'), '--dir', dir, '--write'], {
      env: childEnv(),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });

test('findResultsBeforeFreeze flags early, untimed and unparseable rows', () => {
  const freeze = { frozenAt: '2026-01-01T00:00:00.000Z' };
  const rows = [
    { pairId: 'a', requestedAt: '2026-01-01T00:00:00.000Z' }, // exactly at the freeze: allowed
    { pairId: 'b', requestedAt: '2026-01-02T00:00:00.000Z' },
    { pairId: 'early', requestedAt: '2025-12-31T23:59:59.999Z' },
    { pairId: 'missing' },
    { pairId: 'garbage', requestedAt: 'not a date' },
  ];
  assert.deepEqual(
    findResultsBeforeFreeze(rows, freeze).map((r) => r.pairId),
    ['early', 'missing', 'garbage']
  );
  assert.throws(() => findResultsBeforeFreeze(rows, { frozenAt: 'nope' }), /valid frozenAt/);
});

test('analyze accepts a frozen set whose results all follow the freeze', async () => {
  const dir = await finishedRun();
  const { data, rows } = loadVerified(dir, { minimums: TINY });
  assert.ok(rows.length > 0);
  assert.equal(analyzeFlow(data, rows).pairsInRawFile > 0, true);
});

test('analyze refuses when there is no freeze record', async () => {
  const dir = workdir(); // labels only, never frozen
  assert.throws(() => loadVerified(dir, { minimums: TINY }), /cannot analyze: .*freeze/);
});

test('analyze refuses when the labels changed after the freeze', async () => {
  const dir = await finishedRun();
  const data = JSON.parse(readFileSync(join(dir, 'labels.json'), 'utf8'));
  data.pairs[0].label = 'unrelated';
  writeFileSync(join(dir, 'labels.json'), JSON.stringify(data, null, 2));
  assert.throws(() => loadVerified(dir, { minimums: TINY }), /changed after it was frozen/);
  // a whitespace-only edit changes the bytes, so it is caught too
  const dir2 = await finishedRun();
  writeFileSync(join(dir2, 'labels.json'), readFileSync(join(dir2, 'labels.json'), 'utf8') + '\n');
  assert.throws(() => loadVerified(dir2, { minimums: TINY }), /changed after it was frozen/);
});

test('analyze refuses results recorded before the freeze or without a timestamp', async () => {
  const early = await finishedRun();
  const rows = readRaw(rawPath(early));
  rows[0].requestedAt = '2000-01-01T00:00:00.000Z';
  writeFileSync(rawPath(early), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  assert.throws(() => loadVerified(early, { minimums: TINY }), /predate the label freeze/);

  const untimed = await finishedRun();
  const rows2 = readRaw(rawPath(untimed));
  delete rows2[0].requestedAt;
  writeFileSync(rawPath(untimed), rows2.map((r) => JSON.stringify(r)).join('\n') + '\n');
  assert.throws(() => loadVerified(untimed, { minimums: TINY }), /lack a valid timestamp/);
});

test('analyze-flow CLI exits 2 and writes no report when verification fails', async () => {
  const dir = await finishedRun();
  // the CLI uses the default minimums, which the tiny fixture cannot meet, so it must refuse
  const blocked = await runAnalyze(dir);
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /cannot analyze/);
  assert.ok(!blocked.stdout.includes('Independent flow report'));
  assert.throws(() => readFileSync(join(dir, 'results', 'report.md')), /ENOENT/);
});

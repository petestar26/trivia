#!/usr/bin/env node
/**
 * Offline evaluation for the question-duplicate pilot.
 *
 * Stage 1 (this file): validate the labeled pair set, then measure how often a
 * cheap local shortlist puts the labeled partner in the top K candidates. Only
 * shortlisted pairs would ever be sent to TypeSafe, so a partner missed here
 * can never be judged later.
 *
 * Makes no network calls and touches no database, seed, route or app code. It
 * only reads pairs.json and (read-only) packages/database/prisma/seed.ts.
 *
 * Usage: node tools/question-dedup-pilot/evaluate.mjs [--k 3,5,10] [--json]
 *          [--misses] [--min-recall 0.9] [--min-recall-k 10] [--pairs file.json]
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED_PATH = join(HERE, '..', '..', 'packages', 'database', 'prisma', 'seed.ts');

export const LABELS = ['duplicate_question', 'answer_leakage', 'related_distinct', 'seed_variant'];
// Labels whose partner we want in the shortlist because a real judgment is needed.
// related_distinct is reported separately: surfacing it is useful (TypeSafe must reject
// it) but a miss there is harmless.
export const POSITIVE_LABELS = ['duplicate_question', 'answer_leakage', 'seed_variant'];

const STOPWORDS = new Set(
  (
    'a an the of in on at to for from by with is are was were be been how what which who whom whose ' +
    'when where why do does did has have had it its this that these those and or as per each'
  ).split(' ')
);

// Generic normalizations only; nothing here is tuned to a specific pair.
const TOKEN_ALIASES = { x: 'times', '×': 'times', '*': 'times', '%': 'percent' };

export function tokenize(text) {
  const cleaned = String(text)
    .toLowerCase()
    .replace(/\(set \d+\)/g, ' ')
    .replace(/%/g, ' percent ')
    .replace(/[^\p{L}\p{N}×*\s-]/gu, ' ');
  const tokens = [];
  for (const raw of cleaned.split(/\s+/)) {
    if (!raw) continue;
    let t = TOKEN_ALIASES[raw] ?? raw;
    if (STOPWORDS.has(t)) continue;
    // Light plural stripping so "strings"/"string" and "minutes"/"minute" line up.
    if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) t = t.slice(0, -1);
    tokens.push(t);
  }
  return new Set(tokens);
}

export function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

const norm = (s) => [...tokenize(s)].sort().join(' ');

export function prepare(question) {
  return {
    id: question.id,
    stem: tokenize(question.question),
    choices: new Set(question.choices.map(norm)),
    answer: norm(question.choices[question.correctIndex]),
  };
}

/** Similarity used only to shortlist; it is not a duplicate verdict. */
export function shortlistScore(a, b) {
  const stem = jaccard(a.stem, b.stem);
  const choices = jaccard(a.choices, b.choices);
  const sameAnswer = a.answer !== '' && a.answer === b.answer ? 1 : 0;
  return 0.6 * stem + 0.2 * choices + 0.2 * sameAnswer;
}

/** Ranked list of every other question in the pool for one candidate. */
export function rankPool(candidateId, prepared) {
  const me = prepared.get(candidateId);
  const ranked = [];
  for (const [id, other] of prepared) {
    if (id === candidateId) continue;
    ranked.push({ id, score: shortlistScore(me, other) });
  }
  ranked.sort((x, y) => y.score - x.score || (x.id < y.id ? -1 : 1));
  return ranked;
}

export function parseSeedQuestions(source) {
  const re = /question:\s*'((?:[^'\\]|\\.)*)',\s*choices:\s*\[([^\]]*)\],\s*correctIndex:\s*(\d+)/g;
  const out = [];
  for (const m of source.matchAll(re)) {
    const choices = [...m[2].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((c) => c[1]);
    out.push({ question: m[1], choices, correctIndex: Number(m[3]) });
  }
  return out;
}

export function validate(data, seedQuestions = null) {
  const errors = [];
  const ids = new Set();
  for (const q of data.questions ?? []) {
    if (ids.has(q.id)) errors.push(`duplicate question id ${q.id}`);
    ids.add(q.id);
    if (!q.question || !Array.isArray(q.choices) || q.choices.length < 2) {
      errors.push(`${q.id}: needs question text and at least 2 choices`);
    } else if (new Set(q.choices).size !== q.choices.length) {
      errors.push(`${q.id}: repeated choice text`);
    }
    if (
      !Number.isInteger(q.correctIndex) ||
      q.correctIndex < 0 ||
      q.correctIndex >= (q.choices?.length ?? 0)
    ) {
      errors.push(`${q.id}: correctIndex out of range`);
    }
  }
  const pairIds = new Set();
  const seen = new Set();
  for (const p of data.pairs ?? []) {
    if (pairIds.has(p.id)) errors.push(`duplicate pair id ${p.id}`);
    pairIds.add(p.id);
    if (!LABELS.includes(p.label)) errors.push(`${p.id}: unknown label "${p.label}"`);
    for (const side of ['candidate', 'existing']) {
      if (!ids.has(p[side])) errors.push(`${p.id}: unknown ${side} id "${p[side]}"`);
    }
    if (p.candidate === p.existing) errors.push(`${p.id}: pairs a question with itself`);
    const key = [p.candidate, p.existing].sort().join('|');
    if (seen.has(key)) errors.push(`${p.id}: unordered pair ${key} is labeled twice`);
    seen.add(key);
  }
  if (seedQuestions && seedQuestions.length > 0) {
    for (const q of (data.questions ?? []).filter((x) => x.source === 'seed')) {
      const match = seedQuestions.find((s) => s.question === q.question);
      if (!match) errors.push(`${q.id}: source "seed" but text not found in seed.ts`);
      else if (
        JSON.stringify(match.choices) !== JSON.stringify(q.choices) ||
        match.correctIndex !== q.correctIndex
      ) {
        errors.push(`${q.id}: choices/correctIndex differ from seed.ts`);
      }
    }
    for (const q of (data.questions ?? []).filter((x) => x.source === 'seed-variant')) {
      if (!/ \(set \d+\)$/.test(q.question))
        errors.push(`${q.id}: seed-variant must end in "(set N)"`);
    }
  }
  return errors;
}

/**
 * Candidate -> existing recall at each K, per label. `either` also counts a pair
 * found from the reverse direction (existing -> candidate).
 */
export function evaluateShortlist(data, ks) {
  const prepared = new Map(data.questions.map((q) => [q.id, prepare(q)]));
  const rankCache = new Map();
  const ranked = (id) => {
    if (!rankCache.has(id)) rankCache.set(id, rankPool(id, prepared));
    return rankCache.get(id);
  };
  const rankOf = (fromId, targetId) => ranked(fromId).findIndex((r) => r.id === targetId) + 1;

  const rows = data.pairs.map((p) => {
    const forward = rankOf(p.candidate, p.existing);
    const reverse = rankOf(p.existing, p.candidate);
    return { ...p, forwardRank: forward, reverseRank: reverse };
  });

  const byLabel = {};
  for (const label of LABELS) {
    const subset = rows.filter((r) => r.label === label);
    byLabel[label] = {
      pairs: subset.length,
      forward: Object.fromEntries(
        ks.map((k) => [k, subset.filter((r) => r.forwardRank <= k).length])
      ),
      either: Object.fromEntries(
        ks.map((k) => [k, subset.filter((r) => Math.min(r.forwardRank, r.reverseRank) <= k).length])
      ),
      medianRank: median(subset.map((r) => r.forwardRank)),
    };
  }
  const positives = rows.filter((r) => POSITIVE_LABELS.includes(r.label));
  const overall = {
    pairs: positives.length,
    forward: Object.fromEntries(
      ks.map((k) => [k, positives.filter((r) => r.forwardRank <= k).length])
    ),
    either: Object.fromEntries(
      ks.map((k) => [
        k,
        positives.filter((r) => Math.min(r.forwardRank, r.reverseRank) <= k).length,
      ])
    ),
  };
  return { rows, byLabel, overall, poolSize: data.questions.length };
}

function median(values) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const pct = (n, d) => (d === 0 ? '  n/a' : `${((100 * n) / d).toFixed(0).padStart(3)}%`);

export function formatReport(result, ks, { showMisses, questionsById }) {
  const lines = [];
  lines.push(`Pool: ${result.poolSize} questions, ${result.rows.length} labeled pairs.`);
  lines.push(
    "Shortlist recall = labeled partner appears in the candidate's top K (candidate -> existing)."
  );
  lines.push('');
  const head = [
    'label'.padEnd(20),
    'pairs',
    ...ks.map((k) => `K=${k}`.padStart(9)),
    ' median rank',
  ];
  lines.push(head.join('  '));
  for (const label of LABELS) {
    const b = result.byLabel[label];
    const tag = POSITIVE_LABELS.includes(label) ? '' : ' *';
    lines.push(
      [
        (label + tag).padEnd(20),
        String(b.pairs).padStart(5),
        ...ks.map((k) =>
          `${pct(b.forward[k], b.pairs)} ${String(b.forward[k]).padStart(2)}/${b.pairs}`.padStart(9)
        ),
        String(b.medianRank ?? '-').padStart(12),
      ].join('  ')
    );
  }
  const o = result.overall;
  lines.push(
    [
      'OVERALL (excl. *)'.padEnd(20),
      String(o.pairs).padStart(5),
      ...ks.map((k) =>
        `${pct(o.forward[k], o.pairs)} ${String(o.forward[k]).padStart(2)}/${o.pairs}`.padStart(9)
      ),
      '',
    ].join('  ')
  );
  lines.push(
    [
      '  either direction'.padEnd(20),
      '',
      ...ks.map((k) => pct(o.either[k], o.pairs).padStart(9)),
    ].join('  ')
  );
  lines.push('');
  lines.push(
    '* related_distinct is a hard-negative label: surfacing it is desirable (TypeSafe must reject it),'
  );
  lines.push('  but a miss is harmless, so it is excluded from the overall recall.');

  if (showMisses) {
    const maxK = Math.max(...ks);
    const misses = result.rows
      .filter((r) => POSITIVE_LABELS.includes(r.label) && r.forwardRank > maxK)
      .sort((a, b) => b.forwardRank - a.forwardRank);
    lines.push('');
    lines.push(`Positive pairs outside top ${maxK} (${misses.length}):`);
    for (const m of misses) {
      lines.push(
        `  ${m.id} ${m.label} rank ${m.forwardRank}: "${questionsById.get(m.candidate).question}"  vs  "${questionsById.get(m.existing).question}"`
      );
    }
  }
  return lines.join('\n');
}

function parseArgs(argv) {
  const opts = {
    ks: [3, 5, 10],
    json: false,
    misses: false,
    minRecall: null,
    minRecallK: null,
    pairs: join(HERE, 'pairs.json'),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--misses') opts.misses = true;
    else if (a === '--k') opts.ks = argv[++i].split(',').map(Number);
    else if (a === '--min-recall') opts.minRecall = Number(argv[++i]);
    else if (a === '--min-recall-k') opts.minRecallK = Number(argv[++i]);
    else if (a === '--pairs') opts.pairs = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  if (opts.ks.some((k) => !Number.isInteger(k) || k < 1))
    throw new Error('--k needs positive integers');
  if (opts.minRecall !== null && !(opts.minRecall >= 0 && opts.minRecall <= 1)) {
    throw new Error('--min-recall must be between 0 and 1');
  }
  opts.minRecallK ??= Math.max(...opts.ks);
  if (!opts.ks.includes(opts.minRecallK)) throw new Error('--min-recall-k must be one of --k');
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const data = JSON.parse(readFileSync(opts.pairs, 'utf8'));
  let seedQuestions = null;
  try {
    seedQuestions = parseSeedQuestions(readFileSync(SEED_PATH, 'utf8'));
  } catch {
    console.warn('note: seed.ts not readable; skipping the seed-consistency check');
  }
  const errors = validate(data, seedQuestions);
  if (errors.length > 0) {
    console.error(`Validation failed (${errors.length}):`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(2);
  }
  const result = evaluateShortlist(data, opts.ks);
  if (opts.json) {
    console.log(JSON.stringify({ ks: opts.ks, ...result }, null, 2));
  } else {
    const questionsById = new Map(data.questions.map((q) => [q.id, q]));
    console.log(
      'Validation OK (ids, labels, answer indexes' +
        (seedQuestions ? ', seed.ts match' : '') +
        ').\n'
    );
    console.log(formatReport(result, opts.ks, { showMisses: opts.misses, questionsById }));
  }
  if (opts.minRecall !== null) {
    const recall = result.overall.forward[opts.minRecallK] / result.overall.pairs;
    if (recall < opts.minRecall) {
      console.error(
        `\nGate failed: recall@${opts.minRecallK} = ${recall.toFixed(3)} < ${opts.minRecall}`
      );
      process.exit(1);
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();

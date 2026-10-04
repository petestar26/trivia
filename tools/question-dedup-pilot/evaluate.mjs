#!/usr/bin/env node
/**
 * Offline evaluation for the question-duplicate pilot.
 *
 * Stage 1 (this file): validate the labeled pair set, then measure how often a
 * cheap local shortlist puts the labeled partner in the top K candidates. Only
 * shortlisted pairs would ever be sent to TypeSafe, so a partner missed here
 * can never be judged later.
 *
 * The shortlist adds an "answer appears in the other question's text" signal.
 * It was motivated by two misses in the dev pairs (p027, p028), so dev results
 * are post-hoc. The holdout pairs were written after the rule and its guard
 * parameters were fixed; they are reported separately and are still weak
 * evidence (same author, tiny counts).
 *
 * Makes no network calls and touches no database, seed, route or app code. It
 * only reads pairs.json and (read-only) packages/database/prisma/seed.ts.
 *
 * Usage: node tools/question-dedup-pilot/evaluate.mjs [--k 3,5,10] [--json]
 *          [--misses] [--no-leak] [--no-guards] [--min-recall 0.9]
 *          [--min-recall-k 10] [--pairs file.json]
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED_PATH = join(HERE, '..', '..', 'packages', 'database', 'prisma', 'seed.ts');

// Answer-in-text signal parameters. Fixed before looking at scores; not swept.
export const LEAK_WEIGHT = 0.3;
export const MIN_ANSWER_CHARS = 2; // single-character answers ("D", "5") match too much text
export const DF_CAP_FRACTION = 0.05; // ignore answers found in the stems of >5% of the pool
export const DF_CAP_FLOOR = 3;

export const SPLITS = ['dev', 'holdout'];
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

export function tokenList(text) {
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
  return tokens;
}

export const tokenize = (text) => new Set(tokenList(text));

/** True when `needle` occurs as a contiguous whole-token run inside `hay`. */
export function containsSequence(hay, needle) {
  if (needle.length === 0 || needle.length > hay.length) return false;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    if (needle.every((t, j) => hay[i + j] === t)) return true;
  }
  return false;
}

export function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

const norm = (s) => [...tokenize(s)].sort().join(' ');

export function prepare(question) {
  const answerTokens = tokenList(question.choices[question.correctIndex]);
  return {
    id: question.id,
    stem: tokenize(question.question),
    stemTokens: tokenList(question.question),
    choices: new Set(question.choices.map(norm)),
    answer: norm(question.choices[question.correctIndex]),
    answerTokens,
  };
}

/**
 * Why an answer is too generic to trust as a text match, or null if usable.
 * `docFreq` is how many pool stems contain the answer as a token run.
 */
export function answerGuard(answerTokens, docFreq, poolSize) {
  if (answerTokens.length === 0) return 'empty';
  const joined = answerTokens.join('');
  if (joined.length < MIN_ANSWER_CHARS) return 'too-short';
  if (answerTokens.length === 1 && /^\d$/.test(answerTokens[0])) return 'single-digit';
  const cap = Math.max(DF_CAP_FLOOR, Math.floor(DF_CAP_FRACTION * poolSize));
  if (docFreq > cap) return 'too-common';
  return null;
}

/** Per-question guard verdicts for the whole pool (null = usable). */
export function buildAnswerGuards(prepared) {
  const stems = [...prepared.values()].map((p) => p.stemTokens);
  const guards = new Map();
  for (const [id, p] of prepared) {
    const docFreq = stems.filter((stem) => containsSequence(stem, p.answerTokens)).length;
    guards.set(id, answerGuard(p.answerTokens, docFreq, prepared.size));
  }
  return guards;
}

/**
 * Does either question's correct answer appear in the other's text?
 * `guards` maps id -> guard reason; pass null to disable guarding.
 */
export function answerInText(a, b, guards) {
  const usable = (q) => guards === null || guards.get(q.id) === null;
  const aInB = usable(a) && containsSequence(b.stemTokens, a.answerTokens);
  const bInA = usable(b) && containsSequence(a.stemTokens, b.answerTokens);
  return { aInB, bInA, either: aInB || bInA };
}

/**
 * Similarity used only to shortlist; it is not a duplicate verdict.
 * `opts.guards`: Map from buildAnswerGuards, or null for unguarded. `opts.leak`: add the
 * answer-in-text signal (default true).
 */
export function shortlistScore(a, b, opts = {}) {
  const stem = jaccard(a.stem, b.stem);
  const choices = jaccard(a.choices, b.choices);
  const sameAnswer = a.answer !== '' && a.answer === b.answer ? 1 : 0;
  let score = 0.6 * stem + 0.2 * choices + 0.2 * sameAnswer;
  if (opts.leak !== false && answerInText(a, b, opts.guards ?? null).either) score += LEAK_WEIGHT;
  return score;
}

/** Ranked list of every other question in the pool for one candidate. */
export function rankPool(candidateId, prepared, opts = {}) {
  const me = prepared.get(candidateId);
  const ranked = [];
  for (const [id, other] of prepared) {
    if (id === candidateId) continue;
    ranked.push({ id, score: shortlistScore(me, other, opts) });
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
    if (!SPLITS.includes(p.split))
      errors.push(`${p.id}: split must be one of ${SPLITS.join(', ')}`);
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
/**
 * Candidate -> existing shortlist ranks for every labeled pair under one configuration.
 * `config`: { leak: boolean, guards: boolean }.
 */
export function rankPairs(data, config) {
  const prepared = new Map(data.questions.map((q) => [q.id, prepare(q)]));
  const guards = config.guards ? buildAnswerGuards(prepared) : null;
  const opts = { leak: config.leak, guards };
  const cache = new Map();
  const ranked = (id) => {
    if (!cache.has(id)) cache.set(id, rankPool(id, prepared, opts));
    return cache.get(id);
  };
  const rankOf = (fromId, targetId) => ranked(fromId).findIndex((r) => r.id === targetId) + 1;
  const rows = data.pairs.map((p) => {
    const a = prepared.get(p.candidate);
    const b = prepared.get(p.existing);
    return {
      ...p,
      forwardRank: rankOf(p.candidate, p.existing),
      reverseRank: rankOf(p.existing, p.candidate),
      leakFires: answerInText(a, b, guards).either,
    };
  });
  return { rows, prepared, guards };
}

function median(values) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Recall per split and label. Labels are never pooled into a blended number. */
export function summarize(rows, ks) {
  const out = {};
  for (const split of SPLITS) {
    out[split] = {};
    for (const label of LABELS) {
      const subset = rows.filter((r) => (r.split ?? 'dev') === split && r.label === label);
      out[split][label] = {
        pairs: subset.length,
        found: Object.fromEntries(
          ks.map((k) => [k, subset.filter((r) => r.forwardRank <= k).length])
        ),
        foundEither: Object.fromEntries(
          ks.map((k) => [
            k,
            subset.filter((r) => Math.min(r.forwardRank, r.reverseRank) <= k).length,
          ])
        ),
        medianRank: median(subset.map((r) => r.forwardRank)),
      };
    }
  }
  return out;
}

/**
 * How often the answer-in-text signal fires across every unordered pool pair, with and
 * without guards. Fires on unlabeled pairs are listed for human review, not counted as
 * errors: unlabeled pairs are only assumed distinct.
 */
export function leakFireReport(data) {
  const prepared = new Map(data.questions.map((q) => [q.id, prepare(q)]));
  const guarded = buildAnswerGuards(prepared);
  const labeled = new Map(
    data.pairs.map((p) => [[p.candidate, p.existing].sort().join('|'), p.label])
  );
  const ids = [...prepared.keys()];
  const count = () => ({ total: 0, byLabel: {}, unlabeled: [] });
  const on = count();
  const off = count();
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const key = [ids[i], ids[j]].sort().join('|');
      const label = labeled.get(key) ?? 'unlabeled';
      for (const [bucket, guards] of [
        [on, guarded],
        [off, null],
      ]) {
        if (!answerInText(prepared.get(ids[i]), prepared.get(ids[j]), guards).either) continue;
        bucket.total += 1;
        bucket.byLabel[label] = (bucket.byLabel[label] ?? 0) + 1;
        if (label === 'unlabeled') bucket.unlabeled.push(key);
      }
    }
  }
  const dropped = [...guarded]
    .filter(([, reason]) => reason !== null)
    .map(([id, reason]) => ({ id, reason }));
  return {
    pairsChecked: (ids.length * (ids.length - 1)) / 2,
    guarded: on,
    unguarded: off,
    ignoredAnswers: dropped,
  };
}

/** Full evaluation: main configuration plus ablations (no answer-in-text; no guards). */
export function evaluateShortlist(data, ks) {
  const main = rankPairs(data, { leak: true, guards: true });
  const noLeak = rankPairs(data, { leak: false, guards: true });
  const noGuards = rankPairs(data, { leak: true, guards: false });
  return {
    poolSize: data.questions.length,
    rows: main.rows,
    summary: summarize(main.rows, ks),
    ablation: {
      noLeak: summarize(noLeak.rows, ks),
      noGuards: summarize(noGuards.rows, ks),
    },
    noLeakRows: noLeak.rows,
    leakFires: leakFireReport(data),
  };
}

const pct = (n, d) => (d === 0 ? ' n/a' : `${((100 * n) / d).toFixed(0)}%`);
const frac = (n, d) => `${n}/${d}`;

export function formatReport(result, ks, { showMisses, questionsById }) {
  const lines = [];
  const maxK = Math.max(...ks);
  const fmtCell = (b, k) =>
    `${frac(b.found[k], b.pairs)} (${pct(b.found[k], b.pairs)})`.padStart(13);
  lines.push(`Pool: ${result.poolSize} questions, ${result.rows.length} labeled pairs.`);
  lines.push("Recall = labeled partner is in the candidate's top K (candidate -> existing).");
  lines.push('Labels are reported separately; there is no blended overall number.');

  const table = (title, summary, note) => {
    lines.push('', title, note);
    lines.push(
      ['label'.padEnd(20), ...ks.map((k) => `K=${k}`.padStart(13)), '  median rank'].join('')
    );
    for (const label of LABELS) {
      const b = summary[label];
      const tag = POSITIVE_LABELS.includes(label) ? '' : ' *';
      lines.push(
        [
          (label + tag).padEnd(20),
          ...ks.map((k) => fmtCell(b, k)),
          String(b.medianRank ?? '-').padStart(14),
        ].join('')
      );
    }
  };
  table(
    'DEV pairs (post-hoc: p027/p028 motivated the answer-in-text rule)',
    result.summary.dev,
    '  Not independent validation.'
  );
  table(
    'HOLDOUT pairs (written after the rule and guards were fixed)',
    result.summary.holdout,
    '  Tiny counts, same author: weak evidence, do not over-read percentages.'
  );

  lines.push('', `Answer-in-text ablation at K=${maxK} (found/pairs; dev | holdout)`);
  lines.push(
    [
      'label'.padEnd(20),
      'leak off'.padStart(16),
      'leak on'.padStart(16),
      'leak on, no guards'.padStart(22),
    ].join('')
  );
  for (const label of POSITIVE_LABELS) {
    const cell = (sum) =>
      `${frac(sum.dev[label].found[maxK], sum.dev[label].pairs)} | ${frac(sum.holdout[label].found[maxK], sum.holdout[label].pairs)}`;
    lines.push(
      [
        label.padEnd(20),
        cell(result.ablation.noLeak).padStart(16),
        cell(result.summary).padStart(16),
        cell(result.ablation.noGuards).padStart(22),
      ].join('')
    );
  }
  lines.push(
    '* related_distinct is a hard-negative label: it is reported for context, and a miss is harmless.'
  );

  const f = result.leakFires;
  const labelCounts = (b) =>
    Object.entries(b.byLabel)
      .sort()
      .map(([l, n]) => `${l} ${n}`)
      .join(', ') || 'none';
  lines.push('', `Answer-in-text signal across all ${f.pairsChecked} unordered pool pairs:`);
  lines.push(`  guarded:   ${f.guarded.total} fire  (${labelCounts(f.guarded)})`);
  lines.push(`  unguarded: ${f.unguarded.total} fire  (${labelCounts(f.unguarded)})`);
  lines.push(
    `  answers ignored by guards: ${f.ignoredAnswers.length}` +
      (f.ignoredAnswers.length
        ? ` (${f.ignoredAnswers.map((g) => `${g.id}:${g.reason}`).join(', ')})`
        : '')
  );
  if (f.guarded.unlabeled.length > 0) {
    lines.push(
      '  guarded fires on unlabeled pairs (review by hand; unlabeled is only assumed distinct):'
    );
    for (const key of f.guarded.unlabeled) {
      const [x, y] = key.split('|');
      lines.push(
        `    ${key}: "${questionsById.get(x).question}"  /  "${questionsById.get(y).question}"`
      );
    }
  }
  if (showMisses) {
    const misses = result.rows
      .filter((r) => POSITIVE_LABELS.includes(r.label) && r.forwardRank > maxK)
      .sort((a, b) => b.forwardRank - a.forwardRank);
    lines.push('', `Positive pairs outside top ${maxK} (${misses.length}):`);
    for (const m of misses) {
      lines.push(
        `  ${m.id} [${m.split}] ${m.label} rank ${m.forwardRank}: "${questionsById.get(m.candidate).question}"  vs  "${questionsById.get(m.existing).question}"`
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
      'Validation OK (ids, labels, splits, answer indexes' +
        (seedQuestions ? ', seed.ts match' : '') +
        ').\n'
    );
    console.log(formatReport(result, opts.ks, { showMisses: opts.misses, questionsById }));
  }
  if (opts.minRecall !== null) {
    // Gate: every positive label, dev and holdout together, must reach the bar.
    const failing = POSITIVE_LABELS.filter((label) => {
      const pairs = SPLITS.reduce((n, s) => n + result.summary[s][label].pairs, 0);
      const found = SPLITS.reduce((n, s) => n + result.summary[s][label].found[opts.minRecallK], 0);
      return pairs > 0 && found / pairs < opts.minRecall;
    });
    if (failing.length > 0) {
      console.error(
        `\nGate failed at K=${opts.minRecallK}: ${failing.join(', ')} below ${opts.minRecall}`
      );
      process.exit(1);
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();

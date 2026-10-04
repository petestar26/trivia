#!/usr/bin/env node
/**
 * Offline analysis of results/raw-judgments.jsonl from the bounded TypeSafe pilot. Applies the
 * fixed thresholds from typesafe-questions.mjs and reports by split and label. Makes no network
 * calls and picks no thresholds: nothing here is fitted to any split.
 *
 * Usage: node tools/question-dedup-pilot/analyze-judgments.mjs [--json] [--write]
 *   --write  also writes results/report.md
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LABELS, SPLITS } from './evaluate.mjs';
import {
  QUESTIONS,
  THRESHOLDS,
  isSeedVariantByRule,
  readProbabilities,
  verdictFor,
} from './typesafe-questions.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const VERDICTS = ['duplicate', 'leakage', 'review', 'distinct', 'seed_variant', 'error'];

const quantile = (values, q) => {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
};
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

/** Keep the last successful judgment per pair; failed rows are reported, not analysed. */
export function latestGood(rows) {
  const byPair = new Map();
  for (const r of rows) if (r.ok) byPair.set(r.pairId, r);
  return byPair;
}

export function analyze(rawRows, data, runs = []) {
  const qById = new Map(data.questions.map((q) => [q.id, q]));
  const good = latestGood(rawRows);
  const failed = rawRows.filter((r) => !r.ok).length;

  const judged = data.pairs
    .filter((p) => good.has(p.id))
    .map((p) => {
      const raw = good.get(p.id);
      const probs = readProbabilities(raw.response);
      const seedVariantByRule = isSeedVariantByRule(qById.get(p.candidate), qById.get(p.existing));
      return {
        ...p,
        probs,
        verdict: verdictFor(probs, { seedVariantByRule }),
        // What the model alone would have decided, ignoring the code rule for seed copies.
        modelOnlyVerdict: verdictFor(probs),
        usage: raw.response.usage,
        latencyMs: raw.latencyMs,
        model: raw.response.model,
      };
    });

  const cells = {};
  for (const split of SPLITS) {
    cells[split] = {};
    for (const label of LABELS) {
      const rows = judged.filter((r) => r.split === split && r.label === label);
      const counts = Object.fromEntries(
        VERDICTS.map((v) => [v, rows.filter((r) => r.verdict === v).length])
      );
      const stat = (name) => {
        const v = rows.map((r) => r.probs?.[name]).filter((x) => typeof x === 'number');
        return { min: quantile(v, 0), median: quantile(v, 0.5), max: quantile(v, 1) };
      };
      cells[split][label] = {
        pairs: rows.length,
        counts,
        probs: Object.fromEntries(Object.keys(QUESTIONS).map((n) => [n, stat(n)])),
        modelOnlyDuplicates: rows.filter((r) => r.modelOnlyVerdict === 'duplicate').length,
        rows,
      };
    }
  }

  const inTok = judged.map((r) => r.usage.input_tokens);
  const outTok = judged.map((r) => r.usage.output_tokens);
  const lat = judged.map((r) => r.latencyMs);
  return {
    thresholds: THRESHOLDS,
    models: [...new Set(judged.map((r) => r.model))],
    pairsJudged: judged.length,
    pairsMissing: data.pairs.length - judged.length,
    failedRequests: failed,
    cost: {
      inputTokens: {
        total: sum(inTok),
        mean: sum(inTok) / (inTok.length || 1),
        median: quantile(inTok, 0.5),
        p95: quantile(inTok, 0.95),
      },
      outputTokens: { total: sum(outTok), mean: sum(outTok) / (outTok.length || 1) },
    },
    latencyMs: { median: quantile(lat, 0.5), p95: quantile(lat, 0.95), max: quantile(lat, 1) },
    runs,
    cells,
    judged,
  };
}

const f = (x, d = 2) => (x === null || x === undefined ? '-' : x.toFixed(d));
const rate = (n, d) => `${n}/${d}`;

export function formatReport(a, qById) {
  const L = [];
  const t = a.thresholds;
  L.push('# TypeSafe pilot report (offline, labeled pairs only)', '');
  L.push(
    `Model: ${a.models.join(', ')} (requested alias \`jev-latest\`). Pairs judged: ${a.pairsJudged}/${a.pairsJudged + a.pairsMissing}. Failed requests: ${a.failedRequests}.`
  );
  L.push(
    `Fixed thresholds (declared before any call, not tuned on any split): flag at >= ${t.high}, review at >= ${t.review}, duplicate also needs same_answer >= ${t.sameAnswerMin}.`
  );
  L.push('Verdict priority: seed copy by code rule > duplicate > leakage > review > distinct.', '');

  L.push('## Cost and latency', '');
  L.push(
    `- Input tokens (billable): ${a.cost.inputTokens.total} total, mean ${f(a.cost.inputTokens.mean, 0)}, median ${f(a.cost.inputTokens.median, 0)}, p95 ${f(a.cost.inputTokens.p95, 0)} per request.`
  );
  L.push(
    `- Output tokens (free per the API spec): ${a.cost.outputTokens.total} total, mean ${f(a.cost.outputTokens.mean, 0)} per request.`
  );
  L.push(
    '- The API reports token counts only; no dollar price is available from it, so none is stated.'
  );
  L.push(
    `- Latency per request: median ${f(a.latencyMs.median, 0)} ms, p95 ${f(a.latencyMs.p95, 0)} ms, max ${f(a.latencyMs.max, 0)} ms.`
  );
  for (const r of a.runs)
    L.push(
      `- Stage \`${r.stage}\`: ${r.ok}/${r.requests} ok, ${r.wallMs} ms wall time, concurrency ${r.concurrency}.`
    );
  L.push('');

  for (const split of SPLITS) {
    const note =
      split === 'dev'
        ? 'post-hoc: the shortlist rule was motivated by dev pairs; not independent validation'
        : 'written after the shortlist rule was fixed; same author, 3-4 pairs per label: weak evidence';
    L.push(`## ${split} (${note})`, '');
    L.push(
      '| label | pairs | duplicate | leakage | review | distinct | seed copy (code rule) |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: |'
    );
    for (const label of LABELS) {
      const c = a.cells[split][label];
      L.push(
        `| ${label} | ${c.pairs} | ${c.counts.duplicate} | ${c.counts.leakage} | ${c.counts.review} | ${c.counts.distinct} | ${c.counts.seed_variant} |`
      );
    }
    L.push('');
    const c = a.cells[split];
    const dup = c.duplicate_question;
    const leak = c.answer_leakage;
    const rel = c.related_distinct;
    const seed = c.seed_variant;
    L.push(
      `- **Duplicates:** flagged as duplicate ${rate(dup.counts.duplicate, dup.pairs)}; flagged only as leakage ${dup.counts.leakage}; sent to review ${dup.counts.review}; **missed** ${rate(dup.counts.distinct, dup.pairs)}.`
    );
    L.push(
      `- **Answer leakage:** flagged as leakage ${rate(leak.counts.leakage, leak.pairs)}; flagged as duplicate ${leak.counts.duplicate}; sent to review ${leak.counts.review}; **missed** ${rate(leak.counts.distinct, leak.pairs)}.`
    );
    L.push(
      `- **related_distinct false positives:** ${rate(rel.counts.duplicate + rel.counts.leakage, rel.pairs)} flagged (duplicate ${rel.counts.duplicate}, leakage ${rel.counts.leakage}); a further ${rel.counts.review} sent to review; ${rel.counts.distinct} correctly distinct.`
    );
    L.push(
      `- **Seed variants:** ${rate(seed.counts.seed_variant, seed.pairs)} classed as seed copies by the code rule; the model alone would have called ${rate(seed.modelOnlyDuplicates, seed.pairs)} duplicates.`
    );
    L.push('');
    L.push(
      'Median [min-max] probability by label:',
      '',
      '| label | same_fact | same_answer | leakage |',
      '| --- | --- | --- | --- |'
    );
    for (const label of LABELS) {
      const p = c[label].probs;
      const cell = (n) => `${f(p[n].median)} [${f(p[n].min)}-${f(p[n].max)}]`;
      L.push(`| ${label} | ${cell('same_fact')} | ${cell('same_answer')} | ${cell('leakage')} |`);
    }
    L.push('');
    const listed = [];
    for (const r of c.duplicate_question.rows.filter((r) => r.verdict !== 'duplicate'))
      listed.push(['missed/uncertain duplicate', r]);
    for (const r of c.answer_leakage.rows.filter(
      (r) => r.verdict !== 'leakage' && r.verdict !== 'duplicate'
    ))
      listed.push(['missed/uncertain leakage', r]);
    for (const r of c.related_distinct.rows.filter(
      (r) => r.verdict === 'duplicate' || r.verdict === 'leakage'
    ))
      listed.push(['FALSE POSITIVE on related_distinct', r]);
    for (const r of c.related_distinct.rows.filter((r) => r.verdict === 'review'))
      listed.push(['related_distinct sent to review', r]);
    if (listed.length > 0) {
      L.push('Pairs to inspect:', '');
      for (const [why, r] of listed) {
        L.push(
          `- ${r.id} ${why} (verdict ${r.verdict}; fact ${f(r.probs.same_fact)}, answer ${f(r.probs.same_answer)}, leakage ${f(r.probs.leakage)}): "${qById.get(r.candidate).question}" vs "${qById.get(r.existing).question}"`
        );
      }
      L.push('');
    }
  }
  L.push('## Caveats', '');
  L.push(
    '- Thresholds and question wording were fixed in advance and not tuned on either split; no threshold sweep was run. Nothing here selects a production threshold.'
  );
  L.push(
    '- Labels and pairs were written by one author and the dev split is post-hoc, so these numbers are a smoke test. Independent examples are needed before any app integration.'
  );
  L.push('- Unlabeled pool pairs were not judged, so precision on real traffic is unmeasured.');
  L.push(
    '- The alias `jev-latest` can move to a new model version; each raw row records the resolved model.'
  );
  return L.join('\n') + '\n';
}

function main() {
  const rawPath = join(HERE, 'results', 'raw-judgments.jsonl');
  if (!existsSync(rawPath)) {
    console.error('no results/raw-judgments.jsonl yet');
    process.exit(2);
  }
  const rows = readFileSync(rawPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const data = JSON.parse(readFileSync(join(HERE, 'pairs.json'), 'utf8'));
  const runsPath = join(HERE, 'results', 'runs.json');
  const runs = existsSync(runsPath) ? JSON.parse(readFileSync(runsPath, 'utf8')) : [];
  const a = analyze(rows, data, runs);
  if (process.argv.includes('--json')) {
    const { judged, ...rest } = a;
    console.log(JSON.stringify(rest, null, 2));
    return;
  }
  const report = formatReport(a, new Map(data.questions.map((q) => [q.id, q])));
  console.log(report);
  if (process.argv.includes('--write')) writeFileSync(join(HERE, 'results', 'report.md'), report);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();

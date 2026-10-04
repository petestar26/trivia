#!/usr/bin/env node
/**
 * Offline report for the independent flow: full-flow category confusion (human label x system
 * outcome, including "not shortlisted"), missed pairs split by stage, false positives on hard
 * negatives, and the human-review workload. Uses the fixed thresholds from typesafe-questions.mjs;
 * nothing is tuned. No network.
 *
 * Before reporting anything it verifies the freeze: labels.json must still match the SHA-256 in
 * freeze.json (and still validate), and every result row must carry a timestamp at or after the
 * freeze. Otherwise it exits with code 2 and writes nothing.
 *
 * Usage: node tools/question-dedup-pilot/analyze-flow.mjs [--dir DIR] [--write]
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FINAL_LABELS,
  POSITIVES,
  SHORTLIST_K,
  finalLabel,
  findResultsBeforeFreeze,
  pairKey,
  shortlistPairs,
  verifyFrozen,
} from './independent-set.mjs';
import { readRaw } from './flow.mjs';
import { THRESHOLDS, readProbabilities, verdictFor } from './typesafe-questions.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const COLUMNS = [
  'not_shortlisted',
  'duplicate',
  'leakage',
  'review',
  'distinct',
  'seed_variant',
  'not_judged',
];

const quantile = (values, q) => {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  return s[Math.floor(pos)] + (s[Math.ceil(pos)] - s[Math.floor(pos)]) * (pos - Math.floor(pos));
};

export function analyzeFlow(data, rawRows, k = SHORTLIST_K) {
  const shortlisted = new Set(shortlistPairs(data, k).map((p) => pairKey(p.candidate, p.existing)));
  const raw = new Map();
  for (const r of rawRows) if (r.ok) raw.set(r.pairId, r);

  const outcome = (p) => {
    const key = pairKey(p.candidate, p.existing);
    if (!shortlisted.has(key)) return { column: 'not_shortlisted', probs: null };
    const row = raw.get(key);
    if (!row) return { column: 'not_judged', probs: null };
    if (row.apiSkipped) return { column: 'seed_variant', probs: null };
    const probs = readProbabilities(row.response);
    if (probs === null) return { column: 'not_judged', probs: null };
    return { column: verdictFor(probs), probs };
  };

  const rows = data.pairs.map((p) => ({ ...p, final: finalLabel(p), ...outcome(p) }));
  const confusion = Object.fromEntries(
    FINAL_LABELS.map((l) => [l, Object.fromEntries(COLUMNS.map((c) => [c, 0]))])
  );
  for (const r of rows) confusion[r.final][r.column] += 1;

  const positives = rows.filter((r) => POSITIVES.includes(r.final));
  const negatives = rows.filter((r) => r.final === 'related_distinct' || r.final === 'unrelated');
  const flagged = (r) => r.column === 'duplicate' || r.column === 'leakage';
  const inScope = rows.filter((r) => r.column !== 'not_shortlisted');
  const candidates = data.questions.filter((q) => q.role === 'candidate').length;
  const reviewRows = rows.filter((r) => r.column === 'review');
  const flaggedRows = rows.filter(flagged);
  const judgedRows = rows.filter(
    (r) =>
      raw.has(pairKey(r.candidate, r.existing)) &&
      !raw.get(pairKey(r.candidate, r.existing)).apiSkipped
  );
  const apiRows = [...raw.values()].filter((r) => !r.apiSkipped);
  const shortlistedCount = shortlisted.size;

  const ambiguous = rows.filter((r) => r.ambiguous);
  return {
    thresholds: THRESHOLDS,
    shortlistK: SHORTLIST_K,
    candidates,
    labeledPairs: rows.length,
    shortlistedPairs: shortlistedCount,
    pairsInRawFile: raw.size,
    confusion,
    funnel: {
      positives: positives.length,
      shortlisted: positives.filter((r) => r.column !== 'not_shortlisted').length,
      flagged: positives.filter(flagged).length,
      review: positives.filter((r) => r.column === 'review').length,
      missedAtShortlist: positives.filter((r) => r.column === 'not_shortlisted'),
      missedAtTypeSafe: positives.filter((r) => r.column === 'distinct'),
      wrongType: positives.filter(
        (r) =>
          (r.final === 'duplicate_question' && r.column === 'leakage') ||
          (r.final === 'answer_leakage' && r.column === 'duplicate')
      ),
      notJudged: rows.filter((r) => r.column === 'not_judged'),
    },
    falsePositives: negatives.filter(flagged),
    hardNegativesInReview: negatives.filter((r) => r.column === 'review'),
    workload: {
      review: reviewRows.length,
      reviewTruePositives: reviewRows.filter((r) => POSITIVES.includes(r.final)).length,
      reviewNegatives: reviewRows.filter((r) => !POSITIVES.includes(r.final)).length,
      flagged: flaggedRows.length,
      reviewPer100Candidates: candidates ? (100 * reviewRows.length) / candidates : null,
      reviewPlusFlaggedPer100Candidates: candidates
        ? (100 * (reviewRows.length + flaggedRows.length)) / candidates
        : null,
      judgedPairsPerCandidate: candidates ? shortlistedCount / candidates : null,
    },
    ambiguous: {
      pairs: ambiguous.length,
      confusion: Object.fromEntries(
        FINAL_LABELS.map((l) => [
          l,
          Object.fromEntries(
            COLUMNS.map((c) => [c, ambiguous.filter((r) => r.final === l && r.column === c).length])
          ),
        ])
      ),
      rows: ambiguous,
    },
    inScope: inScope.length,
    cost: {
      requests: apiRows.length,
      inputTokens: apiRows.reduce((n, r) => n + (r.response?.usage?.input_tokens ?? 0), 0),
      outputTokens: apiRows.reduce((n, r) => n + (r.response?.usage?.output_tokens ?? 0), 0),
      latencyMedianMs: quantile(
        apiRows.map((r) => r.latencyMs),
        0.5
      ),
      latencyP95Ms: quantile(
        apiRows.map((r) => r.latencyMs),
        0.95
      ),
      latencyMaxMs: quantile(
        apiRows.map((r) => r.latencyMs),
        1
      ),
    },
  };
}

const f = (x, d = 1) => (x === null || x === undefined ? '-' : x.toFixed(d));

export function formatFlowReport(a, data, freeze) {
  const q = new Map(data.questions.map((x) => [x.id, x]));
  const desc = (r) =>
    `${r.candidate} vs ${r.existing} (final ${r.final}${r.ambiguous ? ', resolved from ambiguous' : ''}${r.probs ? `; fact ${f(r.probs.same_fact, 2)}, answer ${f(r.probs.same_answer, 2)}, leakage ${f(r.probs.leakage, 2)}` : ''}): "${q.get(r.candidate).question}" vs "${q.get(r.existing).question}"`;
  const L = ['# Independent flow report (shortlist, then TypeSafe)', ''];
  L.push(
    `Labeler: ${freeze?.labeler ?? 'unknown'}; labels frozen ${freeze?.frozenAt ?? 'unknown'} (sha256 ${freeze?.sha256?.slice(0, 12) ?? '-'}...). Labels were written blind to TypeSafe output.`
  );
  L.push(
    `Shortlist K=${a.shortlistK}. Thresholds unchanged from the pilot: flag >= ${a.thresholds.high}, review >= ${a.thresholds.review}, duplicate also needs same_answer >= ${a.thresholds.sameAnswerMin}.`
  );
  L.push(
    `${a.candidates} candidates, ${a.labeledPairs} labeled pairs, ${a.shortlistedPairs} shortlisted pairs, ${a.pairsInRawFile} judged/recorded.`,
    ''
  );
  L.push('## Category confusion (human final label x full-flow outcome)', '');
  L.push(
    `| human label | ${COLUMNS.join(' | ')} |`,
    `| --- | ${COLUMNS.map(() => '---:').join(' | ')} |`
  );
  for (const l of FINAL_LABELS)
    L.push(`| ${l} | ${COLUMNS.map((c) => a.confusion[l][c]).join(' | ')} |`);
  L.push(
    '',
    '"not_shortlisted" means the shortlist never surfaced the pair, so TypeSafe never saw it. seed_variant is decided by the code rule.',
    ''
  );
  const fu = a.funnel;
  L.push('## Funnel for duplicate and leakage pairs', '');
  L.push(
    `- Positive pairs: ${fu.positives}. Shortlisted: ${fu.shortlisted}. Flagged (duplicate or leakage): ${fu.flagged}. Sent to review: ${fu.review}.`
  );
  L.push(
    `- **Missed at the shortlist:** ${fu.missedAtShortlist.length}. **Missed at TypeSafe (judged distinct):** ${fu.missedAtTypeSafe.length}. Right pair, wrong type: ${fu.wrongType.length}. Not judged: ${fu.notJudged.length}.`,
    ''
  );
  const list = (title, rows) => {
    if (rows.length === 0) return;
    L.push(`### ${title}`, '');
    for (const r of rows) L.push(`- ${desc(r)}`);
    L.push('');
  };
  list('Missed at the shortlist', fu.missedAtShortlist);
  list('Missed at TypeSafe (judged distinct)', fu.missedAtTypeSafe);
  list('Wrong type (duplicate vs leakage swapped)', fu.wrongType);
  list('Not judged (failed or missing requests)', fu.notJudged);
  L.push('## False positives on hard negatives', '');
  L.push(
    `- related_distinct / unrelated pairs flagged as duplicate or leakage: **${a.falsePositives.length}**.`,
    ''
  );
  list('Flagged negatives', a.falsePositives);
  const w = a.workload;
  L.push('## Human-review workload', '');
  L.push(
    `- Pairs TypeSafe judges per candidate: ${f(w.judgedPairsPerCandidate)} (K=${a.shortlistK}).`
  );
  L.push(
    `- Review queue: ${w.review} pairs (${w.reviewTruePositives} true duplicate/leakage, ${w.reviewNegatives} negatives) = ${f(w.reviewPer100Candidates)} per 100 candidates.`
  );
  L.push(
    `- If flagged pairs also need human sign-off: ${w.review + w.flagged} pairs = ${f(w.reviewPlusFlaggedPer100Candidates)} per 100 candidates.`,
    ''
  );
  list('Hard negatives sent to review', a.hardNegativesInReview);
  if (a.ambiguous.pairs > 0) {
    L.push(
      `## Ambiguous pairs (${a.ambiguous.pairs}, resolved before scoring)`,
      '',
      `| human label | ${COLUMNS.join(' | ')} |`,
      `| --- | ${COLUMNS.map(() => '---:').join(' | ')} |`
    );
    for (const l of FINAL_LABELS)
      L.push(`| ${l} | ${COLUMNS.map((c) => a.ambiguous.confusion[l][c]).join(' | ')} |`);
    L.push('');
  }
  L.push('## Cost and latency', '');
  L.push(
    `- ${a.cost.requests} API requests; ${a.cost.inputTokens} input tokens, ${a.cost.outputTokens} output tokens. No dollar price is exposed by the API.`
  );
  L.push(
    `- Latency: median ${f(a.cost.latencyMedianMs, 0)} ms, p95 ${f(a.cost.latencyP95Ms, 0)} ms, max ${f(a.cost.latencyMaxMs, 0)} ms.`,
    ''
  );
  L.push('## Caveats', '');
  L.push('- The pair counts are small; treat percentages loosely and look at the listed pairs.');
  L.push(
    "- Labels are one labeler's judgment (ambiguous ones resolved as recorded). Duplicate-versus-leakage remains partly a definitional choice."
  );
  L.push(
    '- Thresholds were not tuned here. This report does not select production thresholds and does not cover live traffic or any game or payout flow.'
  );
  return L.join('\n') + '\n';
}

/**
 * Loads labels, freeze record and results only if they are trustworthy: the labels match the
 * frozen hash and no result was recorded before the freeze (or lacks a valid timestamp).
 * Throws otherwise.
 */
export function loadVerified(dir, opts) {
  const frozen = verifyFrozen(dir, opts);
  if (!frozen.ok) throw new Error(`cannot analyze: ${frozen.reason}`);
  const rows = readRaw(join(dir, 'results', 'raw-judgments.jsonl'));
  const early = findResultsBeforeFreeze(rows, frozen.freeze);
  if (early.length > 0) {
    throw new Error(
      `cannot analyze: ${early.length} result(s) predate the label freeze (${frozen.freeze.frozenAt}) or lack a valid timestamp, e.g. ${early[0].pairId}; they are not trustworthy`
    );
  }
  return { data: frozen.data, freeze: frozen.freeze, rows };
}

function main() {
  const argv = process.argv.slice(2);
  const dir = argv.includes('--dir') ? argv[argv.indexOf('--dir') + 1] : join(HERE, 'independent');
  let loaded;
  try {
    loaded = loadVerified(dir);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  const { data, freeze, rows } = loaded;
  const report = formatFlowReport(analyzeFlow(data, rows), data, freeze);
  console.log(report);
  if (argv.includes('--write')) writeFileSync(join(dir, 'results', 'report.md'), report);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();

#!/usr/bin/env node
/**
 * Full shortlist-then-TypeSafe flow on the frozen independent set. For each candidate, the top K
 * pool questions (deterministic, text only) are each sent to POST /v1/systemone with the same
 * fixed questions and thresholds as the labeled-pair pilot. Intentional "(set N)" copies are
 * classed by the code rule and never sent.
 *
 * Refuses to run unless independent/labels.json is frozen (hash matches freeze.json) and valid,
 * and refuses if any earlier result predates the freeze. A request is recorded as ok only when all
 * three probabilities are present and valid (judgeResponse). Writes only under <dir>/results/.
 * No database, app, competition, balance or payout access.
 *
 * Usage: node tools/question-dedup-pilot/flow.mjs [--dir DIR] [--dry-run] [--limit N]
 *          [--concurrency N] [--max-requests N]
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findResultsBeforeFreeze,
  pairKey,
  shortlistPairs,
  verifyFrozen,
} from './independent-set.mjs';
import { callWithRetry } from './typesafe-client.mjs';
import { buildRequest, isSeedVariantByRule, judgeResponse } from './typesafe-questions.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MAX_REQUESTS = 500;

export function readRaw(path) {
  return existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
}

export async function runFlow({
  dir,
  base,
  limit = null,
  concurrency = 4,
  maxRequests = DEFAULT_MAX_REQUESTS,
  dryRun = false,
  minimums,
  log = console.log,
}) {
  const frozen = verifyFrozen(dir, minimums ? { minimums } : undefined);
  if (!frozen.ok) throw new Error(`not runnable: ${frozen.reason}`);
  const { data, freeze } = frozen;
  const byId = new Map(data.questions.map((q) => [q.id, q]));
  const resultsDir = join(dir, 'results');
  const RAW = join(resultsDir, 'raw-judgments.jsonl');
  const RUNS = join(resultsDir, 'runs.json');
  const existing = readRaw(RAW);
  const early = findResultsBeforeFreeze(existing, freeze);
  if (early.length > 0)
    throw new Error(
      `${early.length} result(s) predate the label freeze (${freeze.frozenAt}) or lack a valid timestamp, e.g. ${early[0].pairId}; results are not trustworthy`
    );

  const pairs = shortlistPairs(data);
  const done = new Set(existing.filter((r) => r.ok).map((r) => r.pairId));
  const withRule = pairs.map((p) => ({
    ...p,
    key: pairKey(p.candidate, p.existing),
    seedCopy: isSeedVariantByRule(byId.get(p.candidate), byId.get(p.existing)),
  }));
  const apiPairs = withRule.filter((p) => !p.seedCopy);
  if (apiPairs.length > maxRequests)
    throw new Error(
      `would need ${apiPairs.length} API requests, over the --max-requests cap of ${maxRequests}`
    );
  const todo = withRule.filter((p) => !done.has(p.key));
  const batch = limit === null ? todo : todo.slice(0, limit);
  log(
    `shortlisted pairs ${pairs.length} (${apiPairs.length} for the API, ${pairs.length - apiPairs.length} seed copies by rule); pending ${todo.length}; this run ${batch.length}${dryRun ? ' [dry run]' : ''}`
  );
  if (dryRun) return { sent: 0, ok: 0, pending: todo.length };

  mkdirSync(resultsDir, { recursive: true });
  const startedAt = new Date().toISOString();
  const wallStart = performance.now();
  let ok = 0;
  let sent = 0;
  let next = 0;
  const worker = async () => {
    while (next < batch.length) {
      const p = batch[next++];
      const requestedAt = new Date().toISOString();
      if (p.seedCopy) {
        appendFileSync(
          RAW,
          JSON.stringify({
            pairId: p.key,
            candidate: p.candidate,
            existing: p.existing,
            requestedAt,
            ok: true,
            apiSkipped: true,
            reason: 'seed-copy code rule',
          }) + '\n'
        );
        ok += 1;
        continue;
      }
      const request = buildRequest(byId.get(p.candidate), byId.get(p.existing));
      const r = await callWithRetry(request, { base });
      sent += 1;
      const verdict = judgeResponse(r.status, r.json);
      if (verdict.ok) ok += 1;
      appendFileSync(
        RAW,
        JSON.stringify({
          pairId: p.key,
          candidate: p.candidate,
          existing: p.existing,
          requestedAt,
          ok: verdict.ok,
          status: r.status,
          attempts: r.attempts,
          latencyMs: r.latencyMs,
          request,
          response: verdict.ok ? r.json : undefined,
          failure: verdict.ok ? undefined : verdict.reason,
          error: verdict.ok
            ? undefined
            : (r.error ?? r.text ?? JSON.stringify(r.json)?.slice(0, 500)),
        }) + '\n'
      );
      log(`${p.key} ${verdict.ok ? 'ok' : 'FAIL ' + verdict.reason} ${r.latencyMs}ms`);
    }
  };
  await Promise.all(Array.from({ length: limit !== null ? 1 : concurrency }, worker));
  const runs = existsSync(RUNS) ? JSON.parse(readFileSync(RUNS, 'utf8')) : [];
  runs.push({
    startedAt,
    endedAt: new Date().toISOString(),
    wallMs: Math.round(performance.now() - wallStart),
    concurrency: limit !== null ? 1 : concurrency,
    requests: batch.length,
    sent,
    ok,
  });
  writeFileSync(RUNS, JSON.stringify(runs, null, 2) + '\n');
  return { sent, ok, pending: todo.length - ok };
}

function parseArgs(argv) {
  const o = {
    dir: join(HERE, 'independent'),
    dryRun: false,
    limit: null,
    concurrency: 4,
    maxRequests: DEFAULT_MAX_REQUESTS,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') o.dir = argv[++i];
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--limit') o.limit = Number(argv[++i]);
    else if (a === '--concurrency') o.concurrency = Number(argv[++i]);
    else if (a === '--max-requests') o.maxRequests = Number(argv[++i]);
    else throw new Error(`unknown argument ${a}`);
  }
  if (o.limit !== null && !(Number.isInteger(o.limit) && o.limit > 0))
    throw new Error('--limit must be a positive integer');
  if (!Number.isInteger(o.concurrency) || o.concurrency < 1 || o.concurrency > 8)
    throw new Error('--concurrency must be 1-8');
  return o;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runFlow(parseArgs(process.argv.slice(2)))
    .then((r) => {
      if (r.pending > 0 && !process.argv.includes('--dry-run') && !process.argv.includes('--limit'))
        process.exitCode = 1;
    })
    .catch((e) => {
      console.error(e.message);
      process.exit(2);
    });
}

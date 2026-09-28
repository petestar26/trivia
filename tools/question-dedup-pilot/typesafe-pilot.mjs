#!/usr/bin/env node
/**
 * Bounded TypeSafe pilot runner. Sends each labeled pair to POST /v1/systemone (one request per
 * pair, three noul questions in it) and appends the raw request, response, status and latency to
 * results/raw-judgments.jsonl.
 *
 * Reads only pairs.json. Writes only under results/. It touches no database, seed, route,
 * competition, balance or payout code, and never changes any question.
 *
 * Stages:  --stage sample   12 pairs (first/middle/last dev pair per label), sequential
 *          --stage expand   every remaining labeled pair not already in the raw file
 * Options: --dry-run (print payloads, send nothing)  --concurrency N (expand only, default 4)
 *          --out-dir DIR (default results/)
 *
 * A request is recorded as ok only if the HTTP status is 200 AND all three probabilities are present,
 * numeric and within [0, 1] (see judgeResponse). Anything else is stored as a failure and re-sent
 * on the next run.
 *
 * Network: through the environment proxy, run with NODE_USE_ENV_PROXY=1 and
 * NODE_EXTRA_CA_CERTS=<ca bundle>. Auth: TYPESAFE_API_KEY (Bearer) if set; otherwise no header is
 * sent, which works only where a proxy injects credentials. The key is never logged or written.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LABELS } from './evaluate.mjs';
import { callWithRetry } from './typesafe-client.mjs';
import { QUESTIONS, buildRequest, judgeResponse, samplePairIds } from './typesafe-questions.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
function parseArgs(argv) {
  const o = { stage: null, dryRun: false, concurrency: 4, outDir: join(HERE, 'results') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--stage') o.stage = argv[++i];
    else if (argv[i] === '--dry-run') o.dryRun = true;
    else if (argv[i] === '--concurrency') o.concurrency = Number(argv[++i]);
    else if (argv[i] === '--out-dir') o.outDir = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!['sample', 'expand'].includes(o.stage)) throw new Error('--stage must be sample or expand');
  if (!Number.isInteger(o.concurrency) || o.concurrency < 1 || o.concurrency > 8) {
    throw new Error('--concurrency must be 1-8');
  }
  return o;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const data = JSON.parse(readFileSync(join(HERE, 'pairs.json'), 'utf8'));
  const byId = new Map(data.questions.map((q) => [q.id, q]));
  const RAW = join(opts.outDir, 'raw-judgments.jsonl');
  const RUNS = join(opts.outDir, 'runs.json');
  mkdirSync(opts.outDir, { recursive: true });

  const done = new Set(
    existsSync(RAW)
      ? readFileSync(RAW, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
          .filter((r) => r.ok)
          .map((r) => r.pairId)
      : []
  );
  const sampleIds = new Set(samplePairIds(data.pairs, LABELS));
  const todo = data.pairs.filter(
    (p) => !done.has(p.id) && (opts.stage === 'sample' ? sampleIds.has(p.id) : !sampleIds.has(p.id))
  );
  console.log(
    `stage=${opts.stage} pairs to send: ${todo.length} (already done: ${done.size})${opts.dryRun ? ' [dry run]' : ''}`
  );
  console.log(`questions per request: ${Object.keys(QUESTIONS).join(', ')}`);

  if (opts.dryRun) {
    for (const p of todo.slice(0, 2))
      console.log(
        JSON.stringify(
          { pair: p.id, request: buildRequest(byId.get(p.candidate), byId.get(p.existing)) },
          null,
          1
        )
      );
    return;
  }

  const startedAt = new Date().toISOString();
  const wallStart = performance.now();
  let ok = 0;
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const p = todo[next++];
      const request = buildRequest(byId.get(p.candidate), byId.get(p.existing));
      const requestedAt = new Date().toISOString();
      const r = await callWithRetry(request);
      const verdict = judgeResponse(r.status, r.json);
      const good = verdict.ok;
      if (good) ok += 1;
      appendFileSync(
        RAW,
        JSON.stringify({
          pairId: p.id,
          split: p.split,
          label: p.label,
          candidate: p.candidate,
          existing: p.existing,
          stage: opts.stage,
          requestedAt,
          ok: Boolean(good),
          status: r.status,
          attempts: r.attempts,
          latencyMs: r.latencyMs,
          request,
          response: good ? r.json : undefined,
          failure: good ? undefined : verdict.reason,
          error: good ? undefined : (r.error ?? r.text ?? JSON.stringify(r.json)?.slice(0, 500)),
        }) + '\n'
      );
      const u = r.json?.usage;
      console.log(
        `${p.id} ${p.split}/${p.label} ${good ? 'ok' : 'FAIL ' + verdict.reason + ' ' + (r.error ?? '')} ${r.latencyMs}ms` +
          (u ? ` in=${u.input_tokens} out=${u.output_tokens}` : '')
      );
    }
  };
  await Promise.all(Array.from({ length: opts.stage === 'sample' ? 1 : opts.concurrency }, worker));

  const runs = existsSync(RUNS) ? JSON.parse(readFileSync(RUNS, 'utf8')) : [];
  runs.push({
    stage: opts.stage,
    startedAt,
    endedAt: new Date().toISOString(),
    wallMs: Math.round(performance.now() - wallStart),
    concurrency: opts.stage === 'sample' ? 1 : opts.concurrency,
    requests: todo.length,
    ok,
  });
  writeFileSync(RUNS, JSON.stringify(runs, null, 2) + '\n');
  console.log(`done: ${ok}/${todo.length} ok`);
  if (ok < todo.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e.message);
  process.exit(2);
});

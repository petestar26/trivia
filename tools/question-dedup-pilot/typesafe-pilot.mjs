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
 *
 * Network: through the environment proxy, run with NODE_USE_ENV_PROXY=1 and
 * NODE_EXTRA_CA_CERTS=<ca bundle>. Auth: TYPESAFE_API_KEY (Bearer) if set; otherwise no header is
 * sent, which works only where a proxy injects credentials. The key is never logged or written.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LABELS } from './evaluate.mjs';
import { QUESTIONS, buildRequest, samplePairIds } from './typesafe-questions.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, 'results');
const RAW = join(RESULTS, 'raw-judgments.jsonl');
const RUNS = join(RESULTS, 'runs.json');
const BASE = process.env.TYPESAFE_API_BASE ?? 'https://api.typesafe.ai';
const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callOnce(body) {
  const headers = { 'content-type': 'application/json' };
  if (process.env.TYPESAFE_API_KEY)
    headers.authorization = `Bearer ${process.env.TYPESAFE_API_KEY}`;
  const started = performance.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/v1/systemone`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* keep text */
    }
    return {
      status: res.status,
      latencyMs: Math.round(performance.now() - started),
      json,
      text: json ? undefined : text.slice(0, 500),
    };
  } catch (err) {
    return {
      status: 0,
      latencyMs: Math.round(performance.now() - started),
      error: String(err?.cause?.code ?? err?.message ?? err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Retries only transient failures (network error, 429, 5xx); a 4xx is a bug and is not retried. */
async function callWithRetry(body) {
  let last;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    last = await callOnce(body);
    const transient = last.status === 0 || last.status === 429 || last.status >= 500;
    if (!transient) return { ...last, attempts: attempt };
    if (attempt < MAX_ATTEMPTS) await sleep(1000 * 2 ** (attempt - 1));
  }
  return { ...last, attempts: MAX_ATTEMPTS };
}

function parseArgs(argv) {
  const o = { stage: null, dryRun: false, concurrency: 4 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--stage') o.stage = argv[++i];
    else if (argv[i] === '--dry-run') o.dryRun = true;
    else if (argv[i] === '--concurrency') o.concurrency = Number(argv[++i]);
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
  mkdirSync(RESULTS, { recursive: true });

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
      const good = r.status === 200 && r.json?.answers;
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
          error: good ? undefined : (r.error ?? r.text ?? JSON.stringify(r.json)?.slice(0, 500)),
        }) + '\n'
      );
      const u = r.json?.usage;
      console.log(
        `${p.id} ${p.split}/${p.label} ${good ? 'ok' : 'FAIL ' + (r.status || r.error)} ${r.latencyMs}ms` +
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

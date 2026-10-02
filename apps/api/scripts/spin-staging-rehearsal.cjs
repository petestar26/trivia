/** Disposable private staging acceptance. Never run as an API/worker command. */
const crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const STREAM = 'spin-win-practice-v1';
const API = 'http://spin-practice-api-20261002.railway.internal:8080';
const HEALTH = 'http://spin-practice-worker-20261002.railway.internal:1444/health';
const signal = new AbortController();
let stage = 'TARGET';
let db;
let faulted = false;
let touchedStream = false;
let deadline;
const check = (condition) => { if (!condition) throw new Error('refused'); };
const log = (step, extra = {}) => console.log(JSON.stringify({ status: 'PASS', step, mode: 'PRACTICE', coinsAccepted: false, ...extra }));

function guard() {
  const url = new URL(process.env.DATABASE_URL || '');
  check(process.env.RAILWAY_ENVIRONMENT_ID === '7de0c716-24df-4e97-a998-ed99abfa256f');
  check(process.env.PRACTICE_STAGING_ACK === 'spin-practice-rehearsal-20261002');
  check(['postgres:', 'postgresql:'].includes(url.protocol));
  check(url.hostname === 'spin-practice-db-20261002.railway.internal');
  check(url.pathname === '/playqube_spin_rehearsal_20261002');
}
async function sleep(ms) { await delay(ms, undefined, { signal: signal.signal }); }
async function request(path, token, body) {
  check(!signal.signal.aborted);
  const r = await fetch(API + '/api/v1' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  return { status: r.status, body: await r.json() };
}
async function health() {
  try {
    const r = await fetch(HEALTH, { signal: AbortSignal.timeout(3000) });
    const body = await r.json();
    check(body.mode === 'PRACTICE' && body.coinsAccepted === false);
    return { httpStatus: r.status, ready: body.ready, status: body.status };
  } catch { return { httpStatus: 0, ready: false }; }
}
async function snapshot(token) {
  const r = await request('/games/scheduled/spin-win', token);
  check(r.status === 200 && r.body.success === true);
  const d = r.body.data;
  check(d.mode === 'PRACTICE' && d.coinsAccepted === false);
  return d;
}
async function account() {
  const suffix = crypto.randomBytes(6).toString('hex');
  const r = await request('/auth/register', undefined, {
    username: 'spincheck_' + suffix, email: 'spincheck_' + suffix + '@example.invalid',
    password: 'Aa1!' + crypto.randomBytes(24).toString('hex'),
  });
  check(r.status === 201 && r.body.success === true && typeof r.body.data.accessToken === 'string');
  return { token: r.body.data.accessToken, refresh: r.body.data.refreshToken };
}
async function waitOpen(token) {
  const until = Date.now() + 75000;
  while (Date.now() < until) {
    const s = await snapshot(token);
    const r = s.rounds.find(r => r.state === 'OPEN' && r.opensAt <= s.serverTime && r.closesAt - s.serverTime >= 12000);
    if (r) return { s, r };
    await sleep(1000);
  }
  throw new Error('refused');
}
async function stream(enabled) {
  touchedStream = true;
  check(await db.$executeRawUnsafe('UPDATE public.scheduled_game_streams SET enabled=$1 WHERE id=$2', enabled, STREAM) === 1);
}
async function stored() {
  return db.$queryRawUnsafe('SELECT id,sequence,state,outcome,drawn_at FROM public.scheduled_game_rounds WHERE stream_id=$1 ORDER BY sequence', STREAM);
}
async function ticket(token, roundId, marketId = 'red') {
  return request('/games/scheduled/spin-win/tickets', token, { roundId, bets: [{ marketId, amount: 40 }] });
}
async function waitHealthy() {
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    const h = await health();
    if (h.httpStatus === 200 && h.ready === true) return;
    await sleep(1000);
  }
  throw new Error('refused');
}
async function main() {
  guard();
  const { PrismaClient } = require(require('node:path').resolve(process.cwd(), 'packages/database/node_modules/@prisma/client'));
  db = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL, log: [] });
  const [owner] = await db.$queryRawUnsafe('SELECT current_user::text=pg_get_userbyid(datdba) AS owns FROM pg_database WHERE datname=current_database()');
  check(owner?.owns === true);
  deadline = setTimeout(() => signal.abort(), 8 * 60 * 1000);
  process.once('SIGTERM', () => signal.abort());
  process.once('SIGINT', () => signal.abort());
  try {
    stage = 'PAUSED_BASELINE';
    await waitHealthy();
    const [baseline] = await db.$queryRawUnsafe('SELECT enabled FROM public.scheduled_game_streams WHERE id=$1', STREAM);
    check(baseline?.enabled === false && (await stored()).length === 0);
    log(stage);
    stage = 'STAGING_AUTH';
    const primary = await account();
    const late = await account();
    const rotated = await request('/auth/refresh', undefined, { refreshToken: primary.refresh });
    check(rotated.status === 200 && rotated.body.success === true);
    primary.token = rotated.body.data.accessToken;
    log(stage);
    stage = 'OPEN_TICKET';
    await stream(true);
    const { r: round } = await waitOpen(primary.token);
    check(round.closesAt - round.opensAt === 45000 && round.revealEndsAt - round.closesAt === 10000 && round.endsAt - round.revealEndsAt === 5000);
    const accepted = await ticket(primary.token, round.id);
    check(accepted.status === 201 && accepted.body.data.isReplay === false && accepted.body.data.coinsAccepted === false);
    check((await ticket(primary.token, round.id)).status === 200);
    check((await ticket(primary.token, round.id, 'black')).status === 409);
    check((await snapshot(primary.token)).rounds.find(r => r.id === round.id)?.ticket?.stake === 40);
    log(stage, { roundId: round.id });
    stage = 'PAUSE_ENTRY';
    await stream(false);
    check((await ticket(late.token, round.id)).status === 409);
    check((await ticket(primary.token, round.id)).status === 200);
    log(stage);
    stage = 'DATABASE_FAILURE';
    // Reversible read failure on exactly one disposable worker role. No role/password/owner change.
    await db.$executeRawUnsafe('REVOKE SELECT ON public.scheduled_game_streams FROM "spin_rehearsal_worker_20261002"');
    faulted = true;
    const start = Date.now();
    await sleep(3000);
    const unhealthy = await health();
    check(unhealthy.httpStatus === 503 && unhealthy.ready === false);
    log('FAILURE_READINESS', { httpStatus: 503 });
    while (Date.now() - start < 72000) await sleep(Math.min(1000, 72000 - (Date.now() - start)));
    const beforeRecovery = await stored();
    check(beforeRecovery.length === 1 && beforeRecovery[0].state === 'OPEN' && beforeRecovery[0].outcome === null);
    check(Date.now() > round.closesAt);
    check((await ticket(late.token, round.id)).status === 409);
    log('NO_PARTIAL_DRAW_DURING_FAILURE');
    await db.$executeRawUnsafe('GRANT SELECT ON public.scheduled_game_streams TO "spin_rehearsal_worker_20261002"');
    faulted = false;
    stage = 'RECOVERY';
    await waitHealthy();
    const recovered = await stored();
    check(recovered.length === 1 && recovered[0].id === round.id && recovered[0].state === 'DRAWN');
    check(Number.isInteger(recovered[0].outcome) && recovered[0].outcome >= 0 && recovered[0].outcome <= 36 && recovered[0].drawn_at instanceof Date);
    const fixedOutcome = recovered[0].outcome;
    const visible = (await snapshot(primary.token)).rounds.find(r => r.id === round.id);
    check(visible?.outcome === fixedOutcome && visible.ticket?.stake === 40 && Number.isFinite(visible.ticket?.payout));
    const red = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
    check(visible.ticket.payout === (red.has(fixedOutcome) ? 74 : 0));
    check((await ticket(primary.token, round.id)).status === 200);
    const [count] = await db.$queryRawUnsafe('SELECT count(*)::int AS tickets FROM public.scheduled_practice_tickets WHERE round_id=$1', round.id);
    check(count.tickets === 1);
    log('RECOVERED_TICKET_AND_ONE_DRAW', { roundId: round.id, outcome: fixedOutcome, tickets: 1 });
    stage = 'REDEPLOY_WINDOW';
    // The operator can redeploy the worker during this bounded private observation window.
    for (let i = 0; i < 6; i++) {
      await sleep(20000);
      const rows = await stored();
      check(rows.length === 1 && rows[0].id === round.id && rows[0].outcome === fixedOutcome && rows[0].state === 'DRAWN');
      const s = await snapshot(primary.token);
      check(s.enabled === false && s.nextOpensAt === null && s.rounds.find(r => r.id === round.id)?.ticket?.stake === 40);
      log('PAUSED_IMMUTABLE_OBSERVATION', { elapsedSeconds: (i + 1) * 20 });
    }
    stage = 'NO_HISTORICAL_BACKFILL';
    await stream(true);
    check((await ticket(late.token, round.id)).status === 409);
    check((await ticket(primary.token, round.id)).status === 200);
    log('CLOSED_ROUND_CUTOFF_AND_RETRY');
    const { r: next } = await waitOpen(primary.token);
    await stream(false);
    const current = await stored();
    check(current.length === 2 && next.id !== round.id && BigInt(next.sequence) - BigInt(round.sequence) >= 3n);
    check(current[0].outcome === fixedOutcome);
    log(stage, { previousRoundId: round.id, nextRoundId: next.id });
    stage = 'PAUSED_OPEN_ROUND_FINISHES';
    const until = Date.now() + 60000;
    let finished = false;
    while (Date.now() < until) {
      const rows = await stored();
      if (rows.length === 2 && rows.every(r => r.state === 'DRAWN')) { finished = true; break; }
      await sleep(1000);
    }
    check(finished);
    await waitHealthy();
    const end = await snapshot(primary.token);
    check(end.enabled === false && end.nextOpensAt === null && end.rounds.length === 2);
    check(end.rounds.find(r => r.id === round.id)?.outcome === fixedOutcome);
    log('REHEARSAL_COMPLETE', { rounds: 2, tickets: 1, streamPaused: true });
  } finally {
    if (faulted) await db.$executeRawUnsafe('GRANT SELECT ON public.scheduled_game_streams TO "spin_rehearsal_worker_20261002"');
    if (touchedStream) await stream(false);
    clearTimeout(deadline);
  }
}
main().catch(() => {
  console.error(JSON.stringify({ status: 'REFUSED', stage, reason: 'STAGING_REHEARSAL_FAILED' }));
  process.exitCode = 1;
}).finally(async () => { clearTimeout(deadline); if (db) await db.$disconnect(); });

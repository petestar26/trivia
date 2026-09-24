// Drives the API and the worker as the documented runtime database role.
// Run outside Vitest (its setup files act as the owner) with DATABASE_URL
// naming the runtime role:
//   tsx src/test/runtime-role-harness.ts '<json input>'
// Prints one JSON line: { steps: [{ step, ok, detail }] }. The calling test
// prepares the fixtures and checks the results as the owner.
import { randomUUID } from 'node:crypto';
import { config } from '@socialplay/config';
import { prisma } from '@socialplay/database';
import { buildServer } from '../server.js';
import { generateTokens } from '../utils/auth.js';
import { enableLedgerGate } from '../economy/ledger-admin-service.js';
import { sweepWithdrawalTimeouts } from '../withdrawals/timeout-service.js';
import { runWithdrawalReconciliation } from '../withdrawals/reconciliation-service.js';
import { sweepExpiredCoinLots } from '../economy/coin-expiry-service.js';

interface HarnessInput {
  player: { id: string; username: string; email: string };
  adminA: { id: string; username: string; email: string };
  adminB: { id: string; username: string; email: string };
}

interface Step { step: string; ok: boolean; detail: unknown }

async function main() {
  const input = JSON.parse(process.argv[2] ?? '{}') as HarnessInput;
  const steps: Step[] = [];
  const server = await buildServer();
  await server.ready();
  const api = config.API_PREFIX;
  // The same access tokens a login issues.
  const headers = (user: HarnessInput['player'], role: string) => ({
    authorization: `Bearer ${generateTokens(user.id, user.email, user.username, [role]).accessToken}`,
  });
  const record = async (step: string, run: () => Promise<{ ok: boolean; detail: unknown }>) => {
    try {
      const result = await run();
      steps.push({ step, ...result });
    } catch (error) {
      steps.push({ step, ok: false, detail: String((error as Error).message ?? error).slice(0, 500) });
    }
  };

  try {
    const tag = randomUUID().replaceAll('-', '').slice(0, 12);
    await record('register and log in a new user', async () => {
      const credentials = { username: `rr_${tag}`, email: `rr-${tag}@test.local`, password: 'Runtime-Role-9!pass' };
      const registered = await server.inject({ method: 'POST', url: `${api}/auth/register`, payload: credentials,
        remoteAddress: '10.44.0.1' });
      const login = await server.inject({ method: 'POST', url: `${api}/auth/login`,
        payload: { email: credentials.email, password: credentials.password }, remoteAddress: '10.44.0.2' });
      return { ok: registered.statusCode === 201 && login.statusCode === 200,
        detail: { register: registered.statusCode, login: login.statusCode } };
    });

    await record('play a Coin game, then replay it exactly', async () => {
      const key = `rr-play-${tag}`;
      // The play route's header schema keeps only its own headers, so the
      // browser's access-token cookie authenticates it.
      const token = generateTokens(input.player.id, input.player.email, input.player.username, ['USER']).accessToken;
      const play = () => server.inject({ method: 'POST', url: `${api}/games/dice/play`,
        headers: { 'idempotency-key': key }, cookies: { sp_access_token: token }, payload: { betAmount: 10 } });
      const first = await play();
      const replay = await play();
      return { ok: first.statusCode === 201 && replay.statusCode === 200 && replay.json().data?.isReplay === true,
        detail: { first: first.statusCode, replay: replay.statusCode, body: first.statusCode === 201 ? undefined : first.body } };
    });

    let reviewLotId: string | null = null;
    await record('Coin adjustment: request, first approval, settling second approval', async () => {
      const requested = await server.inject({ method: 'POST', url: `${api}/ledger-admin/adjustments`,
        headers: headers(input.adminA, 'SUPER_ADMIN'), payload: { targetUserId: input.player.id,
          caseId: `rr-case-${tag}`, delta: 40, rationale: 'Runtime role end-to-end adjustment',
          supportingEvidence: ['rr-evidence'] } });
      const approvalId = requested.json().data?.approvalId as string | undefined;
      const first = await server.inject({ method: 'POST', url: `${api}/ledger-admin/adjustments/${approvalId}/first-approval`,
        headers: headers(input.adminA, 'SUPER_ADMIN') });
      const second = await server.inject({ method: 'POST', url: `${api}/ledger-admin/adjustments/${approvalId}/second-approval`,
        headers: headers(input.adminB, 'SUPER_ADMIN') });
      reviewLotId = second.json().data?.reviewLotId ?? null;
      return { ok: requested.statusCode === 201 && first.statusCode === 200 && second.statusCode === 201 && !!reviewLotId,
        detail: { request: requested.statusCode, first: first.statusCode, second: second.statusCode, approvalId,
          operationId: second.json().data?.operationId, body: second.statusCode === 201 ? undefined : second.body } };
    });

    await record('legacy review of that credit: first approval, then resolution', async () => {
      const review = await prisma.legacyBalanceReview.findFirstOrThrow({ where: { lotId: reviewLotId ?? '' } });
      const first = await server.inject({ method: 'POST', url: `${api}/ledger-admin/reviews/${review.id}/first-approval`,
        headers: headers(input.adminA, 'SUPER_ADMIN'), payload: { decision: 'WITHDRAWABLE',
          rationale: 'Runtime role end-to-end review', supportingEvidence: ['rr-review-evidence'] } });
      const second = await server.inject({ method: 'POST', url: `${api}/ledger-admin/reviews/${review.id}/second-approval`,
        headers: headers(input.adminB, 'SUPER_ADMIN') });
      return { ok: first.statusCode === 200 && [200, 201].includes(second.statusCode),
        detail: { reviewId: review.id, first: first.statusCode, second: second.statusCode,
          operationId: second.json().data?.operationId, body: [200, 201].includes(second.statusCode) ? undefined : second.body } };
    });

    await record('enable a ledger gate after a locked invariant scan', async () => {
      const result = await enableLedgerGate(input.adminA.id, 'BONUS_GRANT', {
        apiSuitePassed: true, exactReplayZeroWritesPassed: true, deterministicRacesPassed: true,
        financialMutationsCaught: true, migrationReplayPassed: true, runId: `rr-${tag}`,
      });
      return { ok: result.enabled === true, detail: result };
    });

    await record('worker: withdrawal timeouts, Coin expiry, reconciliation', async () => {
      const sweep = await sweepWithdrawalTimeouts();
      const expiry = await sweepExpiredCoinLots();
      const reconciliation = await runWithdrawalReconciliation();
      return { ok: true, detail: { sweep, expiry, reconciliation: { ...reconciliation, details: undefined } } };
    });

    await record('the runtime connection is the restricted role', async () => {
      const [row] = await prisma.$queryRaw<{ user: string; superuser: boolean }[]>`
        SELECT current_user AS "user", r."rolsuper" AS "superuser" FROM pg_roles r WHERE r."rolname" = current_user`;
      return { ok: row?.superuser === false, detail: row };
    });
  } finally {
    await server.close();
    await prisma.$disconnect();
  }
  process.stdout.write(`${JSON.stringify({ steps })}\n`);
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ fatal: String((error as Error).stack ?? error).slice(0, 2000) })}\n`);
  process.exit(1);
});

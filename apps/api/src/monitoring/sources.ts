import type { PrismaClient } from '@socialplay/database';

// Fixed, read-only projections. Never select ticket text, payment destinations,
// audit payloads, user identifiers, provider URLs, credentials, or game seeds.
// Samples are bounded; totals and truncation let a consumer detect missing detail.
const queue = (sql: string, limit = 20) => `WITH q AS (${sql})
  SELECT jsonb_build_object('total', (SELECT count(*) FROM q),
    'truncated', (SELECT count(*)>${limit} FROM q),
    'items', COALESCE((SELECT jsonb_agg(v) FROM
      (SELECT * FROM q ORDER BY at DESC,id LIMIT ${limit}) v),'[]'::jsonb)) AS data`;

export const MONITOR_QUERIES = {
  support: `WITH changed AS (
      SELECT id,category,status,last_sender,updated_at AS at FROM support_tickets
      WHERE updated_at>=now()-interval '15 minutes'),
    pending AS (SELECT id,category,updated_at AS at FROM support_tickets
      WHERE status='OPEN' AND last_sender='USER')
    SELECT jsonb_build_object(
      'awaitingStaff', (SELECT count(*) FROM pending),
      'oldestAwaitingAt', (SELECT min(at) FROM pending),
      'pendingTruncated', (SELECT count(*)>20 FROM pending),
      'pending', COALESCE((SELECT jsonb_agg(v) FROM
        (SELECT * FROM pending ORDER BY at,id LIMIT 20) v),'[]'::jsonb),
      'changedTotal', (SELECT count(*) FROM changed),
      'changedTruncated', (SELECT count(*)>50 FROM changed),
      'changed', COALESCE((SELECT jsonb_agg(v) FROM
        (SELECT * FROM changed ORDER BY at DESC,id LIMIT 50) v),'[]'::jsonb)) AS data`,
  paymentAttention: queue(`
    SELECT id,'DEPOSIT_APPEAL' AS kind,"openedAt" AS at FROM disputes WHERE status IN ('OPEN','ASSIGNED')
    UNION ALL SELECT id,'WITHDRAWAL_APPEAL',"openedAt" FROM withdrawal_disputes WHERE status IN ('OPEN','ASSIGNED')
    UNION ALL SELECT id,'LATE_PAYMENT_APPEAL',"openedAt" FROM late_payment_cases WHERE status IN ('OPEN','ASSIGNED')
    UNION ALL SELECT id,'DEPOSIT_RELEASE_OVERDUE',"releaseDeadlineAt" FROM agent_orders
      WHERE status='PAYMENT_SUBMITTED' AND "releaseDeadlineAt"<now()-interval '2 minutes'
    UNION ALL SELECT id,'WITHDRAWAL_PAYOUT_OVERDUE',"paymentSubmissionDeadlineAt" FROM withdrawals
      WHERE status IN ('HELD','PAYOUT_IN_PROGRESS') AND "paymentSubmissionDeadlineAt"<now()-interval '2 minutes'
    UNION ALL SELECT id,'WITHDRAWAL_CONFIRMATION_OVERDUE',"confirmationDeadlineAt" FROM withdrawals
      WHERE status='PAYMENT_SUBMITTED' AND "confirmationDeadlineAt"<now()-interval '2 minutes'
    UNION ALL SELECT id,'CRYPTO_DEPOSIT_REVIEW',"createdAt" FROM crypto_deposits WHERE status='REVIEW'
    UNION ALL SELECT id,'CRYPTO_DEPOSIT_CHECK_FAILED',"lastCheckedAt" FROM crypto_deposits
      WHERE status='WAITING' AND "checkError" IS NOT NULL
    UNION ALL SELECT id,'CRYPTO_WITHDRAWAL_WAITING',"createdAt" FROM crypto_withdrawals
      WHERE status IN ('HELD','PAYOUT_IN_PROGRESS')`),
  paymentActivity: `SELECT jsonb_build_object(
    'agentDepositsCreated24h',(SELECT count(*) FROM agent_orders WHERE "createdAt">=now()-interval '24 hours'),
    'agentDepositsCompleted24h',(SELECT count(*) FROM agent_orders WHERE "completedAt">=now()-interval '24 hours'),
    'agentWithdrawalsCreated24h',(SELECT count(*) FROM withdrawals WHERE "createdAt">=now()-interval '24 hours'),
    'agentWithdrawalsCompleted24h',(SELECT count(*) FROM withdrawals WHERE "completedAt">=now()-interval '24 hours'),
    'cryptoDepositsCreated24h',(SELECT count(*) FROM crypto_deposits WHERE "createdAt">=now()-interval '24 hours'),
    'cryptoWithdrawalsCreated24h',(SELECT count(*) FROM crypto_withdrawals WHERE "createdAt">=now()-interval '24 hours')) AS data`,
  audit: queue(
    `SELECT id,action,"createdAt" AS at FROM audit_logs
    WHERE "createdAt">=now()-interval '15 minutes'`,
    100
  ),
  sharedGames: `SELECT jsonb_build_object(
    'workerHealthyAt',(SELECT max(healthy_at) FROM play_together_workers),
    'workerFresh',EXISTS(SELECT 1 FROM play_together_workers WHERE healthy_at>now()-interval '30 seconds'),
    'activeRounds',(SELECT count(*) FROM play_together_rounds WHERE state IN ('OPEN','LOCKED','DRAWN')),
    'overdueRounds',(SELECT count(*) FROM play_together_rounds
      WHERE state IN ('OPEN','LOCKED','DRAWN') AND recovery_deadline<now()-interval '30 seconds'),
    'delayedResults',(SELECT count(*) FROM play_together_rounds
      WHERE state='DRAWN' AND presentation_finishes_at<now()-interval '30 seconds'),
    'undeliveredEvents',(SELECT count(*) FROM play_together_events
      WHERE delivered_at IS NULL AND available_at<now()-interval '30 seconds')) AS data`,
  walletChecks: `SELECT jsonb_build_object(
    'negativeWallets',(SELECT count(*) FROM wallets WHERE "coinsBalance"<0 OR "gamePointsBalance"<0),
    'latestInvariantCheck', (SELECT jsonb_build_object('id',id,'startedAt',"startedAt",'finishedAt',"finishedAt",'passed',passed)
      FROM invariant_check_runs ORDER BY "startedAt" DESC LIMIT 1)) AS data`,
  providerPractice: `SELECT jsonb_build_object(
    'accounts',(SELECT count(*) FROM sg_test_players),
    'mismatchedBalances',(SELECT count(*) FROM sg_test_players p WHERE p.balance_cents IS DISTINCT FROM
      (SELECT 100000+COALESCE(sum(CASE WHEN m.error<>0 THEN 0 WHEN m.action='debit' THEN -m.amount_cents ELSE m.amount_cents END),0)
        FROM sg_test_movements m WHERE m.username=p.username)),
    'movements24h',(SELECT count(*) FROM sg_test_movements WHERE created_at>=now()-interval '24 hours'),
    'rejectedMovements24h',(SELECT count(*) FROM sg_test_movements WHERE created_at>=now()-interval '24 hours' AND error<>0)) AS data`,
} as const;

export type MonitorSource = keyof typeof MONITOR_QUERIES;
export type MonitorData = Record<string, unknown>;

const AUDIT_ACTIONS = new Set([
  'TOTP_ENROLLMENT_STARTED',
  'TOTP_ENROLLMENT_FAILED',
  'TOTP_ENABLED',
  'TOTP_VERIFICATION_FAILED',
  'TOTP_DISABLED',
  'SECURITY_STEP_UP_SUCCEEDED',
  'SECURITY_POLICY_UPDATED',
  'CRYPTO_ADDRESS_ADDED',
  'CRYPTO_ADDRESS_RETIRED',
  'CRYPTO_DEPOSIT_CREATED',
  'CRYPTO_DEPOSIT_REVIEW',
  'CRYPTO_DEPOSIT_CREDITED',
  'CRYPTO_WITHDRAWAL_HELD',
  'CRYPTO_WITHDRAWAL_CLAIM',
  'CRYPTO_WITHDRAWAL_CANCEL',
  'CRYPTO_WITHDRAWAL_CONFIRM',
  'ADMIN_MEMBER_REACTIVATED',
  'ADMIN_MEMBER_SUSPENDED',
  'ADMIN_AGENT_ACCOUNT_CREATED',
  'ADMIN_EXISTING_MEMBER_AGENT_APPROVED',
  'ADMIN_AGENT_ACCOUNT_ACTIVATED',
  'ADMIN_AGENT_TEMPORARY_PASSWORD_REISSUED',
  'OWNER_PASSWORD_RESET_ISSUED',
  'OWNER_PASSWORD_RESET_COMPLETED',
  'ACCOUNT_PASSWORD_CHANGED',
  'MEMBER_REWARD_CONFIG_UPDATED',
  'AGENT_APPLICATION_SUBMITTED',
  'AGENT_APPLICATION_APPROVED',
  'AGENT_APPLICATION_REJECTED',
  'AGENT_SUSPENDED',
  'AGENT_REACTIVATED',
  'AGENT_INVENTORY_FUNDED',
  'AGENT_INVENTORY_ADJUSTED',
  'AGENT_CONFIG_COUNTRY_CREATED',
  'AGENT_CONFIG_COUNTRY_UPDATED',
  'AGENT_CONFIG_PAYMENT_METHOD_CREATED',
  'AGENT_CONFIG_PAYMENT_METHOD_UPDATED',
  'AGENT_CONFIG_EXCHANGE_RATE_DEACTIVATED',
  'PAYMENT_USD_RATE_PUBLISHED',
  'AGENT_PAYMENT_ACCOUNT_CREATED',
  'AGENT_PAYMENT_ACCOUNT_MODIFIED',
  'AGENT_PAYMENT_ACCOUNT_APPROVED',
  'AGENT_PAYMENT_ACCOUNT_REJECTED',
  'AGENT_PAYMENT_ACCOUNT_DISABLED',
  'AGENT_ORDER_CREATED',
  'AGENT_ORDER_PAYMENT_SUBMITTED',
  'AGENT_ORDER_SETTLED',
  'AGENT_ORDER_EXPIRED',
  'AGENT_ORDER_CANCELLED',
  'AGENT_DISPUTE_OPENED',
  'AGENT_DISPUTE_CLAIMED',
  'AGENT_DISPUTE_RESOLVED',
  'WITHDRAWAL_CREATED',
  'WITHDRAWAL_PAYOUT_CLAIMED',
  'WITHDRAWAL_PAYMENT_SUBMITTED',
  'WITHDRAWAL_CANCELLED',
  'WITHDRAWAL_SYSTEM_TIMEOUT_ESCALATED',
  'LATE_PAYMENT_REPORTED',
  'LATE_PAYMENT_CLAIMED',
  'LATE_PAYMENT_EXTERNAL_REFUND_RECORDED',
  'LATE_PAYMENT_ASSIGNMENT_RELEASED',
  'LATE_PAYMENT_REJECTED',
]);

export async function readMonitorSource(
  db: PrismaClient,
  source: MonitorSource
): Promise<MonitorData> {
  return db.$transaction(
    async (tx) => {
      // READ ONLY is enforced by PostgreSQL, including accidental future writes.
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout='3000ms'");
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout='1000ms'");
      const [row] = await tx.$queryRawUnsafe<Array<{ data: MonitorData }>>(MONITOR_QUERIES[source]);
      if (!row?.data || typeof row.data !== 'object' || Array.isArray(row.data))
        throw Error('No snapshot');
      if (source === 'audit') {
        // Action is a free-text column. Only authored action labels may leave the service.
        row.data.items = (row.data.items as Array<{ id: string; action: string; at: string }>).map(
          (item) => ({
            id: item.id,
            at: item.at,
            action: AUDIT_ACTIONS.has(item.action) ? item.action : 'OTHER_RECORDED_ACTION',
          })
        );
      }
      return row.data;
    },
    { maxWait: 1000, timeout: 5000, isolationLevel: 'RepeatableRead' }
  );
}

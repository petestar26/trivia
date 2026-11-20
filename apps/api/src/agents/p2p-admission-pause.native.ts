// Native proof of the database-enforced P2P admission pause (migration
// 20261119000000_p2p_admission_pause). Synthetic data only, in an explicitly
// acknowledged fresh loopback database. No real account, credential or funds.
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
const selected = vi.hoisted(() => ({ client: null as any }));
vi.mock('@socialplay/database', async () => {
  const actual = await vi.importActual<typeof import('@socialplay/database')>('@socialplay/database');
  const proxy = new Proxy({}, { get(_t, n) {
    const v = selected.client[n];
    return typeof v === 'function' ? v.bind(selected.client) : v;
  } });
  return { ...actual, prisma: proxy, default: proxy };
});
import { approveExistingMemberAgent } from './admin-account-service.js';
import { fundAgentInventory } from './inventory-service.js';
import { cancelAgentOrder, createAgentOrder, settleAgentOrder, submitOrderPayment } from './order-service.js';
import { publishUsdRate } from './usd-config-service.js';
import { fixtureEtbPolicy } from '../test/payment-policy-fixture.js';
import { activateTestWithdrawalPolicy, nextTestCountryCode } from '../test/financial-policy-fixtures.js';
import { fundAgentFiatLiquidity } from '../withdrawals/liquidity-service.js';
import { createUserPayoutAccount } from '../withdrawals/payout-account-service.js';
import { createWithdrawalQuote } from '../withdrawals/quote-service.js';
import { cancelHeldWithdrawal, claimPayout, createWithdrawal, submitPayment } from '../withdrawals/withdrawal-service.js';
import { confirmWithdrawalReceipt } from '../withdrawals/dispute-service.js';
import { runLedgerInvariantCheck } from '../economy/ledger-invariant-checker.js';
import { applyRuntimeAccess, verifyRuntimeAccessReadOnly } from '../scripts/ledger-runtime-access.js';
import { errorHandler } from '../middleware/error-handler.js';
import { P2P_RECONCILIATION_SQL } from './p2p-reconciliation.js';

const u = new URL(process.env.DATABASE_URL ?? 'http://invalid');
if (u.hostname !== '127.0.0.1' || u.pathname !== '/playqube_scheduled_throwaway' || process.env.ETB_NATIVE_DB_ACK !== 'fresh-synthetic')
  throw Error('Fresh acknowledged loopback database required');
const owner = new PrismaClient({ datasourceUrl: u.toString(), log: [] });
const operator = new PrismaClient({ datasourceUrl: u.toString(), log: [] }); // separate owner session, like psql
const role = 'p2p_runtime_' + randomBytes(5).toString('hex'), password = randomBytes(24).toString('hex'), key = randomBytes(32).toString('hex'), keyId = 'synthetic-p2p-' + randomBytes(4).toString('hex');
let runtime: PrismaClient;

const pause = (db: PrismaClient = operator) => db.$transaction(async (tx) => {
  await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '10s'`);
  const changed = await tx.$executeRawUnsafe(`UPDATE public.p2p_admission_control SET paused = true, reason = 'synthetic rollout', "changedBy" = 'synthetic-operator' WHERE id = 1`);
  if (changed !== 1) throw new Error('Expected exactly one pause control row');
  return changed;
});
const resume = (db: PrismaClient = operator) => db.$executeRawUnsafe(`UPDATE public.p2p_admission_control SET paused = false, reason = 'synthetic resume', "changedBy" = 'synthetic-operator' WHERE id = 1`);
const paused = async () => (await owner.$queryRawUnsafe<{ paused: boolean }[]>(`SELECT paused FROM public.p2p_admission_control WHERE id = 1`))[0]?.paused;
const reconcileAll = async () => owner.$transaction(async (tx) => {
  await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
  return tx.$queryRawUnsafe<{ rule: string; id: string }[]>(P2P_RECONCILIATION_SQL);
});
// The disposable database also holds bare fixture rows from other suites. Each check
// must add no mismatch beyond that baseline (captured before this file writes anything).
let baseline = new Set<string>();
const reconcile = async () => (await reconcileAll()).filter((r) => !baseline.has(r.rule + ':' + r.id));

beforeAll(async () => {
  selected.client = owner;
  await owner.$executeRawUnsafe(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  const r = new URL(u); r.username = role; r.password = password;
  runtime = new PrismaClient({ datasourceUrl: r.toString(), log: [] });
  await resume();
  baseline = new Set((await reconcileAll()).map((r) => r.rule + ':' + r.id));
});
beforeEach(async () => { selected.client = owner; await resume(); });
afterAll(async () => {
  selected.client = owner;
  await resume();
  await owner.platformGate.updateMany({ where: { key: 'WITHDRAWAL_CREATE' }, data: { enabled: false } });
  await runtime?.$disconnect();
  await owner.$executeRawUnsafe(`DROP OWNED BY "${role}"`);
  await owner.$executeRawUnsafe(`DROP ROLE "${role}"`);
  await Promise.all([owner.$disconnect(), operator.$disconnect()]);
  vi.unstubAllEnvs();
});

async function world() {
  const tag = randomUUID();
  const admin = await owner.user.create({ data: { username: 'p2p_admin_' + tag, role: 'ADMIN' } });
  const buyer = await owner.user.create({ data: { username: 'p2p_buyer_' + tag } });
  const agentUser = await owner.user.create({ data: { username: 'p2p_agent_' + tag, email: tag + '@example.invalid' } });
  const country = await owner.country.create({ data: { code: await nextTestCountryCode(), name: 'Synthetic P2P pause', currencyCode: 'ETB', isActive: true, agentPaymentEnabled: true } });
  const agent = await approveExistingMemberAgent(admin.id, { email: agentUser.email!, displayName: 'Synthetic agent', countryId: country.id });
  const method = await owner.paymentMethodDefinition.create({ data: { countryId: country.id, type: 'BANK_TRANSFER', name: 'Synthetic bank', isActive: true, fieldSchema: { requiredFields: ['accountNumber'] } } });
  const account = await owner.agentPaymentAccount.create({ data: { agentId: agent.agentId, countryId: country.id, methodDefId: method.id, status: 'APPROVED', accountDetails: { accountNumber: 'SYNTHETIC-NO-REAL-ACCOUNT' } } });
  const policy = { ...fixtureEtbPolicy(), localPerUsd: '20' };
  const rate = await publishUsdRate(admin.id, country.id, policy);
  await fundAgentInventory(admin.id, agent.agentId, 1_000_000, randomUUID());
  await activateTestWithdrawalPolicy(country.id, admin.id);
  await fundAgentFiatLiquidity(admin.id, agent.agentId, 'ETB', 500000n, randomUUID());
  const args = (fiatAmount = 10000) => ({ agentId: agent.agentId, countryId: country.id, paymentAccountId: account.id, fiatAmount, idempotencyKey: randomUUID() });
  // Fund the buyer through an ordinary settled deposit (no direct balance writes).
  const { order } = await createAgentOrder(buyer.id, args(100000));
  await submitOrderPayment(buyer.id, order.id);
  await settleAgentOrder(agentUser.id, order.id);
  const payout = await createUserPayoutAccount(buyer.id, { countryId: country.id, methodDefId: method.id, accountDetails: { accountNumber: 'SYNTHETIC-PAYOUT' } });
  return { admin, buyer, agentUser, agentId: agent.agentId, country, method, account, rate, args, payout };
}
const counts = async () => ({
  orders: await owner.agentOrder.count(), reservations: await owner.agentReservation.count(),
  settlements: await owner.agentOrderSettlement.count(), wallet: await owner.walletTransaction.count(),
  quotes: await owner.withdrawalQuote.count(), withdrawals: await owner.withdrawal.count(),
  holds: await owner.withdrawalHold.count(), cryptoWithdrawals: await owner.cryptoWithdrawal.count(),
});
const balance = async (userId: string) => (await owner.wallet.findUniqueOrThrow({ where: { userId } })).coinsBalance;
const inventory = (agentId: string) => owner.agentInventory.findUniqueOrThrow({ where: { agentId } });
const liquidity = (agentId: string) => owner.agentFiatLiquidity.findUniqueOrThrow({ where: { agentId_fiatCurrency: { agentId, fiatCurrency: 'ETB' } } });
const PAUSED = /P2P_ADMISSION_PAUSED/;
type Created = { withdrawal: { id: string; status: string }; idempotent: boolean };

it('installs unpaused and passes the existing invariant, grant and reconciliation checks', async () => {
  expect(await paused()).toBe(false);
  const triggers = await owner.$queryRawUnsafe<{ tab: string }[]>(`SELECT c.relname AS tab FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE t.tgname='p2p_admission_guard' AND t.tgenabled='O' ORDER BY 1`);
  expect(triggers.map((t) => t.tab)).toEqual(['agent_orders', 'withdrawal_quotes', 'withdrawals']);
  expect(await applyRuntimeAccess(owner, role, keyId, key)).toEqual([]);
  expect(await verifyRuntimeAccessReadOnly(runtime, role)).toEqual([]);
  const scan = await runLedgerInvariantCheck();
  expect(scan.violations).toEqual([]);
  expect(await reconcile()).toEqual([]);
});

it('normal admission: deposit, quote and withdrawal succeed while unpaused', async () => {
  const w = await world();
  const { order } = await createAgentOrder(w.buyer.id, w.args());
  expect(order.status).toBe('CREATED');
  const q = await createWithdrawalQuote(w.buyer.id, { countryId: w.country.id, coinAmount: 50000 });
  const { withdrawal } = await createWithdrawal(w.buyer.id, { quoteId: q.id, payoutAccountId: w.payout.id, idempotencyKey: randomUUID() }, 1000) as Created;
  expect(withdrawal.status).toBe('HELD');
  expect(await balance(w.buyer.id)).toBe(50000);
  expect(await reconcile()).toEqual([]);
});

it('pause refuses every new deposit, quote and withdrawal with zero writes (owner and restricted runtime, ORM and raw SQL)', async () => {
  const w = await world();
  const q = await createWithdrawalQuote(w.buyer.id, { countryId: w.country.id, coinAmount: 50000 }); // issued before the pause
  expect(await applyRuntimeAccess(owner, role, keyId, key)).toEqual([]);
  await pause();
  const before = await counts(), bal = await balance(w.buyer.id), inv = await inventory(w.agentId), liq = await liquidity(w.agentId);
  for (const client of [owner, runtime]) {
    selected.client = client;
    await expect(createAgentOrder(w.buyer.id, w.args())).rejects.toThrow(PAUSED);
    await expect(createWithdrawalQuote(w.buyer.id, { countryId: w.country.id, coinAmount: 50000 })).rejects.toThrow(PAUSED);
    await expect(createWithdrawal(w.buyer.id, { quoteId: q.id, payoutAccountId: w.payout.id, idempotencyKey: randomUUID() }, 1000)).rejects.toThrow(PAUSED);
  }
  selected.client = owner;
  // A writer that bypasses every service (any API version, script or console) is refused too.
  // Each copies a complete, valid accepted row under a fresh identity, so only the pause can refuse it.
  const copy = (table: string, id: string, extra: string) => `INSERT INTO ${table} SELECT (jsonb_populate_record(NULL::${table},
    to_jsonb(x) || jsonb_build_object('id', gen_random_uuid()::text, ${extra}))).* FROM ${table} x WHERE x.id = '${id}'`;
  const accepted = await owner.agentOrder.findFirstOrThrow({ where: { userId: w.buyer.id } });
  const unpausedCopy = copy('agent_orders', accepted.id, `'orderNumber', 'SYN-' || gen_random_uuid(), 'idempotencyKey', gen_random_uuid()::text`);
  for (const client of [owner, runtime]) {
    await expect(client.$executeRawUnsafe(unpausedCopy)).rejects.toThrow(PAUSED);
    await expect(client.$executeRawUnsafe(copy('withdrawal_quotes', q.id, `'requestHash', gen_random_uuid()::text`))).rejects.toThrow(PAUSED);
  }
  expect(await counts()).toEqual(before);
  expect(await balance(w.buyer.id)).toBe(bal);
  expect(await inventory(w.agentId)).toEqual(inv);
  expect(await liquidity(w.agentId)).toEqual(liq);
  expect((await owner.withdrawalQuote.findUniqueOrThrow({ where: { id: q.id } })).status).toBe('ACTIVE');
});

it('accepted deposits settle exactly once during the pause; replay and cancel stay safe', async () => {
  const w = await world();
  const a = w.args(), b = w.args();
  const { order } = await createAgentOrder(w.buyer.id, a);
  const { order: toCancel } = await createAgentOrder(w.buyer.id, b);
  await pause();
  const bal = await balance(w.buyer.id);
  const replay = await createAgentOrder(w.buyer.id, a);
  expect(replay).toMatchObject({ idempotent: true, order: { id: order.id } });
  await submitOrderPayment(w.buyer.id, order.id);
  await settleAgentOrder(w.agentUser.id, order.id);
  await expect(settleAgentOrder(w.agentUser.id, order.id)).rejects.toThrow();
  expect((await createAgentOrder(w.buyer.id, a)).idempotent).toBe(true);
  expect(await balance(w.buyer.id)).toBe(bal + order.coinAmount);
  expect(await owner.agentOrderSettlement.count({ where: { orderId: order.id } })).toBe(1);
  expect(await owner.walletTransaction.count({ where: { userId: w.buyer.id, referenceId: order.id } })).toBe(1);
  await cancelAgentOrder(w.buyer.id, toCancel.id);
  expect((await owner.agentReservation.findUniqueOrThrow({ where: { orderId: toCancel.id } })).status).toBe('RELEASED');
  expect((await inventory(w.agentId)).reservedBalance).toBe(0);
  expect(await reconcile()).toEqual([]);
});

it('accepted withdrawals complete, refund and replay during the pause without double debit or credit', async () => {
  const w = await world();
  const q = await createWithdrawalQuote(w.buyer.id, { countryId: w.country.id, coinAmount: 50000 });
  const args = { quoteId: q.id, payoutAccountId: w.payout.id, idempotencyKey: randomUUID() };
  const { withdrawal } = await createWithdrawal(w.buyer.id, args, 1000) as Created;
  await pause();
  expect(await balance(w.buyer.id)).toBe(50000);
  const replay = await createWithdrawal(w.buyer.id, args, 1000);
  expect(replay).toMatchObject({ idempotent: true, withdrawal: { id: withdrawal.id } });
  await claimPayout(w.agentUser.id, withdrawal.id, { idempotencyKey: randomUUID() });
  const submission = { referenceNumber: 'SYNTHETIC-REF-' + randomUUID(), idempotencyKey: randomUUID() };
  await submitPayment(w.agentUser.id, withdrawal.id, submission);
  expect((await submitPayment(w.agentUser.id, withdrawal.id, submission)).idempotent).toBe(true);
  const confirmKey = { idempotencyKey: randomUUID() };
  await confirmWithdrawalReceipt(w.buyer.id, withdrawal.id, confirmKey);
  await confirmWithdrawalReceipt(w.buyer.id, withdrawal.id, confirmKey);
  expect((await owner.withdrawal.findUniqueOrThrow({ where: { id: withdrawal.id } })).status).toBe('COMPLETED');
  expect(await owner.withdrawalSettlement.count({ where: { withdrawalId: withdrawal.id } })).toBe(1);
  expect((await createWithdrawal(w.buyer.id, args, 1000)).idempotent).toBe(true);
  expect(await balance(w.buyer.id)).toBe(50000);

  // A second accepted withdrawal, held before the pause, is refunded once while paused.
  await resume();
  const q2 = await createWithdrawalQuote(w.buyer.id, { countryId: w.country.id, coinAmount: 50000 });
  const { withdrawal: held } = await createWithdrawal(w.buyer.id, { quoteId: q2.id, payoutAccountId: w.payout.id, idempotencyKey: randomUUID() }, 1000) as Created;
  await pause();
  expect(await balance(w.buyer.id)).toBe(0);
  const cancelKey = { idempotencyKey: randomUUID() };
  await cancelHeldWithdrawal(w.buyer.id, held.id, cancelKey);
  await cancelHeldWithdrawal(w.buyer.id, held.id, cancelKey);
  expect(await balance(w.buyer.id)).toBe(50000);
  expect((await owner.withdrawalHold.findUniqueOrThrow({ where: { withdrawalId: held.id } })).status).toBe('REFUNDED');
  expect((await liquidity(w.agentId)).reservedBalance).toBe(0n);
  expect(await reconcile()).toEqual([]);
});

it('drain: the pause waits for an admission already past the guard, which is accepted; later ones are refused', async () => {
  const w = await world();
  let release!: () => void;
  const hold = new Promise<void>((r) => { release = r; });
  let inserted!: () => void;
  const insertedSignal = new Promise<void>((r) => { inserted = r; });
  const inFlightKey = 'synthetic-inflight-' + randomUUID();
  const inFlight = owner.$transaction(async (tx) => {
    await tx.withdrawalQuote.create({ data: { userId: w.buyer.id, countryId: w.country.id, fiatCurrency: 'ETB', coinAmount: 50000, fiatAmount: 50000n,
      exchangeRateConfigId: w.rate.id, exchangeRateValue: w.rate.coinsPerUnit, requestHash: inFlightKey, status: 'ACTIVE', expiresAt: new Date(Date.now() + 60000) } });
    inserted();
    await hold;
  }, { timeout: 30000 });
  await insertedSignal;
  let pauseDone = false;
  const pausing = pause().then(() => { pauseDone = true; });
  await new Promise((r) => setTimeout(r, 750));
  expect(pauseDone).toBe(false); // operator is waiting for the in-flight admission
  release();
  await inFlight;
  await pausing;
  expect(await owner.withdrawalQuote.count({ where: { requestHash: inFlightKey } })).toBe(1);
  await expect(createWithdrawalQuote(w.buyer.id, { countryId: w.country.id, coinAmount: 50000 })).rejects.toThrow(PAUSED);
});

it('a request refused during the pause can be retried with the same key after resume and is admitted exactly once', async () => {
  const w = await world();
  const a = w.args();
  await pause();
  await expect(createAgentOrder(w.buyer.id, a)).rejects.toThrow(PAUSED);
  expect(await owner.agentOrder.count({ where: { userId: w.buyer.id, idempotencyKey: a.idempotencyKey } })).toBe(0);
  await resume();
  const first = await createAgentOrder(w.buyer.id, a);
  const again = await createAgentOrder(w.buyer.id, a);
  expect(first.idempotent).toBe(false);
  expect(again).toMatchObject({ idempotent: true, order: { id: first.order.id } });
  expect(await owner.agentOrder.count({ where: { userId: w.buyer.id, idempotencyKey: a.idempotencyKey } })).toBe(1);
});

it('only the owner can move the switch; the restricted runtime cannot lift, delete or truncate it', async () => {
  expect(await applyRuntimeAccess(owner, role, keyId, key)).toEqual([]);
  await pause();
  await expect(runtime.$executeRawUnsafe(`UPDATE public.p2p_admission_control SET paused=false WHERE id=1`)).rejects.toThrow(/owner may change/);
  await expect(runtime.$executeRawUnsafe(`DELETE FROM public.p2p_admission_control`)).rejects.toThrow(/owner may change/);
  await expect(runtime.$executeRawUnsafe(`TRUNCATE public.p2p_admission_control`)).rejects.toThrow(/permission denied/);
  await expect(runtime.$executeRawUnsafe(`INSERT INTO public.p2p_admission_control(id,paused) VALUES (1,false) ON CONFLICT (id) DO UPDATE SET paused=false`)).rejects.toThrow(/owner may change/);
  await expect(owner.$executeRawUnsafe(`DELETE FROM public.p2p_admission_control`)).rejects.toThrow(/cannot be deleted/);
  expect(await paused()).toBe(true);
  await resume();
  expect(await paused()).toBe(false);
});

it('new API replicas answer a paused admission with 503 and no admitted work', async () => {
  const w = await world();
  const app = Fastify({ logger: false });
  app.setErrorHandler(errorHandler);
  app.post('/deposit', async () => createAgentOrder(w.buyer.id, w.args()));
  await pause();
  const res = await app.inject({ method: 'POST', url: '/deposit' });
  expect(res.statusCode).toBe(503);
  expect(res.json()).toMatchObject({ success: false, error: { code: 'SERVICE_UNAVAILABLE' } });
  await app.close();
});

it('crypto and commission paths are untouched by the pause', async () => {
  await pause();
  // The guard is only on the three P2P admission tables.
  const t = await owner.$queryRawUnsafe<{ tab: string }[]>(`SELECT DISTINCT c.relname AS tab FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    WHERE t.tgfoid = 'public.p2p_admission_guard()'::regprocedure ORDER BY 1`);
  expect(t.map((r) => r.tab)).toEqual(['agent_orders', 'withdrawal_quotes', 'withdrawals']);
  const gates = await owner.platformGate.findMany({ where: { key: { startsWith: 'CRYPTO_' } }, orderBy: { key: 'asc' } });
  await resume();
  expect(await owner.platformGate.findMany({ where: { key: { startsWith: 'CRYPTO_' } }, orderBy: { key: 'asc' } })).toEqual(gates);
});

it('application rollback keeps the pause and migration intact while accepted orders remain replayable', async () => {
  const w = await world();
  const args = w.args();
  const accepted = await createAgentOrder(w.buyer.id, args);
  await pause();
  // Normal app rollback does not alter database enforcement or migration history.
  // This exercises that contract, not a deployed historical API binary.
  expect((await createAgentOrder(w.buyer.id, args)).order.id).toBe(accepted.order.id);
  await expect(createAgentOrder(w.buyer.id, w.args())).rejects.toThrow(PAUSED);
  await expect(createWithdrawalQuote(w.buyer.id, { countryId: w.country.id, coinAmount: 50000 })).rejects.toThrow(PAUSED);
  expect(await paused()).toBe(true);
  const history = await owner.$queryRawUnsafe<{ count: bigint }[]>(`SELECT count(*) AS count FROM public._prisma_migrations
    WHERE migration_name = '20261119000000_p2p_admission_pause' AND finished_at IS NOT NULL AND rolled_back_at IS NULL`);
  expect(history).toEqual([{ count: 1n }]);
  expect(await applyRuntimeAccess(owner, role, keyId, key)).toEqual([]);
  expect(await verifyRuntimeAccessReadOnly(runtime, role)).toEqual([]);
  expect((await runLedgerInvariantCheck()).violations).toEqual([]);
  expect(await reconcile()).toEqual([]);
});

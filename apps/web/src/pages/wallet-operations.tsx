import { WalletSetupAdmin } from './wallet-setup-admin';
import { WalletPricingAdmin } from './wallet-pricing-admin';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, unwrapData } from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';
import { useWalletAction } from '@/hooks/use-wallet-action';
import { ConfirmAction, PaymentCard, PaymentNavigation } from './wallet-payments';

type Row = {
  id: string;
  orderNumber?: string;
  status: string;
  coinAmount: number;
  fiatAmount: string | number;
  fiatCurrency: string;
  createdAt: string;
  paymentSnapshot?: Record<string, unknown>;
  disputeOpenedFromStatus?: string;
};
type Dispute = {
  id: string;
  status: string;
  reason: string;
  description: string;
  orderId?: string;
  withdrawalId?: string;
};
const get = async <T,>(path: string) => unwrapData(await api.get<T>(path));
export function WalletOperationsPage({ workspace }: { workspace?: 'admin' | 'agent' }) {
  const { user } = useAuth();
  return user ? <Operations key={user.id} userId={user.id} workspace={workspace} /> : null;
}
function Operations({ userId, workspace }: { userId: string; workspace?: 'admin' | 'agent' }) {
  const options = useQuery({
    queryKey: ['payments', 'options', userId],
    queryFn: () => get<{ isAgent: boolean; isAdmin: boolean }>('/wallet/payment-options'),
  });
  const agent = workspace !== 'admin' && !!options.data?.isAgent,
    admin = workspace !== 'agent' && !!options.data?.isAdmin;
  const deposits = useQuery({
    queryKey: ['payments', 'agent-orders', userId],
    queryFn: () => get<Row[]>('/agent-orders/agent/me'),
    enabled: agent,
    refetchInterval: 15000,
  });
  const withdrawals = useQuery({
    queryKey: ['payments', 'assigned', userId],
    queryFn: () => get<Row[]>('/withdrawals/agent/assigned'),
    enabled: agent,
    refetchInterval: 15000,
  });
  const depositDisputes = useQuery({
    queryKey: ['payments', 'deposit-disputes', userId],
    queryFn: () => get<Dispute[]>('/agent-disputes/pending'),
    enabled: admin,
  });
  const withdrawalDisputes = useQuery({
    queryKey: ['payments', 'withdrawal-disputes', userId],
    queryFn: () => get<Dispute[]>('/withdrawals/admin/disputes'),
    enabled: admin,
  });
  const [selection, setSelection] = useState<{
    id: string;
    kind: 'payout' | 'deposit' | 'withdrawal';
  } | null>(null);
  const [note, setNote] = useState(''),
    [reference, setReference] = useState(''),
    [outcome, setOutcome] = useState(''),
    [checked, setChecked] = useState(false),
    [paymentOccurredAt, setPaymentOccurredAt] = useState('');
  const review = useQuery({
    queryKey: ['payments', 'review', userId, selection?.kind, selection?.id],
    enabled: !!selection && (agent || admin),
    queryFn: async () => {
      if (selection!.kind === 'payout')
        return get<Row>(`/withdrawals/agent/assigned/${selection!.id}`);
      if (selection!.kind === 'withdrawal') {
        const detail = await get<{ withdrawal: Row; dispute: { openedFromStatus: string } }>(
          `/withdrawals/admin/disputes/${selection!.id}`
        );
        return { ...detail.withdrawal, disputeOpenedFromStatus: detail.dispute.openedFromStatus };
      }
      const dispute = await get<Dispute>(`/agent-disputes/${selection!.id}`);
      return get<Row>(`/agent-orders/${dispute.orderId}`);
    },
  });
  const action = useWalletAction();
  const needsVerifiedPayment =
    selection?.kind === 'withdrawal' &&
    outcome === 'COMPLETED' &&
    review.data?.disputeOpenedFromStatus === 'PAYOUT_IN_PROGRESS';
  const paymentTime = paymentOccurredAt ? new Date(paymentOccurredAt).getTime() : NaN;
  const validPaymentTime =
    Number.isFinite(paymentTime) &&
    paymentTime <= Date.now() &&
    paymentTime >= new Date(review.data?.createdAt ?? '').getTime();
  function choose(id: string, kind: 'payout' | 'deposit' | 'withdrawal') {
    setSelection({ id, kind });
    setNote('');
    setReference('');
    setOutcome('');
    setChecked(false);
    setPaymentOccurredAt('');
  }
  if (options.isPending) return <p role="status">Checking processing access…</p>;
  if (options.isError)
    return (
      <div role="alert">
        Could not verify access. <button onClick={() => options.refetch()}>Retry</button>
      </div>
    );
  if (!agent && !admin)
    return (
      <section>
        <h1>Processing access required</h1>
        <p>This area is for approved agents and platform administrators.</p>
        <Link to="/wallet">Return to wallet</Link>
      </section>
    );
  return (
    <div className="payments-page">
      <header>
        <p className="payment-eyebrow">PAYMENT OPERATIONS</p>
        <h1>Processing desk</h1>
        <p>Confirm evidence and the exact request before changing its state.</p>
      </header>
      {!workspace && <PaymentNavigation />}
      {admin && !workspace && (
        <>
          <WalletSetupAdmin />
          <WalletPricingAdmin />
        </>
      )}
      {action.message && (
        <p role="status" className="payment-disclosure">
          {action.message}
        </p>
      )}
      {action.pending && (
        <button
          disabled={action.busy}
          onClick={() => action.run(action.pending!.path, action.pending!.body)}
        >
          Retry saved request
        </button>
      )}
      {agent && (
        <>
          <section className="payment-panel">
            <h2>Incoming deposits</h2>
            {deposits.isPending ? (
              <p>Loading…</p>
            ) : deposits.isError ? (
              <p role="alert">
                Could not load deposits. <button onClick={() => deposits.refetch()}>Retry</button>
              </p>
            ) : !deposits.data?.length ? (
              <p>No assigned deposit orders.</p>
            ) : (
              deposits.data.map((p) => (
                <PaymentCard key={p.id} payment={p}>
                  {p.status === 'PAYMENT_SUBMITTED' && (
                    <ConfirmAction
                      label="Payment verified · release Coins"
                      disabled={action.blocked}
                      onConfirm={() => action.run(`/agent-orders/${p.id}/settle`)}
                    />
                  )}
                </PaymentCard>
              ))
            )}
          </section>
          <section className="payment-panel">
            <h2>Assigned withdrawals</h2>
            {withdrawals.isPending ? (
              <p>Loading…</p>
            ) : withdrawals.isError ? (
              <p role="alert">
                Could not load withdrawals.{' '}
                <button onClick={() => withdrawals.refetch()}>Retry</button>
              </p>
            ) : !withdrawals.data?.length ? (
              <p>No assigned withdrawals.</p>
            ) : (
              withdrawals.data.map((p) => (
                <PaymentCard key={p.id} payment={p}>
                  {p.status === 'HELD' && (
                    <ConfirmAction
                      label="Claim payout"
                      disabled={action.blocked}
                      onConfirm={() => action.run(`/withdrawals/${p.id}/claim-payout`)}
                    />
                  )}{' '}
                  {p.status === 'PAYOUT_IN_PROGRESS' && (
                    <button disabled={action.blocked} onClick={() => choose(p.id, 'payout')}>
                      Record completed transfer
                    </button>
                  )}
                </PaymentCard>
              ))
            )}
          </section>
        </>
      )}
      {admin &&
        (
          [
            ['deposit', depositDisputes],
            ['withdrawal', withdrawalDisputes],
          ] as const
        ).map(([kind, query]) => (
          <section className="payment-panel" key={kind}>
            <h2>{kind === 'deposit' ? 'Deposit' : 'Withdrawal'} disputes</h2>
            {query.isPending ? (
              <p>Loading…</p>
            ) : query.isError ? (
              <p role="alert">
                Could not load disputes. <button onClick={() => query.refetch()}>Retry</button>
              </p>
            ) : !query.data?.length ? (
              <p>No disputes to review.</p>
            ) : (
              query.data.map((d) => (
                <article className="payment-record" key={d.id}>
                  <strong>{d.id}</strong>
                  <p>
                    {d.status} · {d.reason}
                  </p>
                  <p>{d.description}</p>
                  <p>Request: {d.orderId ?? d.withdrawalId}</p>
                  {d.status !== 'RESOLVED' && (
                    <div className="payment-actions">
                      <ConfirmAction
                        label="Claim review"
                        disabled={action.blocked}
                        onConfirm={() =>
                          action.run(
                            kind === 'deposit'
                              ? `/agent-disputes/${d.id}/claim`
                              : `/withdrawals/admin/disputes/${d.id}/claim`
                          )
                        }
                      />
                      <button disabled={action.blocked} onClick={() => choose(d.id, kind)}>
                        Review resolution
                      </button>
                    </div>
                  )}
                </article>
              ))
            )}
          </section>
        ))}
      {selection && (
        <section className="payment-panel">
          <h2>{selection.kind === 'payout' ? 'Record transfer' : 'Resolve dispute'}</h2>
          <p>Reference: {selection.id}</p>
          {review.isPending ? (
            <p role="status">Loading request details…</p>
          ) : review.isError ? (
            <p role="alert">
              Request details could not load.{' '}
              <button onClick={() => review.refetch()}>Retry</button>
            </p>
          ) : (
            review.data && (
              <PaymentCard
                payment={{
                  ...review.data,
                  paymentSnapshot:
                    selection.kind === 'payout' ? review.data.paymentSnapshot : undefined,
                }}
              />
            )
          )}
          {selection.kind === 'payout' ? (
            <label>
              Transfer reference
              <input
                maxLength={256}
                value={reference}
                onChange={(e) => setReference(e.target.value)}
              />
            </label>
          ) : (
            <label>
              Outcome
              <select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
                <option value="">Choose an outcome</option>
                <option value={selection.kind === 'deposit' ? 'RELEASE' : 'COMPLETED'}>
                  Complete after verifying payment
                </option>
                <option value={selection.kind === 'deposit' ? 'CANCEL' : 'CANCELLED'}>
                  Cancel and release/refund
                </option>
              </select>
            </label>
          )}
          {needsVerifiedPayment && (
            <fieldset>
              <legend>Verified transfer evidence</legend>
              <label>
                Verified transfer reference
                <input
                  maxLength={256}
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                />
              </label>
              <label>
                Payment occurred at (your local time)
                <input
                  type="datetime-local"
                  value={paymentOccurredAt}
                  onChange={(e) => setPaymentOccurredAt(e.target.value)}
                />
              </label>
              <p>
                Use the actual transfer record. Payment time must be after the request was created
                and cannot be in the future.
              </p>
            </fieldset>
          )}
          <label>
            Evidence and decision notes
            <textarea maxLength={4000} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <p>
            Completion requires verified payment evidence. A missing payment submission may be
            rejected by the server and must be investigated; never invent transfer details.
          </p>
          <label className="payment-check">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
            />
            I verified the request, payment evidence and selected outcome.
          </label>
          <button
            className="payment-primary"
            disabled={
              action.blocked ||
              !review.data ||
              review.isError ||
              !checked ||
              !note.trim() ||
              (needsVerifiedPayment && (!reference.trim() || !validPaymentTime)) ||
              (selection.kind === 'payout' ? !reference.trim() : !outcome)
            }
            onClick={() => {
              const path =
                selection.kind === 'payout'
                  ? `/withdrawals/${selection.id}/submit-payment`
                  : selection.kind === 'deposit'
                    ? `/agent-disputes/${selection.id}/resolve`
                    : `/withdrawals/admin/disputes/${selection.id}/resolve`;
              const body =
                selection.kind === 'payout'
                  ? { referenceNumber: reference, note: note.slice(0, 1024) }
                  : selection.kind === 'deposit'
                    ? { resolution: outcome, resolutionNote: note }
                    : {
                        outcome,
                        resolutionNote: note,
                        ...(needsVerifiedPayment
                          ? {
                              adminVerifiedPayment: {
                                referenceNumber: reference.trim(),
                                paymentOccurredAt: new Date(paymentTime).toISOString(),
                                note: note.slice(0, 1024),
                              },
                            }
                          : {}),
                      };
              void action.run(path, body);
              setSelection(null);
            }}
          >
            Confirm action
          </button>
          <button onClick={() => setSelection(null)}>Back</button>
        </section>
      )}
    </div>
  );
}

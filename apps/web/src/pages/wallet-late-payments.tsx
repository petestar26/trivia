import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { boundedRequest } from '@/lib/bounded-request';
import { currencyMinorDigits, inputToMinor, formatMinor } from '@/lib/payment-money';
import { api, unwrapData } from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';
import { useWalletAction, walletError } from '@/hooks/use-wallet-action';
type Case = {
  id: string;
  orderId: string;
  status: string;
  paymentReference: string;
  paidAmount: number;
  paidAt: string;
  description: string;
  assignedAdminId?: string;
  refundReference?: string;
  resolutionNote?: string;
  order: { orderNumber: string; fiatCurrency: string };
};
export function LatePaymentCases({ admin = false }: { admin?: boolean }) {
  const { user } = useAuth();
  const [page, setPage] = useState(0);
  const [decision, setDecision] = useState<{item: Case; operation: 'release' | 'reject'} | null>(null);
  const cases = useQuery({
    queryKey: ['payments', 'late', user?.id, admin, page],
    queryFn: async () =>
      unwrapData(await api.get<Case[]>(`/late-payments/${admin ? 'pending' : 'me'}${page ? `?page=${page}` : ''}`)),
    enabled: !!user,
    refetchInterval: 30000,
  });
  const access = useQuery({queryKey: ['workspace-access', user?.id], queryFn: async () => unwrapData(await api.get<{role: string}>('/workspaces/access')), enabled: admin && !!user, retry: false});
  const action = useWalletAction('recovery-queue');
  const [selected, setSelected] = useState<Case | null>(null);
  return (
    <section className="payment-panel">
      <h2>Late-payment recovery</h2>
      <p>Page {page + 1} · up to 50 cases. Staff queues show oldest reports first. Super administrators can review every assignment.</p>
      <p>
        Reports are investigated separately from deposit orders. A recorded refund means staff
        verified a transfer back to the payer; it does not add Coins.
      </p>
      {cases.isPending ? (
        <p role="status">Loading recovery cases…</p>
      ) : cases.isError ? (
        <p role="alert">
          Could not load recovery cases. <button onClick={() => cases.refetch()}>Retry</button>
        </p>
      ) : !cases.data?.length ? (
        <p>No recovery cases.</p>
      ) : (
        cases.data.map((c) => (
          <article className="payment-record" key={c.id}>
            <strong>
              {c.order.orderNumber} · {c.status}
            </strong>
            <p>
              Reported transfer: {c.paymentReference} ·{' '}
              {formatMinor(c.paidAmount, c.order.fiatCurrency)}
            </p>
            <p>
              {new Date(c.paidAt).toLocaleString()} · {c.description}
            </p>
            {c.refundReference && (
              <p>
                Refund reference: {c.refundReference}. {c.resolutionNote}
              </p>
            )}
            {c.status === 'REJECTED' && <p>Reason: {c.resolutionNote}</p>}
            {admin && access.data?.role === 'SUPER_ADMIN' && c.status === 'ASSIGNED' && <>
              <button disabled={action.blocked} onClick={() => setDecision({item: c, operation: 'release'})}>Release assignment</button>
              {c.assignedAdminId === user?.id && <button disabled={action.blocked} onClick={() => setDecision({item: c, operation: 'reject'})}>Reject claim</button>}
            </>}
            {admin && c.status === 'OPEN' && (
              <button
                disabled={action.blocked}
                onClick={() => action.run(`/late-payments/${c.id}/claim`)}
              >
                Claim investigation
              </button>
            )}
            {admin && c.status === 'ASSIGNED' && c.assignedAdminId === user?.id && (
              <button disabled={action.blocked} onClick={() => setSelected(c)}>
                Record verified refund
              </button>
            )}
          </article>
        ))
      )}
      {action.message && <p role="status">{action.message}</p>}
      {action.pending && (
        <button
          disabled={action.busy}
          onClick={() => action.run(action.pending!.path, action.pending!.body)}
        >
          Retry saved request
        </button>
      )}
      <nav aria-label="Recovery pages">
        <button disabled={page === 0 || cases.isFetching} onClick={() => {setPage(page - 1); setSelected(null); setDecision(null);}}>Previous page</button>
        <button disabled={cases.isFetching || cases.isError || (cases.data?.length ?? 0) < 50} onClick={() => {setPage(page + 1); setSelected(null); setDecision(null);}}>Next page</button>
      </nav>
      {decision && <SupervisionForm key={`${decision.item.id}-${decision.operation}`} {...decision} close={() => setDecision(null)} />}
      {selected && <RefundForm key={selected.id} item={selected} close={() => setSelected(null)} />}
    </section>
  );
}
export function LatePaymentReport({ orderId, currency }: { orderId: string; currency: string }) {
  const [open, setOpen] = useState(false),
    [reference, setReference] = useState(''),
    [amount, setAmount] = useState(''),
    [time, setTime] = useState(''),
    [note, setNote] = useState('');
  const action = useWalletAction(`recovery-order-${orderId}`);
  const cents = inputToMinor(amount, currencyMinorDigits(currency));
  const valid =
    cents !== null &&
    !!time &&
    Number.isFinite(new Date(time).getTime()) &&
    new Date(time).getTime() <= Date.now() &&
    reference.trim().length >= 3 &&
    note.trim().length >= 3;
  return (
    <div>
      <button disabled={action.blocked} onClick={() => setOpen(!open)}>
        {open ? 'Close report' : 'Already paid? Report transfer'}
      </button>
      {open && (
        <fieldset>
          <legend>Report payment after closure</legend>
          <p>
            Do not send another payment. Enter the actual transfer details; this report does not
            confirm receipt or credit your balance.
          </p>
          <label>
            Transfer reference
            <input
              maxLength={128}
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </label>
          <label>
            Amount sent ({currency})
            <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </label>
          <label>
            Transfer time (local)
            <input type="datetime-local" value={time} onChange={(e) => setTime(e.target.value)} />
          </label>
          <label>
            Details
            <textarea maxLength={4000} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <button
            disabled={action.blocked || !valid}
            onClick={() =>
              action.run('/late-payments', {
                orderId,
                paymentReference: reference,
                paidAmount: cents,
                paidAt: new Date(time).toISOString(),
                description: note,
              })
            }
          >
            Submit recovery report
          </button>
        </fieldset>
      )}
      {action.message && <p role="status">{action.message}</p>}
      {action.pending && (
        <button
          disabled={action.busy}
          onClick={() => action.run(action.pending!.path, action.pending!.body)}
        >
          Retry saved request
        </button>
      )}
    </div>
  );
}
function RefundForm({ item, close }: { item: Case; close: () => void }) {
  const action = useWalletAction(`recovery-case-${item.id}`);
  const [incoming, setIncoming] = useState(''),
    [amount, setAmount] = useState(''),
    [refund, setRefund] = useState(''),
    [time, setTime] = useState(''),
    [note, setNote] = useState(''),
    [code, setCode] = useState(''),
    [checked, setChecked] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const cents = inputToMinor(amount, currencyMinorDigits(item.order.fiatCurrency)),
    timestamp = new Date(time).getTime();
  const valid =
    checked &&
    /^[0-9]{6}$/.test(code) &&
    cents !== null &&
    incoming.trim().length >= 3 &&
    refund.trim().length >= 3 &&
    note.trim().length >= 3 &&
    Number.isFinite(timestamp) &&
    timestamp >= new Date(item.paidAt).getTime() &&
    timestamp <= Date.now();
  return (
    <fieldset>
      <legend>Record full external refund · {item.order.orderNumber}</legend>
      <p>
        Verify the incoming transfer and full refund in the payment provider’s records. This form
        records a completed refund; it does not send money. Unverified and partial refunds must
        remain under investigation.
      </p>
      <label>
        Verified incoming reference
        <input maxLength={128} value={incoming} onChange={(e) => setIncoming(e.target.value)} />
      </label>
      <label>
        Verified amount received and fully refunded ({item.order.fiatCurrency})
        <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </label>
      <label>
        Refund transfer reference
        <input maxLength={128} value={refund} onChange={(e) => setRefund(e.target.value)} />
      </label>
      <label>
        Refund time (local)
        <input type="datetime-local" value={time} onChange={(e) => setTime(e.target.value)} />
      </label>
      <p>
        Verification notes are visible to the member. Do not include private credentials or
        unrelated account details.
      </p>
      <label>
        Verification notes
        <textarea maxLength={4000} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <label>
        <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />I
        verified the full amount was returned to the original payer.
      </label>
      <label>
        Authenticator code
        <input
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
      </label>
      <p>
        An enabled authenticator is required. <Link to="/profile#security">Security settings</Link>
      </p>
      <button
        disabled={busy || action.blocked || !valid}
        onClick={async () => {
          setBusy(true);
          setError('');
          try {
            await boundedRequest((signal) =>
              api.post(
                '/security/step-up/verify',
                { purpose: `LATE_PAYMENT_REFUND:${item.id}`, factorType: 'TOTP', code },
                undefined,
                { signal }
              )
            );
            setCode('');
            await action.run(`/late-payments/${item.id}/refund`, {
              verifiedPaymentReference: incoming,
              verifiedAmount: cents,
              refundReference: refund,
              refundedAt: new Date(time).toISOString(),
              resolutionNote: note,
              verified: true,
            });
          } catch (e) {
            setError(walletError(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        Confirm verified refund
      </button>
      <button disabled={busy || action.busy} onClick={close}>
        Back
      </button>
      {error && <p role="alert">{error}</p>}
      {action.message && <p role="status">{action.message}</p>}
      {action.pending && (
        <button
          disabled={action.busy}
          onClick={() => action.run(action.pending!.path, action.pending!.body)}
        >
          Retry saved request
        </button>
      )}
    </fieldset>
  );
}

function SupervisionForm({item, operation, close}: {item: Case; operation: 'release' | 'reject'; close: () => void}) {
  const [reason, setReason] = useState('');
  const action = useWalletAction(`recovery-${operation}-${item.id}`);
  return <fieldset>
    <legend>{operation === 'release' ? 'Release investigation assignment' : 'Reject recovery claim'} · {item.order.orderNumber}</legend>
    <p>{operation === 'release' ? 'The case returns to the open queue for another reviewer. No funds move.' : 'This closes the case without a refund or Coin credit. The member can read your reason. This decision cannot be undone.'}</p>
    <label>Decision reason<textarea maxLength={4000} value={reason} onChange={e => setReason(e.target.value)} /></label>
    <button disabled={action.blocked || reason.trim().length < 3} onClick={() => action.run(`/late-payments/${item.id}/${operation}`, {reason})}>Confirm {operation === 'release' ? 'release' : 'rejection'}</button>
    <button disabled={action.busy} onClick={close}>Back</button>
    {action.message && <p role="status">{action.message}</p>}
    {action.pending && <button disabled={action.busy} onClick={() => action.run(action.pending!.path, action.pending!.body)}>Retry saved request</button>}
  </fieldset>;
}

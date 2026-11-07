import { interfaceCodeLabel } from '@/lib/i18n/labels';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { boundedRequest } from '@/lib/bounded-request';
import { currencyMinorDigits, inputToMinor, formatMinor } from '@/lib/payment-money';
import { api, unwrapData } from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';
import { useWalletAction, walletError } from '@/hooks/use-wallet-action';
import { useLanguage as useInterfaceLanguage } from '@/providers/language-provider';

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
  const { t: translateUi, locale: interfaceLocale } = useInterfaceLanguage();

  const { user } = useAuth();
  const [page, setPage] = useState(0);
  const [decision, setDecision] = useState<{ item: Case; operation: 'release' | 'reject' } | null>(
    null
  );
  const cases = useQuery({
    queryKey: ['payments', 'late', user?.id, admin, page],
    queryFn: async () =>
      unwrapData(
        await api.get<Case[]>(
          `/late-payments/${admin ? 'pending' : 'me'}${page ? `?page=${page}` : ''}`
        )
      ),
    enabled: !!user,
    refetchInterval: 30000,
  });
  const access = useQuery({
    queryKey: ['workspace-access', user?.id],
    queryFn: async () => unwrapData(await api.get<{ role: string }>('/workspaces/access')),
    enabled: admin && !!user,
    retry: false,
  });
  const action = useWalletAction('recovery-queue');
  const [selected, setSelected] = useState<Case | null>(null);
  return (
    <section className="payment-panel">
      <h2>{translateUi('Late-payment recovery')}</h2>
      <p>
        {translateUi(
          'Page {value} · up to 50 cases. Staff queues show oldest reports first. Super administrators can review every assignment.',
          { value: page + 1 }
        )}
      </p>
      <p>
        {translateUi(
          'Reports are investigated separately from deposit orders. A recorded refund means staff verified a transfer back to the payer; it does not add ETB.'
        )}
      </p>
      {cases.isPending ? (
        <p role="status">{translateUi('Loading recovery cases…')}</p>
      ) : cases.isError ? (
        <p role="alert">
          {translateUi('Could not load recovery cases.') + ' '}
          <button onClick={() => cases.refetch()}>{translateUi('Retry')}</button>
        </p>
      ) : !cases.data?.length ? (
        <p>{translateUi('No recovery cases.')}</p>
      ) : (
        cases.data.map((c) => (
          <article className="payment-record" key={c.id}>
            <strong>
              {c.order.orderNumber} · {interfaceCodeLabel(translateUi, c.status)}
            </strong>
            <p>
              {translateUi('Reported transfer: {paymentReference} · {value}', {
                paymentReference: c.paymentReference,
                value: formatMinor(c.paidAmount, c.order.fiatCurrency),
              })}
            </p>
            <p>
              {new Date(c.paidAt).toLocaleString(interfaceLocale)} · {c.description}
            </p>
            <Link to={`/wallet/orders/deposit/${c.orderId}`}>{translateUi('Order conversation')}</Link>
            {c.refundReference && (
              <p>
                {translateUi('Refund reference: {refundReference}. {resolutionNote}', {
                  refundReference: c.refundReference,
                  resolutionNote: c.resolutionNote ?? '',
                })}
              </p>
            )}
            {c.status === 'REJECTED' && (
              <p>
                {translateUi('Reason: {resolutionNote}', {
                  resolutionNote: c.resolutionNote ?? '',
                })}
              </p>
            )}
            {admin && access.data?.role === 'SUPER_ADMIN' && c.status === 'ASSIGNED' && (
              <>
                <button
                  disabled={action.blocked}
                  onClick={() => setDecision({ item: c, operation: 'release' })}
                >
                  {translateUi('Release assignment')}
                </button>
                {c.assignedAdminId === user?.id && (
                  <button
                    disabled={action.blocked}
                    onClick={() => setDecision({ item: c, operation: 'reject' })}
                  >
                    {translateUi('Reject claim')}
                  </button>
                )}
              </>
            )}
            {admin && c.status === 'OPEN' && (
              <button
                disabled={action.blocked}
                onClick={() => action.run(`/late-payments/${c.id}/claim`)}
              >
                {translateUi('Claim investigation')}
              </button>
            )}
            {admin && c.status === 'ASSIGNED' && c.assignedAdminId === user?.id && (
              <button disabled={action.blocked} onClick={() => setSelected(c)}>
                {translateUi('Record verified refund')}
              </button>
            )}
          </article>
        ))
      )}
      {action.message && <p role="status">{translateUi(action.message)}</p>}
      {action.pending && (
        <button
          disabled={action.busy}
          onClick={() => action.run(action.pending!.path, action.pending!.body)}
        >
          {translateUi('Retry saved request')}
        </button>
      )}
      <nav aria-label={translateUi('Recovery pages')}>
        <button
          disabled={page === 0 || cases.isFetching}
          onClick={() => {
            setPage(page - 1);
            setSelected(null);
            setDecision(null);
          }}
        >
          {translateUi('Previous page')}
        </button>
        <button
          disabled={cases.isFetching || cases.isError || (cases.data?.length ?? 0) < 50}
          onClick={() => {
            setPage(page + 1);
            setSelected(null);
            setDecision(null);
          }}
        >
          {translateUi('Next page')}
        </button>
      </nav>
      {decision && (
        <SupervisionForm
          key={`${decision.item.id}-${decision.operation}`}
          {...decision}
          close={() => setDecision(null)}
        />
      )}
      {selected && <RefundForm key={selected.id} item={selected} close={() => setSelected(null)} />}
    </section>
  );
}
export function LatePaymentReport({ orderId, currency }: { orderId: string; currency: string }) {
  const { t: translateUi } = useInterfaceLanguage();

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
        {open ? translateUi('Close report') : translateUi('Already paid? Report transfer')}
      </button>
      {open && (
        <fieldset>
          <legend>{translateUi('Report payment after closure')}</legend>
          <p>
            {translateUi(
              'Do not send another payment. Enter the actual transfer details; this report does not confirm receipt or credit your balance.'
            )}
          </p>
          <label>
            {translateUi('Transfer reference')}
            <input
              maxLength={128}
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </label>
          <label>
            {translateUi('Amount sent (')}
            {currency})
            <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </label>
          <label>
            {translateUi('Transfer time (local)')}
            <input type="datetime-local" value={time} onChange={(e) => setTime(e.target.value)} />
          </label>
          <label>
            {translateUi('Details')}
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
            {translateUi('Submit recovery report')}
          </button>
        </fieldset>
      )}
      {action.message && <p role="status">{translateUi(action.message)}</p>}
      {action.pending && (
        <button
          disabled={action.busy}
          onClick={() => action.run(action.pending!.path, action.pending!.body)}
        >
          {translateUi('Retry saved request')}
        </button>
      )}
    </div>
  );
}
function RefundForm({ item, close }: { item: Case; close: () => void }) {
  const { t: translateUi } = useInterfaceLanguage();

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
      <legend>
        {translateUi('Record full external refund · {orderNumber}', {
          orderNumber: item.order.orderNumber,
        })}
      </legend>
      <p>
        {translateUi(
          'Verify the incoming transfer and full refund in the payment provider’s records. This form records a completed refund; it does not send money. Unverified and partial refunds must remain under investigation.'
        )}
      </p>
      <label>
        {translateUi('Verified incoming reference')}
        <input maxLength={128} value={incoming} onChange={(e) => setIncoming(e.target.value)} />
      </label>
      <label>
        {translateUi('Verified amount received and fully refunded (')}
        {item.order.fiatCurrency})
        <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </label>
      <label>
        {translateUi('Refund transfer reference')}
        <input maxLength={128} value={refund} onChange={(e) => setRefund(e.target.value)} />
      </label>
      <label>
        {translateUi('Refund time (local)')}
        <input type="datetime-local" value={time} onChange={(e) => setTime(e.target.value)} />
      </label>
      <p>
        {translateUi(
          'Verification notes are visible to the member. Do not include private credentials or unrelated account details.'
        )}
      </p>
      <label>
        {translateUi('Verification notes')}
        <textarea maxLength={4000} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <label>
        <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
        {translateUi('I verified the full amount was returned to the original payer.')}
      </label>
      <label>
        {translateUi('Authenticator code')}
        <input
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
      </label>
      <p>
        {translateUi('An enabled authenticator is required.') + ' '}
        <Link to="/profile#security">{translateUi('Security settings')}</Link>
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
        {translateUi('Confirm verified refund')}
      </button>
      <button disabled={busy || action.busy} onClick={close}>
        {translateUi('Back')}
      </button>
      {error && <p role="alert">{translateUi(error)}</p>}
      {action.message && <p role="status">{translateUi(action.message)}</p>}
      {action.pending && (
        <button
          disabled={action.busy}
          onClick={() => action.run(action.pending!.path, action.pending!.body)}
        >
          {translateUi('Retry saved request')}
        </button>
      )}
    </fieldset>
  );
}

function SupervisionForm({
  item,
  operation,
  close,
}: {
  item: Case;
  operation: 'release' | 'reject';
  close: () => void;
}) {
  const { t: translateUi } = useInterfaceLanguage();

  const [reason, setReason] = useState('');
  const action = useWalletAction(`recovery-${operation}-${item.id}`);
  return (
    <fieldset>
      <legend>
        {operation === 'release'
          ? translateUi('Release investigation assignment')
          : translateUi('Reject recovery claim')}{' '}
        · {item.order.orderNumber}
      </legend>
      <p>
        {operation === 'release'
          ? translateUi('The case returns to the open queue for another reviewer. No funds move.')
          : translateUi(
              'This closes the case without a refund or ETB credit. The member can read your reason. This decision cannot be undone.'
            )}
      </p>
      <label>
        {translateUi('Decision reason')}
        <textarea maxLength={4000} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <button
        disabled={action.blocked || reason.trim().length < 3}
        onClick={() => action.run(`/late-payments/${item.id}/${operation}`, { reason })}
      >
        {translateUi('Confirm {value}', {
          value: operation === 'release' ? translateUi('release') : translateUi('rejection'),
        })}
      </button>
      <button disabled={action.busy} onClick={close}>
        {translateUi('Back')}
      </button>
      {action.message && <p role="status">{translateUi(action.message)}</p>}
      {action.pending && (
        <button
          disabled={action.busy}
          onClick={() => action.run(action.pending!.path, action.pending!.body)}
        >
          {translateUi('Retry saved request')}
        </button>
      )}
    </fieldset>
  );
}

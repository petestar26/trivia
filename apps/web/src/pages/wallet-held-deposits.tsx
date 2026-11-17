import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, unwrapData } from '@/lib/api';
import { boundedRequest } from '@/lib/bounded-request';
import { interfaceCodeLabel } from '@/lib/i18n/labels';
import { currencyMinorDigits, formatMinor, inputToMinor } from '@/lib/payment-money';
import { requestStatus } from '@/lib/request-error';
import { walletError } from '@/hooks/use-wallet-action';
import { useAuth } from '@/providers/auth-provider';
import { useLanguage as useInterfaceLanguage } from '@/providers/language-provider';

// Held-deposit recovery. The server and database decide everything: this screen
// only shows a case and sends one explicit, confirmed decision. It never clears
// a safety hold and never sends money.
export type HeldCaseView = {
  state:
    | 'UNDER_REVIEW'
    | 'HELD'
    | 'RESOLVED_COINS_CREDITED'
    | 'RESOLVED_EXTERNAL_RETURN_RECORDED'
    | 'RESOLVED_UNPAID_CLOSED';
  memberDeclaration: 'NOT_PAID' | 'PAID' | null;
  canDeclareNotPaid: boolean;
  canDeclarePaid: boolean;
};
type QueueRow = {
  orderId: string;
  orderNumber: string;
  orderStatus: string;
  fiatAmount: number;
  fiatCurrency: string;
  coinAmount: number;
  createdAt: string;
  caseStatus: string;
  classification: string;
  memberDeclaration: 'NOT_PAID' | 'PAID' | null;
  assignedToMe: boolean;
  assigned: boolean;
  party: boolean;
};
type Queue = {
  canAdjudicate: boolean;
  monitoring: {
    openHeldOrders: number;
    reservedCoins: number;
    oldestHeldAt: string | null;
    maxOpenHeldPerMember: number;
  };
  cases: QueueRow[];
};
type Detail = {
  order: {
    id: string;
    orderNumber: string;
    status: string;
    agentName: string;
    fiatAmount: number;
    fiatCurrency: string;
    coinAmount: number;
    createdAt: string;
    paymentSubmittedAt: string | null;
    paymentSnapshot: Record<string, unknown> | null;
  };
  case: {
    status: string;
    classification: string;
    memberDeclaration: 'NOT_PAID' | 'PAID' | null;
    assignedToMe: boolean;
    version: number;
  } | null;
  reservation: { status: string; amount: number } | null;
  memberEvidence: { id: string; referenceNumber: string | null; createdAt: string }[];
  events: { id: string; kind: string; createdAt: string }[];
  adjudication: { outcome: string; createdAt: string } | null;
  policy: { unpaidReleaseEnabled: boolean; coinCreditEnabled: boolean; externalReturnEnabled: boolean };
  confirmationPurpose: string;
};
const OUTCOMES = {
  INVESTIGATE: 'Keep under investigation: payment claimed but not verified',
  VERIFIED_PAYMENT_RECEIVED: 'Verified payment received: credit the member’s coins',
  VERIFIED_EXTERNAL_RETURN: 'Verified external return: record it, credit no coins',
  VERIFIED_UNPAID: 'Verified unpaid: close the order',
} as const;
type Outcome = keyof typeof OUTCOMES;
const EXPLANATIONS: Record<Outcome, string> = {
  INVESTIGATE: 'Nothing moves. The order stays on hold for investigation.',
  VERIFIED_PAYMENT_RECEIVED:
    'This credits the member’s coins from the agent’s reserved inventory. It cannot be undone.',
  VERIFIED_EXTERNAL_RETURN:
    'This records a return that already happened outside the platform and releases the agent’s reserved inventory. It sends no money and credits no coins. Releasing the reservation is not a refund.',
  VERIFIED_UNPAID:
    'This closes the order and releases the agent’s reserved inventory. Use it only when the member has said they did not pay and nothing suggests a payment. It is not a refund.',
};
const EVIDENCE_KINDS = [
  'BANK_STATEMENT',
  'PROVIDER_CONFIRMATION',
  'AGENT_STATEMENT',
  'MEMBER_STATEMENT',
  'OTHER',
] as const;
const post = (path: string, body: Record<string, unknown> = {}) =>
  boundedRequest((signal) => api.post(path, body, undefined, { signal }));

const RESOLVED_TEXT: Record<string, string> = {
  RESOLVED_COINS_CREDITED:
    'Review finished: the payment was verified and the coins were credited to the member’s wallet.',
  RESOLVED_EXTERNAL_RETURN_RECORDED:
    'Review finished: the payment was returned outside the platform. No coins were credited.',
  RESOLVED_UNPAID_CLOSED:
    'Review finished: the order was closed with no payment recorded. No coins were credited.',
};

/** Member and agent view inside the order room: a plain state, never evidence. */
export function HeldDepositStatus({
  orderId,
  held,
  member,
}: {
  orderId: string;
  held: HeldCaseView;
  member: boolean;
}) {
  const { t: translateUi } = useInterfaceLanguage();
  const cache = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmNotPaid, setConfirmNotPaid] = useState(false);
  async function declare(declaration: 'NOT_PAID' | 'PAID') {
    setBusy(true);
    setError('');
    try {
      await post(`/held-deposits/${orderId}/declaration`, { declaration });
      setConfirmNotPaid(false);
      await cache.invalidateQueries({ queryKey: ['payments'] });
    } catch (e) {
      setError(walletError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="payment-panel" aria-label={translateUi('Safety hold')}>
      <strong>{translateUi('Safety hold')}</strong>
      <p role="status">
        {translateUi(
          RESOLVED_TEXT[held.state] ??
            'This order is on a safety hold while payment support reviews it. Do not send another payment for this order.'
        )}
      </p>
      {member && held.memberDeclaration === 'PAID' && (
        <p>{translateUi('You told us you sent this payment. Payment support will check it.')}</p>
      )}
      {member && held.memberDeclaration === 'NOT_PAID' && (
        <p>{translateUi('You told us you did not send this payment.')}</p>
      )}
      {member && held.canDeclarePaid && (
        <button disabled={busy} onClick={() => declare('PAID')}>
          {translateUi('I sent this payment')}
        </button>
      )}
      {member && held.canDeclareNotPaid && !confirmNotPaid && (
        <button disabled={busy} onClick={() => setConfirmNotPaid(true)}>
          {translateUi('I did not send this payment')}
        </button>
      )}
      {member && held.canDeclareNotPaid && confirmNotPaid && (
        <>
          <p>
            {translateUi(
              'Only confirm if you sent no money for this order. If you paid, the order may be closed without coins.'
            )}
          </p>
          <button disabled={busy} onClick={() => declare('NOT_PAID')}>
            {translateUi('Confirm: I did not pay')}
          </button>
          <button disabled={busy} onClick={() => setConfirmNotPaid(false)}>
            {translateUi('Back')}
          </button>
        </>
      )}
      {error && <p role="alert">{translateUi(error)}</p>}
    </section>
  );
}

/** Staff queue. Ordinary administrators see amounts and ages only. */
export function HeldDepositCases() {
  const { t: translateUi, locale } = useInterfaceLanguage();
  const { user } = useAuth();
  const cache = useQueryClient();
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const queue = useQuery({
    queryKey: ['payments', 'held-deposits', user?.id, page],
    queryFn: async () =>
      unwrapData(await api.get<Queue>(`/held-deposits${page ? `?page=${page}` : ''}`)),
    enabled: !!user,
    refetchInterval: 30000,
  });
  // A malformed response is shown as a load failure; it must never break the page.
  const data =
    queue.data && Array.isArray(queue.data.cases) && queue.data.monitoring ? queue.data : undefined;
  async function claim(orderId: string) {
    setBusy(true);
    setError('');
    try {
      await post(`/held-deposits/${orderId}/claim`);
      await cache.invalidateQueries({ queryKey: ['payments'] });
      setOpen(orderId);
    } catch (e) {
      setError(walletError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="payment-panel">
      <h2>{translateUi('Held deposit cases')}</h2>
      <p>
        {translateUi(
          'These deposits are on a safety hold because their receiving account was disabled. The hold is never lifted here. Only a main administrator can record a verified outcome.'
        )}
      </p>
      {queue.isPending ? (
        <p role="status">{translateUi('Loading held deposit cases…')}</p>
      ) : queue.isError || !data ? (
        <p role="alert">
          {translateUi('Could not load held deposit cases.') + ' '}
          <button onClick={() => queue.refetch()}>{translateUi('Retry')}</button>
        </p>
      ) : (
        <>
          <p>
            {translateUi(
              'Open held orders: {open} · Reserved coins: {reserved} · Most for one member: {most}',
              {
                open: data.monitoring.openHeldOrders,
                reserved: data.monitoring.reservedCoins,
                most: data.monitoring.maxOpenHeldPerMember,
              }
            )}
            {data.monitoring.oldestHeldAt &&
              ' · ' +
                translateUi('Oldest: {value}', {
                  value: new Date(data.monitoring.oldestHeldAt).toLocaleString(locale),
                })}
          </p>
          {!data.cases.length && <p>{translateUi('No held deposit cases.')}</p>}
          {data.cases.map((c) => (
            <article className="payment-record" key={c.orderId}>
              <strong>
                {c.orderNumber} · {interfaceCodeLabel(translateUi, c.orderStatus)} ·{' '}
                {formatMinor(c.fiatAmount, c.fiatCurrency)}
              </strong>
              <p>
                {new Date(c.createdAt).toLocaleString(locale)} ·{' '}
                {interfaceCodeLabel(translateUi, c.classification)}
                {c.memberDeclaration === 'PAID' && ' · ' + translateUi('Member says: paid')}
                {c.memberDeclaration === 'NOT_PAID' && ' · ' + translateUi('Member says: not paid')}
                {c.assigned &&
                  ' · ' + translateUi(c.assignedToMe ? 'Assigned to you' : 'Assigned to another administrator')}
              </p>
              {data.canAdjudicate && !c.party && !c.assigned && (
                <button disabled={busy} onClick={() => claim(c.orderId)}>
                  {translateUi('Claim case')}
                </button>
              )}
              {data.canAdjudicate && !c.party && (
                <button disabled={busy} onClick={() => setOpen(open === c.orderId ? null : c.orderId)}>
                  {translateUi(open === c.orderId ? 'Close case' : 'Open case')}
                </button>
              )}
              {open === c.orderId && <HeldCaseDetail orderId={c.orderId} close={() => setOpen(null)} />}
            </article>
          ))}
          {error && <p role="alert">{translateUi(error)}</p>}
          <nav aria-label={translateUi('Held deposit pages')}>
            <button disabled={page === 0 || queue.isFetching} onClick={() => setPage(page - 1)}>
              {translateUi('Previous page')}
            </button>
            <button
              disabled={queue.isFetching || data.cases.length < 50}
              onClick={() => setPage(page + 1)}
            >
              {translateUi('Next page')}
            </button>
          </nav>
        </>
      )}
    </section>
  );
}

function HeldCaseDetail({ orderId, close }: { orderId: string; close: () => void }) {
  const { t: translateUi, locale } = useInterfaceLanguage();
  const { user } = useAuth();
  const cache = useQueryClient();
  const detail = useQuery({
    queryKey: ['payments', 'held-deposit', user?.id, orderId],
    queryFn: async () => unwrapData(await api.get<Detail>(`/held-deposits/${orderId}`)),
    enabled: !!user,
    retry: false,
  });
  const [outcome, setOutcome] = useState<Outcome>('INVESTIGATE'),
    [reason, setReason] = useState(''),
    [kind, setKind] = useState<(typeof EVIDENCE_KINDS)[number]>('BANK_STATEMENT'),
    [evidenceReference, setEvidenceReference] = useState(''),
    [evidenceNote, setEvidenceNote] = useState(''),
    [incoming, setIncoming] = useState(''),
    [amount, setAmount] = useState(''),
    [paidAt, setPaidAt] = useState(''),
    [returned, setReturned] = useState(''),
    [returnedAt, setReturnedAt] = useState(''),
    [code, setCode] = useState(''),
    [checked, setChecked] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [done, setDone] = useState('');
  // One key per decision form: a retry after an uncertain failure repeats the
  // same request, so the server returns the original result instead of acting twice.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  if (detail.isPending) return <p role="status">{translateUi('Loading held deposit cases…')}</p>;
  if (detail.isError || !detail.data?.order || !detail.data.policy)
    return <p role="alert">{translateUi(walletError(detail.error))}</p>;
  const d = detail.data;
  const mine = !!d.case?.assignedToMe && !d.adjudication;
  const enabled: Record<Outcome, boolean> = {
    INVESTIGATE: true,
    VERIFIED_PAYMENT_RECEIVED: d.policy.coinCreditEnabled,
    VERIFIED_EXTERNAL_RETURN: d.policy.externalReturnEnabled,
    VERIFIED_UNPAID: d.policy.unpaidReleaseEnabled,
  };
  const minor = inputToMinor(amount, currencyMinorDigits(d.order.fiatCurrency));
  const past = (value: string) => {
    const time = new Date(value).getTime();
    return Number.isFinite(time) && time <= Date.now();
  };
  const needsPayment = outcome === 'VERIFIED_PAYMENT_RECEIVED' || outcome === 'VERIFIED_EXTERNAL_RETURN';
  const needsReturn = outcome === 'VERIFIED_EXTERNAL_RETURN';
  const financial = outcome !== 'INVESTIGATE';
  const valid =
    mine &&
    enabled[outcome] &&
    reason.trim().length >= 10 &&
    (!financial ||
      (checked &&
        /^[0-9]{6}$/.test(code) &&
        evidenceReference.trim().length >= 1 &&
        evidenceNote.trim().length >= 3)) &&
    (!needsPayment || (incoming.trim().length >= 3 && minor !== null && past(paidAt))) &&
    (!needsReturn || (returned.trim().length >= 3 && past(returnedAt)));
  async function submit() {
    if (!d.case) return;
    setBusy(true);
    setError('');
    try {
      if (!financial) {
        await post(`/held-deposits/${orderId}/investigate`, {
          expectedCaseVersion: d.case.version,
          note: reason,
        });
      } else {
        await post('/security/step-up/verify', {
          purpose: d.confirmationPurpose,
          factorType: 'TOTP',
          code,
        });
        setCode('');
        await post(`/held-deposits/${orderId}/adjudicate`, {
          outcome,
          idempotencyKey,
          expectedCaseVersion: d.case.version,
          reason,
          evidence: [{ kind, reference: evidenceReference, description: evidenceNote }],
          verified: true,
          ...(needsPayment && {
            verifiedPaymentReference: incoming.trim(),
            verifiedAmount: minor,
            verifiedPaidAt: new Date(paidAt).toISOString(),
          }),
          ...(needsReturn && {
            returnReference: returned.trim(),
            returnedAmount: minor,
            returnedAt: new Date(returnedAt).toISOString(),
          }),
        });
      }
      setDone('Decision recorded.');
      setIdempotencyKey(crypto.randomUUID());
      await cache.invalidateQueries({ queryKey: ['payments'] });
    } catch (e) {
      // A definite refusal ends this attempt; an uncertain failure keeps the key.
      if ([400, 401, 403, 404, 409, 422].includes(requestStatus(e) ?? 0))
        setIdempotencyKey(crypto.randomUUID());
      setError(walletError(e));
    } finally {
      setBusy(false);
    }
  }
  async function handBack() {
    if (!d.case) return;
    setBusy(true);
    setError('');
    try {
      await post(`/held-deposits/${orderId}/release`, {
        expectedCaseVersion: d.case.version,
        note: reason,
      });
      await cache.invalidateQueries({ queryKey: ['payments'] });
      close();
    } catch (e) {
      setError(walletError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <fieldset>
      <legend>
        {translateUi('Held deposit case · {orderNumber}', { orderNumber: d.order.orderNumber })}
      </legend>
      <p>
        {formatMinor(d.order.fiatAmount, d.order.fiatCurrency)} · {d.order.agentName} ·{' '}
        {translateUi('Agent reservation: {status}', {
          status: interfaceCodeLabel(translateUi, d.reservation?.status ?? 'MISSING'),
        })}
      </p>
      <strong>{translateUi('Original receiving details (cannot be changed)')}</strong>
      <dl>
        {Object.entries(d.order.paymentSnapshot ?? {}).map(([name, value]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd>{String(value)}</dd>
          </div>
        ))}
      </dl>
      <p>
        {translateUi('Member payment records: {count}', { count: d.memberEvidence.length })}
        {d.case?.memberDeclaration === 'PAID' && ' · ' + translateUi('Member says: paid')}
        {d.case?.memberDeclaration === 'NOT_PAID' && ' · ' + translateUi('Member says: not paid')}
      </p>
      <Link to={`/wallet/orders/deposit/${orderId}`}>{translateUi('Order conversation')}</Link>
      <strong>{translateUi('Case history')}</strong>
      <ul>
        {d.events.map((e) => (
          <li key={e.id}>
            {new Date(e.createdAt).toLocaleString(locale)} · {interfaceCodeLabel(translateUi, e.kind)}
          </li>
        ))}
      </ul>
      {d.adjudication ? (
        <p role="status">
          {translateUi('Decision recorded.')} {interfaceCodeLabel(translateUi, d.adjudication.outcome)}
        </p>
      ) : !mine ? (
        <p>{translateUi('Claim this case to record a decision.')}</p>
      ) : (
        <>
          <label>
            {translateUi('Decision')}
            <select value={outcome} onChange={(e) => setOutcome(e.target.value as Outcome)}>
              {(Object.keys(OUTCOMES) as Outcome[]).map((name) => (
                <option key={name} value={name} disabled={!enabled[name]}>
                  {translateUi(OUTCOMES[name])}
                </option>
              ))}
            </select>
          </label>
          <p>{translateUi(EXPLANATIONS[outcome])}</p>
          {(Object.keys(OUTCOMES) as Outcome[]).some((name) => !enabled[name]) && (
            <p>
              {translateUi(
                'Outcomes that are not yet approved are switched off and cannot be recorded.'
              )}
            </p>
          )}
          <label>
            {translateUi('Decision reason')}
            <textarea maxLength={4000} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          {financial && (
            <>
              <label>
                {translateUi('Evidence type')}
                <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                  {EVIDENCE_KINDS.map((name) => (
                    <option key={name} value={name}>
                      {interfaceCodeLabel(translateUi, name)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {translateUi('Evidence reference')}
                <input
                  maxLength={200}
                  value={evidenceReference}
                  onChange={(e) => setEvidenceReference(e.target.value)}
                />
              </label>
              <label>
                {translateUi('What the evidence shows')}
                <textarea
                  maxLength={1000}
                  value={evidenceNote}
                  onChange={(e) => setEvidenceNote(e.target.value)}
                />
              </label>
            </>
          )}
          {needsPayment && (
            <>
              <label>
                {translateUi('Verified incoming reference')}
                <input maxLength={128} value={incoming} onChange={(e) => setIncoming(e.target.value)} />
              </label>
              <label>
                {translateUi('Verified amount ({currency})', { currency: d.order.fiatCurrency })}
                <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
              </label>
              <label>
                {translateUi('Transfer time (local)')}
                <input type="datetime-local" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />
              </label>
            </>
          )}
          {needsReturn && (
            <>
              <label>
                {translateUi('Return transfer reference')}
                <input maxLength={128} value={returned} onChange={(e) => setReturned(e.target.value)} />
              </label>
              <label>
                {translateUi('Return time (local)')}
                <input
                  type="datetime-local"
                  value={returnedAt}
                  onChange={(e) => setReturnedAt(e.target.value)}
                />
              </label>
            </>
          )}
          {financial && (
            <>
              <label>
                <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
                {translateUi('I checked this evidence myself against the payment provider’s records.')}
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
            </>
          )}
          <button disabled={busy || !valid} onClick={submit}>
            {translateUi(financial ? 'Record decision' : 'Save investigation note')}
          </button>
          <button disabled={busy || reason.trim().length < 10} onClick={handBack}>
            {translateUi('Hand case back')}
          </button>
        </>
      )}
      <button disabled={busy} onClick={close}>
        {translateUi('Back')}
      </button>
      {error && <p role="alert">{translateUi(error)}</p>}
      {done && <p role="status">{translateUi(done)}</p>}
    </fieldset>
  );
}

import { paymentFieldLabel } from '@/lib/payment-field-label';
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Check, Clock, MessageCircle, Paperclip, ShieldCheck } from 'lucide-react';
import { api, unwrapData } from '@/lib/api';
import { formatEtb, formatMinor } from '@/lib/payment-money';
import { useAuth } from '@/providers/auth-provider';
import { useLanguage } from '@/providers/language-provider';
import { useWalletAction, walletError } from '@/hooks/use-wallet-action';
import { interfaceCodeLabel } from '@/lib/i18n/labels';
import { LatePaymentReport } from './wallet-late-payments';
import './wallet-payments.css';
import './wallet-order-room.css';

type Message = {
  id: string;
  role: string;
  mine: boolean;
  body: string;
  createdAt: string;
  attachment: { name: string; url: string } | null;
};
export type PaymentRoom = {
  id: string;
  kind: 'deposit' | 'withdrawal';
  role: 'member' | 'agent' | 'support';
  number: string;
  safetyHold?: boolean;
  status: string;
  coinAmount: number;
  fiatAmount: string;
  fiatCurrency: string;
  paymentSnapshot: Record<string, unknown> | null;
  pricingSnapshot: { minorDigits: number; feeMinor: number } | null;
  createdAt: string;
  serverNow: string;
  deadline: string | null;
  confirmationDeadline: string | null;
  memberName: string;
  agentName: string;
  hold: { status: string | null; amount: number };
  submission: { referenceNumber: string; submittedAt: string; note: string | null } | null;
  appeals: {
    id: string;
    reason: string;
    description: string;
    status: string;
    openedAt: string;
    resolutionNote: string | null;
  }[];
  recovery: {
    id: string;
    status: string;
    description: string;
    resolutionNote: string | null;
  } | null;
  messages: Message[];
  nextCursor: string | null;
  actions: Record<
    | 'markPaid'
    | 'release'
    | 'cancel'
    | 'claim'
    | 'submitPayout'
    | 'confirmReceipt'
    | 'appeal'
    | 'latePayment'
    | 'message',
    boolean
  >;
};
const statuses: Record<string, string> = {
  CREATED: 'Awaiting payment',
  HELD: 'Awaiting payout',
  PAYOUT_IN_PROGRESS: 'Payout in progress',
  PAYMENT_SUBMITTED: 'Awaiting confirmation',
  DISPUTE: 'Under review',
  DISPUTED: 'Under review',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  EXPIRED: 'Expired',
};
const labels = {
  markPaid: 'I have sent the payment',
  release: 'Payment verified · release ETB',
  cancel: 'Cancel unpaid order',
  claim: 'Claim payout',
  submitPayout: 'Record completed transfer',
  confirmReceipt: 'Confirm money received',
  appeal: 'Open appeal',
} as const;
type ActionName = keyof typeof labels;
const get = async <T,>(path: string) => unwrapData(await api.get<T>(path));

export function WalletOrderRoomPage() {
  const { user } = useAuth(),
    { kind, id } = useParams();
  return user && id && (kind === 'deposit' || kind === 'withdrawal') ? (
    <OrderRoom key={`${user.id}:${kind}:${id}`} userId={user.id} kind={kind} id={id} />
  ) : null;
}
function OrderRoom({
  userId,
  kind,
  id,
}: {
  userId: string;
  kind: 'deposit' | 'withdrawal';
  id: string;
}) {
  const { t, locale } = useLanguage();
  const query = useQuery({
    queryKey: ['payments', 'room', userId, kind, id],
    queryFn: () => get<PaymentRoom>(`/payment-orders/${kind}/${id}`),
    refetchInterval: 5000,
    retry: false,
  });
  const action = useWalletAction();
  const [selection, setSelection] = useState<ActionName | null>(null),
    [checked, setChecked] = useState(false),
    [description, setDescription] = useState(''),
    [reason, setReason] = useState('OTHER'),
    [reference, setReference] = useState('');
  const [draft, setDraft] = useState(''),
    [attachment, setAttachment] = useState<{
      name: string;
      mimeType: string;
      base64: string;
    } | null>(null),
    [fileError, setFileError] = useState(''),
    [fileBusy, setFileBusy] = useState(false);
  const [older, setOlder] = useState<Message[]>([]),
    [olderCursor, setOlderCursor] = useState<string | null | undefined>(),
    [loadingOlder, setLoadingOlder] = useState(false),
    [olderError, setOlderError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const p = query.data;
  // Polling fetches the newest page. Preserve already read messages so a long
  // conversation cannot lose its middle after the next fifty messages arrive.
  useEffect(() => {
    if (!p?.messages) return;
    setOlder((seen) => [
      ...new Map([...seen, ...p.messages].map((message) => [message.id, message])).values(),
    ]);
  }, [p?.messages]);
  const serverNow = p ? Date.parse(p.serverNow) + Math.max(0, now - query.dataUpdatedAt) : now;
  const visibleDeadline =
    p?.status === 'PAYMENT_SUBMITTED' && kind === 'withdrawal'
      ? p.confirmationDeadline
      : p?.deadline;
  const deadline = visibleDeadline ? Date.parse(visibleDeadline) : null;
  const expired = deadline !== null && deadline <= serverNow;
  const blocked = action.blocked || query.isError || !p || now - query.dataUpdatedAt > 20000;
  const can = (name: ActionName) => !!p?.actions[name] && !(name === 'markPaid' && expired);
  const status = p?.safetyHold ? t('Safety hold — contact payment support. Do not send money.') : t(statuses[p?.status ?? ''] ?? 'Loading…');
  const terminal = !!p && ['COMPLETED', 'CANCELLED', 'EXPIRED'].includes(p.status);
  const activeAppeal = p?.appeals.find((d) => ['OPEN', 'ASSIGNED'].includes(d.status));
  const steps = [t('Order created'), t('Payment transfer'), t('Confirmation'), t('Completed')];
  const step = p?.status === 'COMPLETED' ? 3 : p?.status === 'PAYMENT_SUBMITTED' ? 2 : 1;
  function choose(name: ActionName) {
    setSelection(name);
    setChecked(false);
    setDescription('');
    setReference('');
    setReason('OTHER');
  }
  async function confirm() {
    if (!selection || !p || !can(selection) || blocked || !checked) return;
    const base = kind === 'deposit' ? `/agent-orders/${id}` : `/withdrawals/${id}`;
    const paths = {
      markPaid: `${base}/submit-payment`,
      release: `${base}/settle`,
      cancel: `${base}/cancel`,
      claim: `${base}/claim-payout`,
      submitPayout: `${base}/submit-payment`,
      confirmReceipt: `${base}/confirm-receipt`,
      appeal: kind === 'deposit' ? '/agent-disputes' : `${base}/appeal`,
    };
    const body =
      selection === 'appeal'
        ? {
            ...(kind === 'deposit' ? { orderId: id } : {}),
            reason,
            description: description.trim(),
          }
        : selection === 'submitPayout'
          ? { referenceNumber: reference.trim(), note: description.trim().slice(0, 1024) }
          : {};
    if (await action.run(paths[selection], body)) setSelection(null);
  }
  async function readFile(file?: File) {
    setAttachment(null);
    setFileError('');
    if (!file) return;
    if (
      file.size > 2 * 1024 * 1024 ||
      !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)
    ) {
      setFileError(t('Use a PNG, JPEG or WebP receipt up to 2 MB.'));
      return;
    }
    setFileBusy(true);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(Error('Receipt could not load.'));
        reader.readAsDataURL(file);
      });
      setAttachment({ name: file.name, mimeType: file.type, base64 });
    } catch (e) {
      setFileError(t(walletError(e)));
    } finally {
      setFileBusy(false);
    }
  }
  async function retrySaved() {
    const pending = action.pending;
    if (!pending || !(await action.run(pending.path, pending.body))) return;
    if (
      pending.path === `/payment-orders/${kind}/${id}/messages` &&
      pending.body.body === draft.trim()
    ) {
      setDraft('');
      setAttachment(null);
      if (fileInput.current) fileInput.current.value = '';
    } else if (pending.path.includes(id) || pending.body.orderId === id) setSelection(null);
  }
  async function send() {
    if (blocked || fileBusy || !p?.actions.message || (!draft.trim() && !attachment)) return;
    if (
      await action.run(`/payment-orders/${kind}/${id}/messages`, {
        body: draft.trim(),
        ...(attachment ? { attachment } : {}),
      })
    ) {
      setDraft('');
      setAttachment(null);
      if (fileInput.current) fileInput.current.value = '';
    }
  }
  async function loadOlder() {
    const cursor = olderCursor === undefined ? p?.nextCursor : olderCursor;
    if (!cursor || loadingOlder) return;
    setLoadingOlder(true);
    setOlderError('');
    try {
      const page = await get<PaymentRoom>(`/payment-orders/${kind}/${id}?before=${cursor}`);
      setOlder((items) => [...page.messages, ...items]);
      setOlderCursor(page.nextCursor);
    } catch (e) {
      setOlderError(t(walletError(e)));
    } finally {
      setLoadingOlder(false);
    }
  }
  const messages = [
    ...new Map([...older, ...(p?.messages ?? [])].map((m) => [m.id, m])).values(),
  ].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
  return (
    <div className="payments-page p2p-page">
      <Link
        className="p2p-back"
        to={
          p?.role === 'agent'
            ? '/agent/operations'
            : p?.role === 'support'
              ? '/admin/disputes'
              : '/wallet/activity'
        }
      >
        <ArrowLeft size={16} />
        {t('Back to payments')}
      </Link>
      <header className="p2p-header">
        <div>
          <p className="payment-eyebrow">{t('AGENT PAYMENTS')}</p>
          <h1>{t(kind === 'deposit' ? 'Deposit order' : 'Withdrawal order')}</h1>
          <strong>{p?.number}</strong>
        </div>
        <span className="p2p-status" data-status={p?.status}>
          {status}
        </span>
      </header>
      {query.isPending && <p role="status">{t('Loading request details…')}</p>}
      {query.isError && (
        <div role="alert" className="payment-error">
          {t('Request details could not load.')}{' '}
          <button onClick={() => query.refetch()}>{t('Retry')}</button>
        </div>
      )}
      {action.message && (
        <p role="status" className="payment-disclosure">
          {t(action.message)}
        </p>
      )}
      {action.pending && (
        <button disabled={action.busy} onClick={retrySaved}>
          {t('Retry saved request')}
        </button>
      )}
      {p && (
        <>
          <ol className="p2p-steps" aria-label={t('Payment progress')}>
            {steps.map((label, i) => (
              <li
                key={label}
                data-current={!terminal && i === step}
                data-complete={i < step || p.status === 'COMPLETED'}
              >
                <span>{i < step || p.status === 'COMPLETED' ? <Check size={15} /> : i + 1}</span>
                {label}
              </li>
            ))}
          </ol>
          <div className="p2p-grid">
            <section className="p2p-order">
              <div className="payment-panel p2p-summary">
                <div className="p2p-amounts">
                  <div>
                    <span>{t('Wallet amount')}</span>
                    <strong>{formatEtb(p.coinAmount)}</strong>
                  </div>
                  <div>
                    <span>{t('Payment amount')}</span>
                    <strong>
                      {formatMinor(p.fiatAmount, p.fiatCurrency, p.pricingSnapshot?.minorDigits)}
                    </strong>
                  </div>
                  <div>
                    <span>{t('Fee')}</span>
                    <strong>
                      {formatMinor(
                        p.pricingSnapshot?.feeMinor ?? 0,
                        p.fiatCurrency,
                        p.pricingSnapshot?.minorDigits
                      )}
                    </strong>
                  </div>
                </div>
                <dl className="p2p-parties">
                  <div>
                    <dt>{t('Member')}</dt>
                    <dd>{p.memberName}</dd>
                  </div>
                  <div>
                    <dt>{t('Agent')}</dt>
                    <dd>{p.agentName}</dd>
                  </div>
                </dl>
                {p.hold.status === 'ACTIVE' && (
                  <p className="p2p-held">
                    <ShieldCheck size={19} />
                    {t('Order funds remain reserved until completion or review.')}
                  </p>
                )}
                {p.hold.status === 'REFUNDED' && (
                  <p className="p2p-held">{t('Held funds were returned to your wallet.')}</p>
                )}
                {!terminal && !activeAppeal && visibleDeadline && (
                  <p className="p2p-deadline">
                    <Clock size={17} />
                    {p.status === 'PAYMENT_SUBMITTED' && kind === 'withdrawal'
                      ? t('Confirmation deadline')
                      : expired
                        ? t('Payment deadline reached')
                        : t('Payment deadline')}
                    : <time>{new Date(visibleDeadline).toLocaleString(locale)}</time>
                  </p>
                )}
                {kind === 'deposit' && p.status === 'CREATED' && expired && (
                  <p className="payment-error">
                    {t(
                      'Do not send money after the deadline. If you already paid, open an appeal.'
                    )}
                  </p>
                )}
                {p.paymentSnapshot && (
                  <section className="p2p-bank">
                    <h2>{t('Payment details')}</h2>
                    <dl>
                      {Object.entries(p.paymentSnapshot).map(([key, value]) => (
                        <div key={key}>
                          <dt>{t(paymentFieldLabel(key))}</dt>
                          <dd>
                            {typeof value === 'string'
                              ? value
                              : t('Contact support for this detail')}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </section>
                )}
                {p.submission && (
                  <p>
                    <strong>{t('Transfer reference')}: </strong>
                    {p.submission.referenceNumber}
                  </p>
                )}
                {activeAppeal ? (
                  <div className="p2p-appeal" role="status">
                    <ShieldCheck size={22} />
                    <div>
                      <strong>{t('Appeal in progress')}</strong>
                      <p>
                        {t(
                          'Normal payment actions are paused. Support will review both sides and the evidence.'
                        )}
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="p2p-actions">
                    {(Object.keys(labels) as ActionName[]).filter(can).map((name) => (
                      <button
                        key={name}
                        className={name === 'appeal' ? 'p2p-appeal-button' : 'payment-primary'}
                        disabled={blocked}
                        onClick={() => choose(name)}
                      >
                        {t(
                          name === 'cancel' && kind === 'withdrawal'
                            ? 'Cancel and return held ETB'
                            : labels[name]
                        )}
                      </button>
                    ))}
                  </div>
                )}
                {p.actions.latePayment && (
                  <LatePaymentReport orderId={id} currency={p.fiatCurrency} />
                )}
                {p.role === 'support' && <Link to="/admin/disputes">{t('Open review desk')}</Link>}
              </div>
              {selection && (
                <section className="payment-panel p2p-confirm" aria-label={t('Confirm action')}>
                  <h2>
                    {t(
                      selection === 'cancel' && kind === 'withdrawal'
                        ? 'Cancel and return held ETB'
                        : labels[selection]
                    )}
                  </h2>
                  {['release', 'confirmReceipt'].includes(selection) && (
                    <p>
                      {t(
                        'Check your bank or mobile-money balance. A screenshot or message alone is not proof of receipt.'
                      )}
                    </p>
                  )}
                  {selection === 'markPaid' && (
                    <p>
                      {t(
                        'Only mark paid after you have sent the exact amount to the account on this order.'
                      )}
                    </p>
                  )}
                  {selection === 'cancel' && kind === 'deposit' && (
                    <p>{t('If you have already paid, open an appeal instead of cancelling.')}</p>
                  )}
                  {selection === 'claim' && (
                    <p>
                      {t(
                        'Check the payout details and order status before sending money. Stop if an appeal opens.'
                      )}
                    </p>
                  )}
                  {selection === 'submitPayout' && (
                    <label>
                      {t('Transfer reference')}
                      <input
                        maxLength={256}
                        value={reference}
                        onChange={(e) => setReference(e.target.value)}
                      />
                    </label>
                  )}
                  {selection === 'appeal' && (
                    <label>
                      {t('Appeal reason')}
                      <select value={reason} onChange={(e) => setReason(e.target.value)}>
                        <option value="OTHER">{t('Other')}</option>
                        <option
                          value={kind === 'deposit' ? 'PAYMENT_NOT_RECEIVED' : 'FIAT_NOT_RECEIVED'}
                        >
                          {t('Payment not received')}
                        </option>
                        <option value={kind === 'deposit' ? 'WRONG_AMOUNT' : 'WRONG_FIAT_AMOUNT'}>
                          {t('Wrong amount')}
                        </option>
                        <option value="AGENT_UNRESPONSIVE">{t('No response')}</option>
                      </select>
                    </label>
                  )}
                  {['appeal', 'submitPayout'].includes(selection) && (
                    <label>
                      {t('Describe the issue')}
                      <textarea
                        maxLength={selection === 'appeal' ? 4000 : 1024}
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                      />
                    </label>
                  )}
                  {selection === 'appeal' && (
                    <p>
                      {t(
                        'Add receipts and transfer references to the order conversation. Never share passwords or verification codes.'
                      )}
                    </p>
                  )}
                  <label className="payment-check">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => setChecked(e.target.checked)}
                    />
                    {t(
                      ['release', 'confirmReceipt'].includes(selection)
                        ? 'I received the full amount in my bank or mobile-money account.'
                        : selection === 'cancel' && kind === 'deposit'
                          ? 'I have not sent any money.'
                          : 'I checked the order details and understand this action.'
                    )}
                  </label>
                  {!can(selection) && (
                    <p role="alert">
                      {t('The order changed. Refresh its details before continuing.')}
                    </p>
                  )}
                  <div className="p2p-actions">
                    <button
                      className="payment-primary"
                      disabled={
                        blocked ||
                        !can(selection) ||
                        !checked ||
                        (selection === 'appeal' && !description.trim()) ||
                        (selection === 'submitPayout' && !reference.trim())
                      }
                      onClick={confirm}
                    >
                      {t('Confirm action')}
                    </button>
                    <button disabled={action.busy} onClick={() => setSelection(null)}>
                      {t('Back')}
                    </button>
                  </div>
                </section>
              )}
              {(p.appeals.length > 0 || p.recovery) && (
                <section className="payment-panel p2p-appeal-history">
                  <h2>{t('Appeal status')}</h2>
                  {p.appeals.map((d) => (
                    <article key={d.id}>
                      <strong>{interfaceCodeLabel(t, d.status)}</strong>
                      <p>{d.description}</p>
                      {d.resolutionNote && <p>{d.resolutionNote}</p>}
                      <time>{new Date(d.openedAt).toLocaleString(locale)}</time>
                    </article>
                  ))}
                  {p.recovery && (
                    <article>
                      <strong>
                        {t('Late-payment recovery')} · {interfaceCodeLabel(t, p.recovery.status)}
                      </strong>
                      <p>{p.recovery.description}</p>
                      {p.recovery.resolutionNote && <p>{p.recovery.resolutionNote}</p>}
                    </article>
                  )}
                </section>
              )}
            </section>
            <aside className="payment-panel p2p-chat">
              <h2>
                <MessageCircle size={20} />
                {t('Order conversation')}
              </h2>
              <p className="p2p-chat-hint">
                {t('Keep payment discussions here so support can review the complete record.')}
              </p>
              {(olderCursor === undefined ? p.nextCursor : olderCursor) && (
                <button disabled={loadingOlder} onClick={loadOlder}>
                  {t('Load older messages')}
                </button>
              )}
              {olderError && <p role="alert">{olderError}</p>}
              <div className="p2p-messages" aria-label={t('Order conversation')}>
                {!messages.length && <p>{t('No messages yet.')}</p>}
                {messages.map((m) => (
                  <article key={m.id} className="p2p-message" data-mine={m.mine}>
                    <header>
                      <strong>
                        {t(
                          m.role === 'member' ? 'Member' : m.role === 'agent' ? 'Agent' : 'Support'
                        )}
                      </strong>
                      <time>
                        {new Date(m.createdAt).toLocaleTimeString(locale, {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </time>
                    </header>
                    <p>{m.body}</p>
                    {m.attachment && (
                      <a href={m.attachment.url} target="_blank" rel="noreferrer">
                        <Paperclip size={14} />
                        {m.attachment.name}
                      </a>
                    )}
                  </article>
                ))}
              </div>
              {p.actions.message && (
                <form
                  className="p2p-composer"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void send();
                  }}
                >
                  <label>
                    {t('Message')}
                    <textarea
                      maxLength={4000}
                      value={draft}
                      disabled={action.busy}
                      onChange={(e) => setDraft(e.target.value)}
                    />
                  </label>
                  <label className="p2p-file">
                    <Paperclip size={16} />
                    {t('Attach receipt')}
                    <input
                      ref={fileInput}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      disabled={action.busy || fileBusy}
                      onChange={(e) => void readFile(e.target.files?.[0])}
                    />
                  </label>
                  <small>{t('Use a PNG, JPEG or WebP receipt up to 2 MB.')}</small>
                  {attachment && (
                    <p>
                      {attachment.name}{' '}
                      <button
                        type="button"
                        onClick={() => {
                          setAttachment(null);
                          if (fileInput.current) fileInput.current.value = '';
                        }}
                      >
                        {t('Remove')}
                      </button>
                    </p>
                  )}
                  {fileError && <p role="alert">{fileError}</p>}
                  <button
                    type="submit"
                    className="payment-primary"
                    disabled={blocked || fileBusy || (!draft.trim() && !attachment)}
                  >
                    {t('Send message')}
                  </button>
                </form>
              )}
            </aside>
          </div>
        </>
      )}
    </div>
  );
}

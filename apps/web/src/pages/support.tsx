import { requestStatus } from '@/lib/request-error';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowRight,
  Headphones,
  MessageCircle,
  Plus,
  Search,
  Send,
  Sparkles,
} from 'lucide-react';
import { api, unwrapData } from '@/lib/api';
import { boundedRequest } from '@/lib/bounded-request';
import { useAuth } from '@/providers/auth-provider';
import { useLanguage } from '@/providers/language-provider';
import './lounge.css';
import './support.css';
import { useLanguage as useInterfaceLanguage } from '@/providers/language-provider';

type Ticket = {
  id: string;
  subject: string;
  category: string;
  status: 'OPEN' | 'RESOLVED';
  last_sender: 'USER' | 'ADMIN';
  updated_at: string;
  username?: string;
};
type Message = { id: string; body: string; staff: boolean; created_at: string };
type Intent = { path: string; body: Record<string, unknown> };
const categories = [
  ['GENERAL', 'General'],
  ['ACCOUNT', 'Account'],
  ['PAYMENTS', 'Payments'],
  ['GAME', 'Game issue'],
] as const;
export function SupportPage({ admin = false }: { admin?: boolean }) {
  const { user } = useAuth();
  return user ? (
    <SupportSession key={`${user.id}:${admin}`} userId={user.id} admin={admin} />
  ) : null;
}
function SupportSession({ userId, admin }: { userId: string; admin: boolean }) {
  const { t: translateUi, locale: interfaceLocale } = useInterfaceLanguage();

  const { t, language } = useLanguage();
  const cache = useQueryClient();
  const [view, setView] = useState<'help' | 'requests'>(admin ? 'requests' : 'help');
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [category, setCategory] = useState('GENERAL');
  const [reply, setReply] = useState('');
  const [filter, setFilter] = useState(admin ? 'OPEN' : 'ALL');
  const [page, setPage] = useState(0);
  const [messagePage, setMessagePage] = useState(0);
  const [pending, setPending] = useState<Intent | null>(null);
  const [notice, setNotice] = useState('');
  const prefix = admin ? '/support/admin/tickets' : '/support/tickets';
  const key = ['support', userId, admin];
  const help = useQuery({
    queryKey: ['support-help', userId],
    queryFn: async ({ signal }) =>
      unwrapData(
        await boundedRequest(
          (requestSignal) =>
            api.get<{
              aiEnabled: boolean;
              articles: { id: string; title: string; body: string; href: string }[];
            }>('/support/help', undefined, { signal: requestSignal }),
          signal
        )
      ),
    staleTime: 60_000,
    retry: false,
  });
  const list = useQuery({
    queryKey: [...key, 'list', page, filter],
    queryFn: async () =>
      unwrapData(
        await api.get<{ tickets: Ticket[]; hasMore: boolean }>(
          `${prefix}?page=${page}&status=${filter}`
        )
      ),
    refetchInterval: 15000,
  });
  const thread = useQuery({
    queryKey: [...key, 'thread', selected, messagePage],
    enabled: !!selected,
    queryFn: async () =>
      unwrapData(
        await api.get<{ ticket: Ticket; messages: Message[]; hasMore: boolean }>(
          `${prefix}/${selected}?page=${messagePage}`
        )
      ),
    refetchInterval: 10000,
  });
  const mutation = useMutation({
    mutationFn: async (intent: Intent) =>
      unwrapData(await api.post<{ id?: string }>(intent.path, intent.body)),
    onSuccess: async (data, intent) => {
      setPending(null);
      setNotice('Saved.');
      if (intent.path === '/support/tickets') {
        setCreating(false);
        setSubject('');
        setBody('');
        setSelected(data.id ?? null);
        setView('requests');
        setPage(0);
        setFilter('ALL');
      }
      setReply('');
      setMessagePage(0);
      await cache.invalidateQueries({ queryKey: key });
    },
    onError: (error) => {
      const status = requestStatus(error);
      if (status >= 400 && status < 500 && status !== 408) {
        setPending(null);
        try {
          setNotice(
            JSON.parse((error as Error).message).message ||
              'This request was not accepted. Please check it and try again.'
          );
        } catch {
          setNotice('This request was not accepted. Please check it and try again.');
        }
      } else
        setNotice('Could not confirm this request. Retry to check it without sending a duplicate.');
    },
  });
  const send = (intent: Intent) => {
    if (pending) return;
    setNotice('');
    setPending(intent);
    mutation.mutate(intent);
  };
  const select = (id: string) => {
    if (pending) return;
    setSelected(id);
    setMessagePage(0);
    setReply('');
    setCreating(false);
    setNotice('');
  };
  const locked = !!pending;
  const item = thread.isError ? undefined : thread.data?.ticket;
  return (
    <div className="salem-lounge salem-support">
      <header className="salem-page-heading">
        <div>
          <span className="salem-eyebrow">{translateUi('HERE TO HELP')}</span>
          <h1>{admin ? translateUi('Support inbox') : t('Help center')}</h1>
          <p>
            {admin
              ? translateUi('Read requests, reply to members, and resolve issues.')
              : translateUi('Find an answer or talk to our team.')}
          </p>
        </div>
        <span className="salem-support-symbol">
          <Headphones size={27} />
        </span>
      </header>
      {!admin && (
        <nav className="salem-tabs" aria-label={translateUi('Support sections')}>
          <button aria-pressed={view === 'help'} onClick={() => setView('help')}>
            {t('Help center')}
          </button>
          <button aria-pressed={view === 'requests'} onClick={() => setView('requests')}>
            <MessageCircle size={15} />
            {t('Your requests')}
          </button>
          <button
            onClick={() => {
              setView('requests');
              setCreating(true);
              setSelected(null);
            }}
            disabled={locked}
          >
            <Plus size={15} />
            {t('Contact support')}
          </button>
        </nav>
      )}
      {view === 'help' && !admin ? (
        <>
          <HelpArticles data={help.data?.articles ?? []} loading={help.isPending} />
          <section className="salem-support-panel">
            <h2>
              <Sparkles size={20} />
              {help.data?.aiEnabled ? translateUi('AI assistant') : t('Help assistant')}
            </h2>
            {help.isError ? (
              <p role="alert">
                {translateUi('Help could not be loaded.')}{' '}
                <button onClick={() => void help.refetch()}>{t('Retry')}</button>
              </p>
            ) : help.data?.aiEnabled ? (
              <Assistant language={language} />
            ) : (
              <p>
                {translateUi(
                  'AI assistance is unavailable. Use the guides above or contact our team.'
                )}
              </p>
            )}
            <button
              className="salem-button secondary"
              onClick={() => {
                setView('requests');
                setCreating(true);
                setSelected(null);
              }}
            >
              {t('Contact support')}
              <ArrowRight size={16} />
            </button>
          </section>
          <p className="salem-footnote">
            {translateUi(
              'App text and game rules follow your selected language. Third-party games manage their own language options.'
            )}
          </p>
        </>
      ) : (
        <>
          {admin && (
            <p className="salem-footnote">
              {translateUi('AI assistant:')}{' '}
              {help.isPending
                ? translateUi('checking status…')
                : help.isError
                  ? translateUi('status unavailable. Check again when the connection is restored.')
                  : help.data?.aiEnabled
                    ? translateUi('configured')
                    : translateUi(
                        'not configured. Set the provider, model, and matching API key privately on the API service to enable it.'
                      )}
              {help.isError && (
                <button disabled={help.isFetching} onClick={() => help.refetch()}>
                  {translateUi('Check assistant status')}
                </button>
              )}
            </p>
          )}
          <div className={`salem-support-workspace ${selected || creating ? 'has-thread' : ''}`}>
            <aside className="salem-support-list">
              <div className="salem-support-list-title">
                <h2>{admin ? translateUi('Requests') : t('Your requests')}</h2>
                {!admin && (
                  <button
                    aria-label={t('New request')}
                    disabled={locked}
                    onClick={() => {
                      setCreating(true);
                      setSelected(null);
                    }}
                  >
                    <Plus size={20} />
                  </button>
                )}
              </div>
              <label className="salem-support-filter">
                <span className="sr-only">{translateUi('Request status')}</span>
                <select
                  value={filter}
                  disabled={locked}
                  onChange={(e) => {
                    setFilter(e.target.value);
                    setPage(0);
                  }}
                >
                  <option value="ALL">{translateUi('All requests')}</option>
                  <option value="OPEN">{t('Open')}</option>
                  <option value="RESOLVED">{t('Resolved')}</option>
                </select>
              </label>
              {list.isPending ? (
                <p role="status">{t('Loading…')}</p>
              ) : list.isError ? (
                <p role="alert">
                  {translateUi('Requests could not be loaded.')}{' '}
                  <button onClick={() => void list.refetch()}>{t('Retry')}</button>
                </p>
              ) : list.data?.tickets.length ? (
                <div>
                  {list.data.tickets.map((ticket) => (
                    <button
                      key={ticket.id}
                      disabled={locked}
                      aria-pressed={selected === ticket.id}
                      className="salem-ticket-row"
                      onClick={() => select(ticket.id)}
                    >
                      <span
                        className={`salem-ticket-status ${ticket.status === 'RESOLVED' ? 'resolved' : ''}`}
                      >
                        {ticket.status === 'RESOLVED'
                          ? t('Resolved')
                          : ticket.last_sender === 'ADMIN'
                            ? translateUi('Team replied')
                            : t('Open')}
                      </span>
                      <strong>{ticket.subject}</strong>
                      <small>
                        {admin && ticket.username ? `@${ticket.username} · ` : ''}
                        {new Date(ticket.updated_at).toLocaleDateString(interfaceLocale)}
                      </small>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="salem-support-list-empty">
                  <MessageCircle size={25} />
                  <p>{translateUi('No requests to show.')}</p>
                </div>
              )}
              <div className="salem-support-pagination">
                <button disabled={page === 0 || locked} onClick={() => setPage((p) => p - 1)}>
                  {translateUi('Previous')}
                </button>
                <span>{page + 1}</span>
                <button
                  disabled={!list.data?.hasMore || locked}
                  onClick={() => setPage((p) => p + 1)}
                >
                  {translateUi('Next')}
                </button>
              </div>
            </aside>
            <section className="salem-support-panel salem-support-thread">
              {(selected || creating) && (
                <button
                  className="salem-support-back"
                  disabled={locked}
                  onClick={() => {
                    setSelected(null);
                    setCreating(false);
                  }}
                >
                  <ArrowLeft size={15} />
                  {t('Your requests')}
                </button>
              )}
              {creating ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    send({
                      path: '/support/tickets',
                      body: {
                        subject: subject.trim(),
                        category,
                        body: body.trim(),
                        requestId: crypto.randomUUID(),
                      },
                    });
                  }}
                >
                  <h2>{t('New request')}</h2>
                  <p>
                    {translateUi(
                      'Describe what happened. Include an order or game reference if relevant.'
                    )}
                  </p>
                  <label>
                    {t('Category')}
                    <select
                      value={category}
                      onChange={(e) => setCategory(e.target.value)}
                      disabled={locked}
                    >
                      {categories.map(([value, label]) => (
                        <option key={value} value={value}>
                          {t(label)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    {t('Subject')}
                    <input
                      required
                      minLength={3}
                      maxLength={120}
                      value={subject}
                      onChange={(e) => setSubject(e.target.value)}
                      disabled={locked}
                    />
                  </label>
                  <label>
                    {t('Message')}
                    <textarea
                      required
                      maxLength={4000}
                      rows={6}
                      value={body}
                      onChange={(e) => setBody(e.target.value)}
                      disabled={locked}
                    />
                  </label>
                  <p className="salem-footnote">
                    {translateUi(
                      'Never include passwords, verification codes, private keys or seed phrases.'
                    )}
                  </p>
                  <button
                    className="salem-button"
                    disabled={locked || subject.trim().length < 3 || !body.trim()}
                  >
                    <Send size={15} />
                    {mutation.isPending ? t('Loading…') : t('Send')}
                  </button>
                </form>
              ) : selected ? (
                thread.isPending ? (
                  <p role="status">{t('Loading…')}</p>
                ) : thread.isError ? (
                  <p role="alert">
                    {translateUi('This request could not be opened.')}{' '}
                    <button onClick={() => void thread.refetch()}>{t('Retry')}</button>
                  </p>
                ) : (
                  item && (
                    <>
                      <div className="salem-thread-heading">
                        <div>
                          <h2>{item.subject}</h2>
                          <p>
                            {t(item.status === 'OPEN' ? 'Open' : 'Resolved')} ·{' '}
                            {t(
                              categories.find(([code]) => code === item.category)?.[1] ??
                                item.category
                            )}
                          </p>
                        </div>
                        <button
                          className="salem-button secondary"
                          disabled={locked}
                          onClick={() =>
                            send({
                              path: `${prefix}/${selected}/status`,
                              body: { status: item.status === 'OPEN' ? 'RESOLVED' : 'OPEN' },
                            })
                          }
                        >
                          {t(item.status === 'OPEN' ? 'Close request' : 'Reopen')}
                        </button>
                      </div>
                      <div className="salem-support-pagination">
                        <button
                          disabled={!thread.data?.hasMore}
                          onClick={() => setMessagePage((p) => p + 1)}
                        >
                          {translateUi('Earlier messages')}
                        </button>
                        {messagePage > 0 && (
                          <button onClick={() => setMessagePage((p) => p - 1)}>
                            {translateUi('Newer messages')}
                          </button>
                        )}
                      </div>
                      <ol
                        className="salem-support-messages"
                        aria-label={translateUi('Support conversation')}
                      >
                        {thread.data?.messages.map((message) => (
                          <li
                            key={message.id}
                            className={message.staff ? 'from-team' : 'from-member'}
                          >
                            <div>
                              <strong>
                                {message.staff
                                  ? t('Our team')
                                  : admin
                                    ? translateUi('Member')
                                    : translateUi('You')}
                              </strong>
                              <time dateTime={message.created_at}>
                                {new Date(message.created_at).toLocaleString(interfaceLocale)}
                              </time>
                            </div>
                            <p>{message.body}</p>
                          </li>
                        ))}
                      </ol>
                      {item.status === 'OPEN' ? (
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            send({
                              path: `${prefix}/${selected}/messages`,
                              body: { body: reply.trim(), requestId: crypto.randomUUID() },
                            });
                          }}
                        >
                          <label>
                            {t('Reply')}
                            <textarea
                              rows={3}
                              maxLength={4000}
                              required
                              value={reply}
                              disabled={locked}
                              onChange={(e) => setReply(e.target.value)}
                            />
                          </label>
                          <button className="salem-button" disabled={locked || !reply.trim()}>
                            <Send size={15} />
                            {t('Send')}
                          </button>
                        </form>
                      ) : (
                        <p>
                          {translateUi(
                            'This request is resolved. Reopen it if you still need help.'
                          )}
                        </p>
                      )}
                    </>
                  )
                )
              ) : (
                <div className="salem-support-welcome">
                  <Headphones size={40} />
                  <h2>{admin ? translateUi('Choose a request') : t('Contact support')}</h2>
                  <p>
                    {admin
                      ? translateUi('Select a member’s request to read and reply.')
                      : translateUi('Your messages and replies stay together here.')}
                  </p>
                  {!admin && (
                    <button className="salem-button" onClick={() => setCreating(true)}>
                      {t('New request')}
                      <Plus size={16} />
                    </button>
                  )}
                </div>
              )}
              {notice && (
                <p role={mutation.isError ? 'alert' : 'status'} className="salem-support-notice">
                  {translateUi(notice)}
                </p>
              )}
              {pending && mutation.isError && (
                <button className="salem-button" onClick={() => mutation.mutate(pending)}>
                  {t('Retry')}
                </button>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
function HelpArticles({
  data,
  loading,
}: {
  data: { id: string; title: string; body: string; href: string }[];
  loading: boolean;
}) {
  const { t: translateUi } = useInterfaceLanguage();

  const [search, setSearch] = useState('');
  const { t } = useLanguage();
  const articles = data.filter((a) =>
    `${t(a.title)} ${t(a.body)}`.toLowerCase().includes(search.toLowerCase())
  );
  return (
    <section>
      <label className="salem-search salem-help-search">
        <Search size={18} />
        <span className="sr-only">{t('Search help')}</span>
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('Search help')}
        />
      </label>
      {loading ? (
        <p role="status">{t('Loading…')}</p>
      ) : (
        <div className="salem-help-grid">
          {articles.map((article) => (
            <details key={article.id} className="salem-help-article">
              <summary>
                {t(article.title)}
                <Plus size={16} />
              </summary>
              <p>{t(article.body)}</p>
              <Link to={article.href}>
                {t('Continue')}
                <ArrowRight size={14} />
              </Link>
            </details>
          ))}
          {!articles.length && (
            <p>{translateUi('No matching guides. Contact our team for help.')}</p>
          )}
        </div>
      )}
    </section>
  );
}
function Assistant({ language }: { language: string }) {
  const { t: translateUi } = useInterfaceLanguage();

  const [question, setQuestion] = useState('');
  const { t } = useLanguage();
  const answer = useMutation({
    mutationFn: async () =>
      unwrapData(
        await api.post<{ answer: string }>('/support/assistant', {
          question: question.trim(),
          language,
        })
      ),
  });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        answer.mutate();
      }}
    >
      <label>
        {translateUi('Your question')}
        <textarea
          rows={3}
          value={question}
          maxLength={1500}
          disabled={answer.isPending}
          onChange={(e) => {
            setQuestion(e.target.value);
            answer.reset();
          }}
        />
      </label>
      <p className="salem-footnote">
        {translateUi(
          'AI-generated answers may be inaccurate. Your question is sent to our AI provider. Do not include passwords or payment secrets.'
        )}
      </p>
      <button className="salem-button" disabled={!question.trim() || answer.isPending}>
        {answer.isPending ? t('Loading…') : translateUi('Ask assistant')}
      </button>
      {answer.isError && (
        <p role="alert">
          {translateUi('The assistant could not respond. Try again or contact our team.')}
        </p>
      )}
      {answer.data && (
        <div className="salem-assistant-answer" role="status">
          {answer.data.answer}
        </div>
      )}
    </form>
  );
}

import {
  useInfiniteQuery,
  useQueryClient,
  useMutation,
  type InfiniteData,
} from '@tanstack/react-query';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import { invalidateProgressionQueries } from '@/lib/progression-cache';
import { useSocket } from '@/providers/socket-provider';
import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { ChatInbox } from '@/components/groups/chat-inbox';
import { GroupLifecycle, useGroupLifecycle } from '@/components/groups/group-lifecycle';
import { boundedRequest } from '@/lib/bounded-request';
import { requestStatus } from '@/lib/request-error';
import { GroupSocialNav } from '@/components/groups/group-social-nav';
import { VoiceMessagePlayer } from '@/components/voice/voice-message-player';
import { useVoiceRecorder } from '@/hooks/use-voice-recorder';
import { useAuth } from '@/providers/auth-provider';
import * as Dialog from '@radix-ui/react-dialog';
import { Gift, X, ArrowLeft, Reply, Send, Mic, MessageCircle, Trash2 } from 'lucide-react';
import type { GiftChatCard } from '@socialplay/shared';
import { GiftArt } from '@/components/gifts/gift-art';
import { GiftCollection } from '@/components/gifts/gift-collection';
import { MessageReactions } from '@/components/gifts/message-reactions';
import { useLanguage as useInterfaceLanguage } from '@/providers/language-provider';

/**
 * Shape this page renders from `GET /groups/:id/messages`. Typed (rather than
 * `any`) so the compiler rejects a second `.data` unwrap — the query below
 * already resolves to the array.
 */
interface ChatMessage {
  id: string;
  clientRequestId?: string | null;
  content: string;
  createdAt: string;
  isDeleted?: boolean;
  isEdited?: boolean;
  type?: string;
  replyTo?: {
    content: string;
    isDeleted?: boolean;
    sender?: { displayName?: string; username?: string };
  } | null;
  voiceMessage?: { duration?: number; mimeType?: string } | null;
  userId?: string;
  reactions?: { userId: string; type: string }[];
  gift?: GiftChatCard | null;
  sender?: { id?: string; displayName?: string | null; username?: string | null } | null;
}

export function MessagesPage() {
  const { groupId } = useParams<{ groupId: string }>();
  const { user } = useAuth();
  return <MessagesContent key={`${groupId}:${user?.id}`} userId={user?.id ?? ''} />;
}
function MessagesContent({ userId }: { userId: string }) {
  const { t: translateUi, locale: interfaceLocale } = useInterfaceLanguage();

  const [giftOpen, setGiftOpen] = useState(false);
  const [giftRecipient, setGiftRecipient] = useState<string | undefined>();
  const { groupId } = useParams<{ groupId: string }>();
  const navigate = useNavigate();
  const lifecycle = useGroupLifecycle(groupId);
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [sendNotice, setSendNotice] = useState('');
  const [moderating, setModerating] = useState<ChatMessage | null>(null);
  const pendingKey = `chat-pending:${userId}:${groupId}`;
  type PendingText = { content: string; clientRequestId: string; replyToId?: string };
  const [pendingText, setPendingText] = useState<PendingText | null>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(pendingKey) ?? 'null');
    } catch {
      return null;
    }
  });
  const pendingRef = useRef(pendingText);
  const remember = (value: PendingText | null) => {
    pendingRef.current = value;
    setPendingText(value);
    try {
      if (value) sessionStorage.setItem(pendingKey, JSON.stringify(value));
      else sessionStorage.removeItem(pendingKey);
    } catch {
      /* Keep the in-memory receipt if browser storage is unavailable. */
    }
  };
  const nearBottom = useRef(true);
  const viewportRef = useRef<HTMLDivElement>(null);
  const scrollAnchor = useRef<{ id: string; offset: number }[]>([]);
  const captureScrollAnchor = () => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const top = viewport.getBoundingClientRect().top;
    scrollAnchor.current = Array.from(viewport.querySelectorAll<HTMLElement>('[data-message-id]'))
      .filter((node) => node.getBoundingClientRect().bottom > top)
      .slice(0, 3)
      .map((node) => ({
        id: node.dataset.messageId!,
        offset: node.getBoundingClientRect().top - top,
      }));
  };
  const { socket } = useSocket();
  const queryClient = useQueryClient();
  const removeCachedMessage = useCallback(
    (id: string) => {
      queryClient.setQueryData<InfiniteData<ChatMessage[]>>(
        ['messages', groupId, userId],
        (current) =>
          current && {
            ...current,
            pages: current.pages.map((page) => page.filter((item) => item.id !== id)),
          }
      );
      setReplyTo((current) => (current?.id === id ? null : current));
    },
    [queryClient, groupId, userId]
  );
  const hideMessage = useMutation({
    mutationFn: async (id: string) => {
      try {
        await api.delete(`/groups/${groupId}/messages/${id}`);
      } catch (error) {
        // A lost success response can make a retry return "already hidden" (404).
        // The desired state is reached; refresh it rather than report a failure.
        if (requestStatus(error) !== 404) throw error;
      }
    },
    onSuccess: (_result, id) => {
      setModerating(null);
      removeCachedMessage(id);
      void queryClient.invalidateQueries({ queryKey: ['messages', groupId] });
      void queryClient.invalidateQueries({ queryKey: ['chat-inbox'] });
    },
  });
  const [message, setMessage] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const hasJoinedRoomRef = useRef(false);
  const [voiceDraft, setVoiceDraft] = useState<{ blob: Blob; duration: number } | null>(null);
  const [voiceNotice, setVoiceNotice] = useState('');
  const recorder = useVoiceRecorder((blob, durationMs) =>
    setVoiceDraft({ blob, duration: Math.max(1, Math.ceil(durationMs / 1000)) })
  );
  const voiceMutation = useMutation({
    mutationFn: async () => {
      if (!voiceDraft || !groupId) throw new Error('Record a message first');
      const form = new FormData();
      form.append('duration', String(voiceDraft.duration));
      form.append(
        'file',
        voiceDraft.blob,
        voiceDraft.blob.type.includes('ogg') ? 'voice.ogg' : 'voice.webm'
      );
      return api.upload(`/groups/${groupId}/voice-messages`, form);
    },
    onSuccess: () => {
      setVoiceDraft(null);
      setVoiceNotice('Voice message sent.');
      void queryClient.invalidateQueries({ queryKey: ['messages', groupId] });
    },
    onError: () =>
      setVoiceNotice('Voice message could not be confirmed. Check the chat before sending again.'),
  });

  // All loaded pages belong to the same account-scoped query. A reconnect,
  // edit, deletion or poll re-reads each page with freshly derived cursors;
  // keeping older rows in separate state would leave missed changes visible.
  const {
    data: history,
    isLoading,
    isError,
    isFetching,
    isFetchingNextPage,
    isFetchNextPageError,
    hasNextPage,
    fetchNextPage,
  } = useInfiniteQuery({
    queryKey: ['messages', groupId, userId],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }): Promise<ChatMessage[]> =>
      (
        await api.getGroupMessages(
          groupId!,
          { limit: 50, latest: true, before: pageParam },
          { signal }
        )
      ).data ?? [],
    getNextPageParam: (lastPage) => (lastPage.length === 50 ? lastPage[0].id : undefined),
    enabled: !!groupId && !!userId,
    refetchOnWindowFocus: true,
    refetchInterval: 10000,
  });

  const messages = Array.from(
    new Map(
      [...(history?.pages ?? [])]
        .reverse()
        .flat()
        .map((item) => [item.id, item])
    ).values()
  );
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || nearBottom.current) return;
    for (const anchor of scrollAnchor.current) {
      const node = Array.from(viewport.querySelectorAll<HTMLElement>('[data-message-id]')).find(
        (item) => item.dataset.messageId === anchor.id
      );
      if (!node) continue;
      viewport.scrollTop +=
        node.getBoundingClientRect().top - viewport.getBoundingClientRect().top - anchor.offset;
      break;
    }
    captureScrollAnchor();
  }, [history]);
  useEffect(() => {
    if (!history) return;
    setReplyTo((current) =>
      current ? (history.pages.flat().find((item) => item.id === current.id) ?? null) : null
    );
  }, [history]);

  // Join the Socket.IO group room when groupId changes
  const joinRoom = useCallback(() => {
    if (!socket || !groupId || hasJoinedRoomRef.current) return;
    socket.emit('group:join', { groupId }, (response: { success: boolean; error?: string }) => {
      if (response.success) {
        hasJoinedRoomRef.current = true;
      } else {
        console.warn('Failed to join group room:', response.error);
      }
    });
  }, [socket, groupId]);

  const leaveRoom = useCallback(() => {
    if (!socket || !groupId || !hasJoinedRoomRef.current) return;
    socket.emit('group:leave', { groupId });
    hasJoinedRoomRef.current = false;
  }, [socket, groupId]);

  // Handle socket reconnect - rejoin room
  useEffect(() => {
    if (!socket) return;
    const onConnect = () => {
      hasJoinedRoomRef.current = false;
      joinRoom();
      void queryClient.invalidateQueries({ queryKey: ['messages', groupId] });
    };
    socket.on('connect', onConnect);
    return () => {
      socket.off('connect', onConnect);
    };
  }, [socket, joinRoom, queryClient, groupId]);

  // Join/leave room when groupId changes
  useEffect(() => {
    if (!groupId) return;
    joinRoom();
    return () => {
      leaveRoom();
    };
  }, [groupId, joinRoom, leaveRoom]);

  // Listen for realtime message events and refetch authoritative state
  useEffect(() => {
    if (!socket || !groupId) return;
    const refresh = () => {
      // Refetch by invalidating — we don't trust the payload
      queryClient.invalidateQueries({ queryKey: ['messages', groupId] });
    };
    const refreshDeleted = (event: unknown) => {
      const id =
        event && typeof event === 'object' && 'messageId' in event ? event.messageId : undefined;
      if (typeof id === 'string' && id.length <= 128) {
        removeCachedMessage(id);
      }
      // Reconcile every loaded page using the authorized API, including
      // deletion events this connection may have missed.
      refresh();
    };
    socket.on('message:created', refresh);
    socket.on('message:updated', refresh);
    socket.on('message:deleted', refreshDeleted);
    socket.on('reaction:added', refresh);
    socket.on('reaction:removed', refresh);
    return () => {
      socket.off('message:created', refresh);
      socket.off('message:updated', refresh);
      socket.off('message:deleted', refreshDeleted);
      socket.off('reaction:added', refresh);
      socket.off('reaction:removed', refresh);
    };
  }, [socket, groupId, queryClient, removeCachedMessage]);

  const latestMessageId = messages.at(-1)?.id;
  useEffect(() => {
    if (nearBottom.current) messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [latestMessageId]);

  const sendMutation = useMutation({
    mutationFn: (body: PendingText) =>
      boundedRequest((signal) =>
        api.post(`/groups/${groupId}/messages`, body, undefined, { signal })
      ),
    onSuccess: (_result, body) => {
      if (pendingRef.current?.clientRequestId !== body.clientRequestId) return;
      remember(null);
      setMessage((current) => (current.trim() === body.content ? '' : current));
      setReplyTo(null);
      setSendNotice('');
      nearBottom.current = true;
      void queryClient.invalidateQueries({ queryKey: ['messages', groupId] });
      void queryClient.invalidateQueries({ queryKey: ['chat-inbox'] });
      invalidateProgressionQueries(queryClient);
    },
    onError: (error) => {
      const status = requestStatus(error);
      if (status >= 400 && status < 500 && status !== 408) {
        setMessage((current) => current || pendingRef.current?.content || '');
        remember(null);
        setSendNotice(
          'Message was not sent. Check your connection and whether the group is still open.'
        );
      } else
        setSendNotice('Delivery is not confirmed. Retry safely using the same message receipt.');
    },
  });
  useEffect(() => {
    const pending = pendingRef.current;
    if (
      pending &&
      history?.pages
        .flat()
        .some(
          (item) =>
            item.clientRequestId === pending.clientRequestId &&
            (item.sender?.id ?? item.userId) === userId
        )
    ) {
      remember(null);
      setMessage((current) => (current.trim() === pending.content ? '' : current));
      setSendNotice('Confirmed by the server.');
    }
  }, [history, userId]);
  const handleSend = () => {
    if (sendMutation.isPending || pendingRef.current || !message.trim() || !lifecycle.canWrite)
      return;
    const body = {
      content: message.trim(),
      clientRequestId: crypto.randomUUID(),
      ...(replyTo ? { replyToId: replyTo.id } : {}),
    };
    remember(body);
    sendMutation.mutate(body);
  };
  if (!groupId)
    return (
      <div className="qube-chat mx-auto grid h-[calc(100dvh-9rem)] min-h-[480px] max-w-6xl overflow-hidden rounded-3xl border border-slate-200 bg-slate-50 shadow-sm dark:border-slate-800 dark:bg-slate-900 md:grid-cols-[320px_1fr]">
        <ChatInbox />
        <div className="hidden flex-col items-center justify-center p-10 text-center md:flex">
          <div className="mb-5 rounded-3xl bg-emerald-100 p-5 text-emerald-800">
            <MessageCircle size={40} />
          </div>
          <h2 className="text-2xl font-bold">{translateUi('A place to connect')}</h2>
          <p className="mt-3 max-w-xs text-sm leading-6 text-slate-500">
            {translateUi(
              'Choose a conversation to chat, send a little appreciation, or get your next game together.'
            )}
          </p>
        </div>
      </div>
    );

  return (
    <div className="qube-chat mx-auto grid h-[calc(100dvh-8rem)] min-h-[560px] max-w-7xl overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-950 lg:grid-cols-[300px_1fr]">
      <div className="hidden min-h-0 border-r border-slate-200 dark:border-slate-800 lg:block">
        <ChatInbox selectedId={groupId} />
      </div>
      <section className="flex min-h-0 min-w-0 flex-col">
        <header className="space-y-3 border-b border-slate-100 px-4 py-4 dark:border-slate-800 sm:px-6">
          <div className="flex items-center gap-3">
            <button
              aria-label={translateUi('Back to chats')}
              className="rounded-full p-2 hover:bg-slate-100 dark:hover:bg-slate-800 lg:hidden"
              onClick={() => navigate('/messages')}
            >
              <ArrowLeft size={20} />
            </button>
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-emerald-100 font-bold text-emerald-800">
              {(lifecycle.data?.name ?? 'G').slice(0, 1).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-lg font-bold">
                {lifecycle.data?.name ?? translateUi('Group conversation')}
              </h1>
              <p className="text-xs text-slate-400">
                {translateUi('Chat, share a gift, play together')}
              </p>
            </div>
          </div>
          <GroupSocialNav groupId={groupId} />
          <GroupLifecycle groupId={groupId} />
        </header>
        <div
          ref={viewportRef}
          className="qube-chat-thread min-h-0 flex-1 overflow-y-auto bg-[#f3f6f4] px-4 py-5 dark:bg-[#111e1b] sm:px-6"
          onScroll={(event) => {
            const node = event.currentTarget;
            nearBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100;
            captureScrollAnchor();
          }}
        >
          {isLoading && (
            <p role="status" className="py-10 text-center text-sm text-slate-500">
              {translateUi('Loading conversation…')}
            </p>
          )}
          {isError && !isFetchNextPageError && (
            <p role="alert" className="rounded-2xl bg-white p-5 text-sm text-red-600">
              {translateUi('Failed to load messages. You may not be a member of this group.')}
            </p>
          )}
          {!isLoading && !isError && messages.length === 0 && (
            <div className="py-12 text-center">
              <MessageCircle size={30} className="mx-auto mb-3 text-emerald-700/40" />
              <p className="text-sm text-slate-500">
                {translateUi('No messages yet. Start the conversation!')}
              </p>
            </div>
          )}
          {isFetchNextPageError && (
            <p role="alert">{translateUi('Earlier messages could not be loaded. Try again.')}</p>
          )}
          {hasNextPage && (
            <button
              disabled={isFetching}
              onClick={() => {
                captureScrollAnchor();
                void fetchNextPage({ cancelRefetch: false });
              }}
              className="mx-auto mb-5 block rounded-full bg-white px-4 py-2 text-xs text-slate-500 shadow-sm dark:bg-slate-800"
            >
              {isFetchingNextPage ? translateUi('Loading…') : translateUi('Load earlier messages')}
            </button>
          )}
          <div className="space-y-3">
            {messages.map((msg, index) => {
              const own = (msg.sender?.id ?? msg.userId) === userId;
              const day = new Date(msg.createdAt).toLocaleDateString(interfaceLocale, {
                weekday: 'short',
                month: 'short',
                day: 'numeric',
              });
              const previous = messages[index - 1];
              const showDay =
                !previous ||
                new Date(previous.createdAt).toDateString() !==
                  new Date(msg.createdAt).toDateString();
              return (
                <div key={msg.id} data-message-id={msg.id}>
                  {showDay && (
                    <div className="my-5 text-center">
                      <span className="rounded-full bg-white/80 px-3 py-1.5 text-[10px] font-semibold text-slate-500 dark:bg-slate-800">
                        {day}
                      </span>
                    </div>
                  )}
                  <article className={`flex ${own ? 'justify-end' : 'justify-start'}`}>
                    <div
                      className={`qube-chat-bubble group max-w-[90%] rounded-2xl px-3.5 py-2.5 shadow-sm sm:max-w-[78%] ${own ? 'rounded-br-md bg-[#dff3e6] dark:bg-emerald-900' : 'rounded-bl-md bg-white dark:bg-slate-800'}`}
                    >
                      {!own && (
                        <p className="mb-1 text-xs font-bold text-emerald-700 dark:text-emerald-300">
                          {msg.sender?.displayName || msg.sender?.username || translateUi('Member')}
                        </p>
                      )}
                      {msg.replyTo && (
                        <div className="mb-2 rounded-lg border-l-2 border-emerald-500 bg-black/5 px-3 py-2 text-xs">
                          <p className="font-semibold text-emerald-700">
                            {msg.replyTo.sender?.displayName ||
                              msg.replyTo.sender?.username ||
                              translateUi('Reply')}
                          </p>
                          <p className="mt-1 line-clamp-2 text-slate-500">
                            {msg.replyTo.isDeleted
                              ? translateUi('Message deleted')
                              : msg.replyTo.content || translateUi('Attachment')}
                          </p>
                        </div>
                      )}
                      {msg.gift && !msg.isDeleted ? (
                        <div className="my-2 flex items-center gap-3 rounded-xl bg-violet-50 p-3 dark:bg-violet-950">
                          <GiftArt emoji={msg.gift.emoji} theme={msg.gift.theme} small />
                          <div>
                            <p className="text-[10px] font-bold uppercase tracking-widest text-violet-600">
                              {translateUi('Gift delivered')}
                            </p>
                            <h3 className="mt-1 font-bold">{msg.gift.name}</h3>
                            <p className="text-xs">
                              {translateUi('For @{recipientUsername}', {
                                recipientUsername: msg.gift.recipientUsername,
                              })}
                            </p>
                            <p className="mt-1 text-[10px] text-slate-400">
                              {translateUi('{faceValue} {value} gift · in their collection', {
                                faceValue: msg.gift.faceValue,
                                value:
                                  msg.gift.currency === 'PRACTICE_ETB'
                                    ? translateUi('practice ETB')
                                    : translateUi('point'),
                              })}
                            </p>
                          </div>
                        </div>
                      ) : msg.type?.toUpperCase() === 'VOICE' && !msg.isDeleted ? (
                        <VoiceMessagePlayer
                          groupId={groupId}
                          messageId={msg.id}
                          duration={msg.voiceMessage?.duration}
                        />
                      ) : (
                        <p className="whitespace-pre-wrap break-words text-[14px] leading-6 [overflow-wrap:anywhere]">
                          {msg.isDeleted ? translateUi('Message deleted') : msg.content}
                        </p>
                      )}
                      <div className="mt-1 flex items-center justify-end gap-1.5 text-[10px] text-slate-400">
                        {msg.isEdited && <span>{translateUi('edited')}</span>}
                        <time>
                          {new Date(msg.createdAt).toLocaleTimeString(interfaceLocale, {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </time>
                      </div>
                      {!msg.isDeleted && userId && (
                        <div className="mt-1 flex flex-wrap items-center gap-2">
                          <MessageReactions
                            groupId={groupId}
                            messageId={msg.id}
                            userId={userId}
                            reactions={msg.reactions}
                            compact
                            disabled={!lifecycle.canWrite}
                          />
                          {!lifecycle.query.isError &&
                            (lifecycle.data?.canModerate || (own && lifecycle.canWrite)) && (
                              <button
                                type="button"
                                aria-label={translateUi('Hide message')}
                                onClick={() => {
                                  hideMessage.reset();
                                  setModerating(msg);
                                }}
                                className="rounded-full p-1.5 text-slate-400 hover:text-red-600"
                              >
                                <Trash2 size={14} />
                              </button>
                            )}
                          {lifecycle.canWrite && (
                            <>
                              <button
                                aria-label={translateUi('Reply to message')}
                                className="rounded-full p-1.5 text-slate-400 hover:text-emerald-700"
                                onClick={() => setReplyTo(msg)}
                              >
                                <Reply size={14} />
                              </button>
                              {!own && (msg.sender?.id || msg.userId) && (
                                <button
                                  type="button"
                                  aria-label={translateUi('Send gift to {value}', {
                                    value: msg.sender?.username || translateUi('member'),
                                  })}
                                  className="rounded-full p-1.5 text-violet-500"
                                  onClick={() => {
                                    setGiftRecipient(msg.sender?.id || msg.userId);
                                    setGiftOpen(true);
                                  }}
                                >
                                  <Gift size={14} />
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </article>
                </div>
              );
            })}
            <div ref={messagesEndRef} />
          </div>
        </div>
        <footer className="space-y-2 border-t border-slate-100 bg-white p-3 dark:border-slate-800 dark:bg-slate-950 sm:p-4">
          {pendingText && !sendMutation.isPending && (
            <div className="flex items-center justify-between gap-3 rounded-xl bg-amber-50 p-3 text-xs text-amber-900">
              <p className="line-clamp-2">
                {translateUi('Unconfirmed: {content}', { content: pendingText.content })}
              </p>
              <Button size="sm" onClick={() => sendMutation.mutate(pendingText)}>
                {translateUi('Retry message')}
              </Button>
            </div>
          )}
          {lifecycle.closed ? (
            <p className="py-3 text-center text-sm text-slate-500">
              {translateUi(
                'This 24-hour room has closed. Your conversation, gifts and game results are saved.'
              )}
            </p>
          ) : (
            <>
              {replyTo && (
                <div className="flex items-center justify-between rounded-xl border-l-2 border-emerald-500 bg-slate-50 p-3 text-xs dark:bg-slate-900">
                  <p className="line-clamp-2">
                    {translateUi('Replying to {value}: {content}', {
                      value:
                        replyTo.sender?.displayName ||
                        replyTo.sender?.username ||
                        translateUi('message'),
                      content: replyTo.content,
                    })}
                  </p>
                  <button aria-label={translateUi('Cancel reply')} onClick={() => setReplyTo(null)}>
                    <X size={16} />
                  </button>
                </div>
              )}
              <div className="flex items-end gap-2">
                <button
                  type="button"
                  aria-label={translateUi('Open gifts')}
                  disabled={!lifecycle.canWrite}
                  className="rounded-xl p-3 text-violet-500 hover:bg-violet-50 disabled:opacity-40"
                  onClick={() => {
                    setGiftRecipient(undefined);
                    setGiftOpen(true);
                  }}
                >
                  <Gift size={21} />
                </button>
                <textarea
                  aria-label={translateUi('Message')}
                  rows={1}
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  placeholder={translateUi('Type a message…')}
                  maxLength={5000}
                  disabled={!lifecycle.canWrite}
                  onKeyDown={(event) => {
                    if (
                      event.key === 'Enter' &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      handleSend();
                    }
                  }}
                  className="max-h-32 min-h-[44px] w-full resize-y rounded-2xl border-0 bg-slate-100 px-4 py-3 text-sm focus:ring-2 focus:ring-emerald-500 disabled:opacity-50 dark:bg-slate-900"
                />
                <Button
                  aria-label={translateUi('Send')}
                  onClick={handleSend}
                  disabled={
                    !message.trim() ||
                    sendMutation.isPending ||
                    !!pendingText ||
                    !lifecycle.canWrite
                  }
                  className="qube-chat-send h-11 w-11 shrink-0 rounded-2xl bg-emerald-800 hover:bg-emerald-700"
                >
                  <Send size={18} />
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-2 px-2 text-xs text-slate-400">
                {recorder.isRecording ? (
                  <>
                    <span role="timer">
                      {translateUi('Recording {value}s', {
                        value: Math.floor(recorder.elapsedMs / 1000),
                      })}
                    </span>
                    <button
                      onClick={() => void recorder.stop()}
                      className="font-semibold text-red-600"
                    >
                      {translateUi('Stop recording')}
                    </button>
                    <button onClick={recorder.cancel}>{translateUi('Cancel')}</button>
                  </>
                ) : (
                  <button
                    className="inline-flex items-center gap-1.5 rounded-lg py-1 disabled:opacity-40"
                    disabled={
                      !lifecycle.canWrite ||
                      !recorder.isSupported ||
                      recorder.isStarting ||
                      voiceMutation.isPending ||
                      !!voiceDraft
                    }
                    onClick={() => void recorder.start()}
                  >
                    <Mic size={14} />
                    {recorder.isStarting
                      ? translateUi('Waiting for microphone…')
                      : translateUi('Record voice')}
                  </button>
                )}
                <span className="ml-auto hidden sm:inline">
                  {translateUi('Shift + Enter for a new line')}
                </span>
                {voiceDraft && (
                  <div className="flex w-full items-center gap-3 rounded-xl bg-slate-50 p-3 dark:bg-slate-900">
                    <span>
                      {translateUi('Voice message · {duration}s', {
                        duration: voiceDraft.duration,
                      })}
                    </span>
                    <button
                      className="font-semibold text-emerald-700"
                      disabled={!lifecycle.canWrite || voiceMutation.isPending}
                      onClick={() => voiceMutation.mutate()}
                    >
                      {translateUi('Send voice message')}
                    </button>
                    <button disabled={voiceMutation.isPending} onClick={() => setVoiceDraft(null)}>
                      {translateUi('Discard')}
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
          {(recorder.error || voiceNotice || sendNotice) && (
            <p role="status" className="px-2 text-xs text-amber-700">
              {translateUi(recorder.error || voiceNotice || sendNotice || '')}
            </p>
          )}
        </footer>
      </section>
      <Dialog.Root
        open={!!moderating}
        onOpenChange={(open) => {
          if (!open && !hideMessage.isPending) setModerating(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[60] bg-gray-950/40" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-[60] w-[calc(100%_-_2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-6 shadow-xl dark:bg-gray-900">
            <Dialog.Title className="font-semibold">
              {translateUi('Hide this message?')}
            </Dialog.Title>
            <Dialog.Description className="mt-2 text-sm text-slate-500">
              {translateUi(
                'It will be hidden from the conversation. Game results and gift ownership stay saved.'
              )}
            </Dialog.Description>
            {hideMessage.isError && (
              <p role="alert" className="mt-3 text-sm text-red-600">
                {translateUi('Could not hide the message. Check your permissions and try again.')}
              </p>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <Button
                variant="outline"
                disabled={hideMessage.isPending}
                onClick={() => setModerating(null)}
              >
                {translateUi('Cancel')}
              </Button>
              <Button
                disabled={hideMessage.isPending}
                onClick={() => moderating && hideMessage.mutate(moderating.id)}
              >
                {hideMessage.isPending ? translateUi('Hiding…') : translateUi('Hide for everyone')}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root open={giftOpen} onOpenChange={setGiftOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[60] bg-gray-950/40 backdrop-blur-sm" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-[60] max-h-[90vh] w-[calc(100%_-_2rem)] max-w-4xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-3xl bg-white p-6 shadow-2xl dark:bg-gray-900">
            <Dialog.Title className="sr-only">{translateUi('Send a gift in chat')}</Dialog.Title>
            <Dialog.Description className="sr-only">
              {translateUi('Choose a gift or send one from your collection to a group member.')}
            </Dialog.Description>
            <Dialog.Close
              aria-label={translateUi('Close gift shop')}
              className="absolute right-3 top-3 z-10 rounded-full bg-white p-2 dark:bg-gray-800"
            >
              <X size={18} />
            </Dialog.Close>
            <GiftCollection
              key={`${groupId}:${userId}:${giftRecipient ?? ''}`}
              groupId={groupId}
              userId={userId}
              initialRecipient={giftRecipient}
              fromChat
              groupClosed={lifecycle.closed}
            />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

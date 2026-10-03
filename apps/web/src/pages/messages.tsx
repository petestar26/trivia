import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import { invalidateProgressionQueries } from '@/lib/progression-cache';
import { useSocket } from '@/providers/socket-provider';
import { useEffect, useRef, useState, useCallback } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { GroupSocialNav } from '@/components/groups/group-social-nav';
import { VoiceMessagePlayer } from '@/components/voice/voice-message-player';
import { useVoiceRecorder } from '@/hooks/use-voice-recorder';
import { useAuth } from '@/providers/auth-provider';
import * as Dialog from '@radix-ui/react-dialog';
import { Gift, X } from 'lucide-react';
import type { GiftChatCard } from '@socialplay/shared';
import { GiftArt } from '@/components/gifts/gift-art';
import { GiftCollection } from '@/components/gifts/gift-collection';
import { MessageReactions } from '@/components/gifts/message-reactions';

/**
 * Shape this page renders from `GET /groups/:id/messages`. Typed (rather than
 * `any`) so the compiler rejects a second `.data` unwrap — the query below
 * already resolves to the array.
 */
interface ChatMessage {
  id: string;
  content: string;
  createdAt: string;
  isDeleted?: boolean;
  isEdited?: boolean;
  type?: string;
  voiceMessage?: { duration?: number; mimeType?: string } | null;
  userId?: string;
  reactions?: { userId: string; type: string }[];
  gift?: GiftChatCard | null;
  sender?: { id?: string; displayName?: string | null; username?: string | null } | null;
}

export function MessagesPage() {
  const { groupId } = useParams<{ groupId: string }>();
  const { user } = useAuth();
  return <MessagesContent key={`${groupId}:${user?.id}`} userId={user?.id ?? ''}/>;
}
function MessagesContent({ userId }: { userId: string }) {
  const [giftOpen, setGiftOpen] = useState(false);
  const [giftRecipient, setGiftRecipient] = useState<string | undefined>();
  const { groupId } = useParams<{ groupId: string }>();
  const navigate = useNavigate();
  const { socket } = useSocket();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const hasJoinedRoomRef = useRef(false);
  const [voiceDraft,setVoiceDraft]=useState<{blob:Blob;duration:number}|null>(null);
  const [voiceNotice,setVoiceNotice]=useState('');
  const recorder=useVoiceRecorder((blob,durationMs)=>setVoiceDraft({blob,duration:Math.max(1,Math.ceil(durationMs/1000))}));
  const voiceMutation=useMutation({mutationFn:async()=>{
    if(!voiceDraft||!groupId)throw new Error('Record a message first');
    const form=new FormData();form.append('duration',String(voiceDraft.duration));
    form.append('file',voiceDraft.blob,voiceDraft.blob.type.includes('ogg')?'voice.ogg':'voice.webm');
    return api.upload(`/groups/${groupId}/voice-messages`,form);
  },onSuccess:()=>{setVoiceDraft(null);setVoiceNotice('Voice message sent.');void queryClient.invalidateQueries({queryKey:['messages',groupId]});},
  onError:()=>setVoiceNotice('Voice message could not be confirmed. Check the chat before sending again.')});

  // Resolves directly to the array; the render path uses it as-is.
  const { data: messages = [], isLoading, isError } = useQuery<ChatMessage[]>({
    queryKey: ['messages', groupId, userId],
    queryFn: async () => (await api.getGroupMessages(groupId!, { limit: 50, latest: true })).data ?? [],
    enabled: !!groupId,
    refetchOnWindowFocus: true,
    refetchInterval: 10000,
  });

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
    socket.on('message:created', refresh);
    socket.on('message:updated', refresh);
    socket.on('message:deleted', refresh);
    socket.on('reaction:added', refresh);
    socket.on('reaction:removed', refresh);
    return () => {
      socket.off('message:created', refresh);
      socket.off('message:updated', refresh);
      socket.off('message:deleted', refresh);
      socket.off('reaction:added', refresh);
      socket.off('reaction:removed', refresh);
    };
  }, [socket, groupId, queryClient]);

  const latestMessageId = messages.at(-1)?.id;
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [latestMessageId]);

  // Declared above every conditional return below. Previously this sat after
  // the `!groupId` / `isLoading` / `isError` guards, so the loading render
  // skipped it and the loaded render called it — changing the hook count
  // between renders and crashing the page with React error #310
  // ("Rendered more hooks than during the previous render").
  const sendMutation = useMutation({
    mutationFn: (content: string) => {
      // The send controls only render once `groupId` exists, but the hook
      // itself must stay unconditional — so guard here instead.
      if (!groupId) throw new Error('Cannot send a message without a group');
      return api.post(`/groups/${groupId}/messages`, { content });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['messages', groupId] });
      // Sending a message may fire achievement/progression side effects.
      // Deliberately NOT called from the generic socket refresh handler for
      // other users' messages — only for this user's own successful send.
      invalidateProgressionQueries(queryClient);
    },
    onError: (err) => {
      // Error handling could be improved with toast
      console.error('Failed to send message:', err);
    },
  });

  const handleSend = () => {
    if (!message.trim()) return;
    sendMutation.mutate(message.trim(), {
      onSuccess: () => setMessage(''),
    });
  };

  if (!groupId) {
    return (
      <div className="max-w-2xl mx-auto p-4">
        <Card><CardContent className="py-8 text-center text-gray-500 dark:text-gray-400">Select a group from the Groups page to view messages.</CardContent></Card>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-4 border-primary-500 border-t-transparent" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="max-w-2xl mx-auto p-4">
        <Card><CardContent className="py-8 text-center text-red-600 dark:text-red-400">Failed to load messages. You may not be a member of this group.</CardContent></Card>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto p-4 space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={() => navigate('/groups')}>← Groups</Button>
        <h1 className="text-xl font-bold text-gray-900 dark:text-white">Messages</h1>
      </div>
      <GroupSocialNav groupId={groupId}/>

      <Card>
        <CardContent className="p-4">
          {messages.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-8">No messages yet. Start the conversation!</p>
          ) : (
            <div className="space-y-3 max-h-[60vh] overflow-y-auto">
              {messages.map((msg) => (
                <div key={msg.id} className={`flex flex-col ${msg.isDeleted ? 'opacity-40' : ''}`}>
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-semibold text-primary-600 dark:text-primary-400">
                      {msg.sender?.displayName || msg.sender?.username || 'Unknown'}
                    </span>
                    <span className="text-xs text-gray-400">{new Date(msg.createdAt).toLocaleTimeString()}</span>
                    {msg.isEdited && <span className="text-xs text-gray-400">(edited)</span>}
                  </div>
                  {msg.gift && !msg.isDeleted ? <div className="mt-2 flex max-w-sm items-center gap-4 rounded-2xl border border-violet-200 bg-violet-50 p-4 dark:border-violet-900 dark:bg-violet-950"><GiftArt emoji={msg.gift.emoji} theme={msg.gift.theme} small/><div><p className="text-xs font-semibold uppercase tracking-wide text-violet-600">Gift delivered</p><h3 className="mt-1 font-bold">{msg.gift.name}</h3><p className="text-sm">For @{msg.gift.recipientUsername}</p><p className="mt-1 text-xs text-gray-500">{msg.gift.faceValue} point gift · delivered to their collection</p></div></div> : msg.type?.toUpperCase()==='VOICE' && !msg.isDeleted ? <VoiceMessagePlayer groupId={groupId} messageId={msg.id} duration={msg.voiceMessage?.duration}/> : <p className="text-sm text-gray-700 dark:text-gray-300 mt-0.5">
                    {msg.isDeleted ? '[deleted]' : msg.content}
                  </p>}
                  {!msg.isDeleted && userId && <div className="flex flex-wrap items-end gap-3">
                    <MessageReactions groupId={groupId} messageId={msg.id} userId={userId} reactions={msg.reactions}/>
                    {(msg.sender?.id || msg.userId) && (msg.sender?.id || msg.userId) !== userId && <button type="button" className="mb-1 inline-flex items-center gap-1 text-xs font-medium text-violet-600" onClick={() => { setGiftRecipient(msg.sender?.id || msg.userId); setGiftOpen(true); }}><Gift size={14}/>Send gift</button>}
                  </div>}
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog.Root open={giftOpen} onOpenChange={setGiftOpen}>
        <Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-[60] bg-gray-950/40 backdrop-blur-sm"/>
          <Dialog.Content className="fixed left-1/2 top-1/2 z-[60] max-h-[90vh] w-[calc(100%_-_2rem)] max-w-4xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-3xl bg-white p-6 shadow-2xl dark:bg-gray-900">
            <Dialog.Title className="sr-only">Send a gift in chat</Dialog.Title><Dialog.Description className="sr-only">Choose a gift or send one from your collection to a group member.</Dialog.Description>
            <Dialog.Close aria-label="Close gift shop" className="absolute right-3 top-3 z-10 rounded-full bg-white p-2 dark:bg-gray-800"><X size={18}/></Dialog.Close>
            <GiftCollection key={`${groupId}:${userId}:${giftRecipient ?? ''}`} groupId={groupId} userId={userId} initialRecipient={giftRecipient} fromChat/>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      {/* Message input */}
      <div className="flex gap-2">
        <Button variant="outline" size="icon" aria-label="Open gifts" onClick={() => { setGiftRecipient(undefined); setGiftOpen(true); }}><Gift size={19}/></Button>
        <Input
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Type a message…"
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
          maxLength={5000}
        />
        <Button onClick={handleSend} disabled={!message.trim() || sendMutation.isPending}>
          {sendMutation.isPending ? 'Sending…' : 'Send'}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2 rounded-xl border p-3">
        {recorder.isRecording ? <><span role="timer">Recording {Math.floor(recorder.elapsedMs/1000)}s</span><Button onClick={()=>void recorder.stop()}>Stop recording</Button><Button variant="outline" onClick={recorder.cancel}>Cancel</Button></> : <Button variant="outline" disabled={!recorder.isSupported||recorder.isStarting||voiceMutation.isPending||!!voiceDraft} onClick={()=>void recorder.start()}>{recorder.isStarting?'Waiting for microphone…':'Record voice'}</Button>}
        {voiceDraft && <><span className="text-sm">Voice message · {voiceDraft.duration}s</span><Button disabled={voiceMutation.isPending} onClick={()=>voiceMutation.mutate()}>Send voice message</Button><Button variant="ghost" disabled={voiceMutation.isPending} onClick={()=>setVoiceDraft(null)}>Discard</Button></>}
        {(recorder.error||voiceNotice)&&<p role="status" className="w-full text-sm">{recorder.error||voiceNotice}</p>}
      </div>
    </div>
  );
}

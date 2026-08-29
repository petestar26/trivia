import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import { useSocket } from '@/providers/socket-provider';
import { useEffect, useRef, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export function MessagesPage() {
  const { groupId } = useParams<{ groupId: string }>();
  const navigate = useNavigate();
  const { socket } = useSocket();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const { data: msgData, isLoading, isError } = useQuery({
    queryKey: ['messages', groupId],
    queryFn: async () => (await api.getGroupMessages(groupId!, { limit: 50 })).data,
    enabled: !!groupId,
    refetchOnWindowFocus: true,
  });

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
    return () => {
      socket.off('message:created', refresh);
      socket.off('message:updated', refresh);
      socket.off('message:deleted', refresh);
    };
  }, [socket, groupId, queryClient]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [msgData?.data]);

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

  const messages = msgData?.data ?? [];

  const handleSend = async () => {
    if (!message.trim()) return;
    try {
      await api.post(`/groups/${groupId}/messages`, { content: message.trim() });
      setMessage('');
    } catch {
      // Error toast would go here
    }
  };

  return (
    <div className="max-w-2xl mx-auto p-4 space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={() => navigate('/groups')}>← Groups</Button>
        <h1 className="text-xl font-bold text-gray-900 dark:text-white">Messages</h1>
      </div>

      <Card>
        <CardContent className="p-4">
          {messages.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-8">No messages yet. Start the conversation!</p>
          ) : (
            <div className="space-y-3 max-h-[60vh] overflow-y-auto">
              {messages.map((msg: any) => (
                <div key={msg.id} className={`flex flex-col ${msg.isDeleted ? 'opacity-40' : ''}`}>
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-semibold text-primary-600 dark:text-primary-400">
                      {msg.user?.displayName || msg.user?.username || 'Unknown'}
                    </span>
                    <span className="text-xs text-gray-400">{new Date(msg.createdAt).toLocaleTimeString()}</span>
                    {msg.isEdited && <span className="text-xs text-gray-400">(edited)</span>}
                  </div>
                  <p className="text-sm text-gray-700 dark:text-gray-300 mt-0.5">
                    {msg.isDeleted ? '[deleted]' : msg.content}
                  </p>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>
          )}
        </CardContent>
      </Card>

      {/* Message input */}
      <div className="flex gap-2">
        <Input
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Type a message…"
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
          maxLength={5000}
        />
        <Button onClick={handleSend} disabled={!message.trim()}>Send</Button>
      </div>
    </div>
  );
}

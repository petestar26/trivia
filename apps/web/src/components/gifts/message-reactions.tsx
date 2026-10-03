import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CHAT_REACTIONS } from '@socialplay/shared';
import type { ChatReactionType } from '@socialplay/shared';
import { api } from '@/lib/api';
import { boundedRequest } from '@/lib/bounded-request';

export function MessageReactions({ groupId, messageId, userId, reactions = [] }: {
  groupId: string; messageId: string; userId: string; reactions?: { userId: string; type: string }[];
}) {
  const cache = useQueryClient(); const [error, setError] = useState('');
  const mutation = useMutation({
    mutationFn: ({ type, active }: { type: ChatReactionType; active: boolean }) => boundedRequest(() => active
      ? api.post(`/groups/${groupId}/messages/${messageId}/reactions`, { type })
      : api.delete(`/groups/${groupId}/messages/${messageId}/reactions/${type}`)),
    onSuccess: () => { setError(''); void cache.invalidateQueries({ queryKey: ['messages', groupId] }); },
    onError: () => { setError('Could not confirm your reaction. Refreshing…'); void cache.invalidateQueries({ queryKey: ['messages', groupId] }); },
  });
  return <div className="mt-2"><div role="group" aria-label="Message reactions" className="flex flex-wrap gap-1">
    {CHAT_REACTIONS.map(reaction => {
      const matching = reactions.filter(r => r.type === reaction.type); const mine = matching.some(r => r.userId === userId);
      return <button key={reaction.type} type="button" aria-label={reaction.label} aria-pressed={mine} title={`${reaction.label} · ${matching.length}`} disabled={mutation.isPending}
        onClick={() => mutation.mutate({ type: reaction.type, active: !mine })}
        className={`min-h-[32px] min-w-[38px] rounded-full border px-2 py-1 text-sm transition-colors disabled:opacity-50 ${mine ? 'border-violet-300 bg-violet-100 text-violet-900 dark:bg-violet-900 dark:text-violet-100' : 'border-gray-100 bg-gray-50 hover:border-violet-200 dark:border-gray-700 dark:bg-gray-800'}`}>
        <span aria-hidden="true">{reaction.emoji}</span>{matching.length > 0 && <span className="ml-1 text-xs tabular-nums">{matching.length}</span>}
      </button>;
    })}
  </div>{error && <p role="status" className="mt-1 text-xs text-gray-500">{error}</p>}</div>;
}

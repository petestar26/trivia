import { lazy, Suspense, useEffect, useState } from 'react';
import { MessageCircle, ChevronDown } from 'lucide-react';
import { useTogetherText } from '@/lib/i18n/together-text';
import './group-arena.css';
const Conversation = lazy(() =>
  import('@/pages/messages').then((m) => ({ default: m.GroupRoundChat }))
);
export function ArenaChat({ groupId, userId }: { groupId: string; userId: string }) {
  const { t } = useTogetherText();
  const [open, setOpen] = useState(
    () => window.matchMedia?.('(min-width: 1000px)').matches ?? false
  );
  useEffect(() => {
    const media = window.matchMedia?.('(min-width: 1000px)');
    const update = () => setOpen(media?.matches ?? false);
    media?.addEventListener('change', update);
    return () => media?.removeEventListener('change', update);
  }, []);
  return (
    <aside className={'tg-arena-chat ' + (open ? 'is-open' : '')} aria-label={t('Group chat')}>
      <button className="tg-arena-chat-heading" onClick={() => setOpen(!open)} aria-expanded={open}>
        <MessageCircle size={16} />
        <span>{t('Group chat')}</span>
        <ChevronDown size={14} />
      </button>
      <div className="tg-arena-chat-content" hidden={!open}>
        <Suspense fallback={<p>{t('Loading conversation…')}</p>}>
          <Conversation groupId={groupId} userId={userId} />
        </Suspense>
      </div>
    </aside>
  );
}

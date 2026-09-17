import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { api } from '@/lib/api';
import { NOTIFICATIONS_QUERY_KEY } from '@/lib/notifications-query-keys';
import { Button } from '@/components/ui/button';

interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string;
  isRead: boolean;
  createdAt: string;
}

interface NotificationsPage {
  items: NotificationItem[];
  unreadCount: number;
}

const PANEL_LIMIT = 20;

export function NotificationBell() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const notificationsQuery = useQuery<NotificationsPage>({
    queryKey: NOTIFICATIONS_QUERY_KEY,
    queryFn: async () => {
      const res = await api.listNotifications({ limit: PANEL_LIMIT });
      const meta = res.meta as { unreadCount?: number } | undefined;
      return {
        items: (res.data ?? []) as NotificationItem[],
        unreadCount: meta?.unreadCount ?? 0,
      };
    },
  });

  const items = notificationsQuery.data?.items ?? [];
  const unreadCount = notificationsQuery.data?.unreadCount ?? 0;

  const markReadMutation = useMutation({
    mutationFn: (id: string) => api.markNotificationRead(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_QUERY_KEY });
      setStatusMessage('Notification marked as read.');
    },
    onError: () => {
      setStatusMessage('Failed to mark notification as read.');
    },
  });

  const markAllReadMutation = useMutation({
    mutationFn: () => api.markAllNotificationsRead(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_QUERY_KEY });
      setStatusMessage('All notifications marked as read.');
    },
    onError: () => {
      setStatusMessage('Failed to mark all notifications as read.');
    },
  });

  // Close on outside click and on Escape (returning focus to the trigger,
  // per the standard disclosure-widget keyboard pattern) so the panel never
  // traps or strands keyboard/screen-reader users.
  useEffect(() => {
    if (!open) return;

    function handlePointerDown(e: MouseEvent) {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    }

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls="notification-panel"
        aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'}
        onClick={() => setOpen((o) => !o)}
        className="relative p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
      >
        <Bell className="h-5 w-5 text-gray-700 dark:text-gray-300" aria-hidden="true" />
        {unreadCount > 0 && (
          <span
            aria-hidden="true"
            className="absolute top-0.5 right-0.5 min-w-[1rem] h-4 px-1 rounded-full bg-red-600 text-white text-[10px] font-medium leading-4 text-center"
          >
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {/* Announces mark-read/mark-all-read/error outcomes without depending
          on the panel being visually open — screen readers hear the result
          even if focus never enters the panel. Loading itself is conveyed
          via aria-busy on the panel below (not duplicated here as text, or
          "Loading notifications…" would exist twice in the accessible tree —
          once here, once in the panel body — which is exactly the kind of
          ambiguity a screen reader's "find" gesture stumbles on too). */}
      <span role="status" aria-live="polite" className="sr-only">
        {statusMessage}
      </span>

      {open && (
        <div
          id="notification-panel"
          ref={panelRef}
          role="region"
          aria-label="Notifications"
          aria-busy={notificationsQuery.isLoading}
          className="absolute right-0 mt-2 w-80 max-h-96 overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg z-50"
        >
          <div className="flex items-center justify-between gap-2 p-3 border-b border-gray-200 dark:border-gray-700">
            <span className="text-sm font-semibold text-gray-900 dark:text-white">Notifications</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => markAllReadMutation.mutate()}
              disabled={markAllReadMutation.isPending || unreadCount === 0}
            >
              Mark all read
            </Button>
          </div>

          {notificationsQuery.isLoading ? (
            <p className="p-4 text-sm text-gray-500 dark:text-gray-400">Loading notifications…</p>
          ) : notificationsQuery.isError ? (
            <div role="alert" className="p-4 space-y-2">
              <p className="text-sm text-red-600 dark:text-red-400">Failed to load notifications.</p>
              <Button size="sm" variant="outline" onClick={() => notificationsQuery.refetch()}>
                Retry
              </Button>
            </div>
          ) : items.length === 0 ? (
            <p className="p-4 text-sm text-gray-500 dark:text-gray-400">You&apos;re all caught up.</p>
          ) : (
            <ul className="divide-y divide-gray-200 dark:divide-gray-700">
              {items.map((n) => (
                <li
                  key={n.id}
                  className={`p-3 ${!n.isRead ? 'bg-primary-50 dark:bg-primary-900/10' : ''}`}
                >
                  <p className="text-sm font-medium text-gray-900 dark:text-white">{n.title}</p>
                  <p className="text-xs text-gray-600 dark:text-gray-400 mt-0.5">{n.body}</p>
                  {!n.isRead && (
                    <button
                      type="button"
                      className="mt-1.5 text-xs font-medium text-primary-600 dark:text-primary-400 hover:underline disabled:opacity-50 disabled:no-underline"
                      onClick={() => markReadMutation.mutate(n.id)}
                      disabled={markReadMutation.isPending && markReadMutation.variables === n.id}
                    >
                      {markReadMutation.isPending && markReadMutation.variables === n.id ? 'Marking…' : 'Mark as read'}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

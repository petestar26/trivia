import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NotificationBell } from './notification-bell';

vi.mock('@/lib/api', () => ({
  api: {
    listNotifications: vi.fn(),
    markNotificationRead: vi.fn(),
    markAllNotificationsRead: vi.fn(),
  },
}));

import { api } from '@/lib/api';

const mocked = api as unknown as {
  listNotifications: ReturnType<typeof vi.fn>;
  markNotificationRead: ReturnType<typeof vi.fn>;
  markAllNotificationsRead: ReturnType<typeof vi.fn>;
};

function page(items: unknown[], unreadCount: number, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    success: true,
    data: items,
    meta: { page: 1, limit: 20, total: items.length, totalPages: 1, hasNextPage: false, hasPrevPage: false, unreadCount, ...overrides },
  };
}

function renderBell() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <NotificationBell />
    </QueryClientProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const UNREAD_A = { id: 'n1', type: 'GROUP_INVITE', title: 'Group invitation', body: 'You were invited', isRead: false, createdAt: '2024-01-01T00:00:00.000Z' };
const UNREAD_B = { id: 'n2', type: 'MODERATION', title: 'Banned from group', body: 'You were banned', isRead: false, createdAt: '2024-01-02T00:00:00.000Z' };
const READ_ONE = { id: 'n3', type: 'SYSTEM', title: 'Welcome', body: 'Thanks for joining', isRead: true, createdAt: '2024-01-03T00:00:00.000Z' };

describe('NotificationBell', () => {
  it('shows no badge and a plain "Notifications" label when there is nothing unread', async () => {
    mocked.listNotifications.mockResolvedValue(page([], 0));
    renderBell();

    const button = await screen.findByRole('button', { name: 'Notifications' });
    expect(button).toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('shows an unread badge and count in the accessible label', async () => {
    mocked.listNotifications.mockResolvedValue(page([UNREAD_A, UNREAD_B, READ_ONE], 2));
    renderBell();

    expect(await screen.findByRole('button', { name: 'Notifications, 2 unread' })).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('caps the visible badge at "9+" for large unread counts', async () => {
    mocked.listNotifications.mockResolvedValue(page([], 15));
    renderBell();

    expect(await screen.findByRole('button', { name: 'Notifications, 15 unread' })).toBeInTheDocument();
    expect(screen.getByText('9+')).toBeInTheDocument();
  });

  it('shows a loading state while the panel\'s data is in flight, then the list once it resolves', async () => {
    let resolvePage!: (v: unknown) => void;
    mocked.listNotifications.mockImplementation(() => new Promise((resolve) => { resolvePage = resolve; }));

    renderBell();
    const button = await screen.findByRole('button', { name: 'Notifications' });
    fireEvent.click(button);

    expect(await screen.findByText('Loading notifications…')).toBeInTheDocument();

    resolvePage(page([UNREAD_A], 1));

    expect(await screen.findByText('Group invitation')).toBeInTheDocument();
    expect(screen.queryByText('Loading notifications…')).not.toBeInTheDocument();
  });

  it('shows an empty state when there are no notifications', async () => {
    mocked.listNotifications.mockResolvedValue(page([], 0));
    renderBell();

    fireEvent.click(await screen.findByRole('button', { name: 'Notifications' }));

    expect(await screen.findByText("You're all caught up.")).toBeInTheDocument();
  });

  it('shows an accessible error state with a working Retry', async () => {
    mocked.listNotifications.mockRejectedValueOnce(new Error('network down'));
    renderBell();

    fireEvent.click(await screen.findByRole('button', { name: 'Notifications' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load notifications.');

    mocked.listNotifications.mockResolvedValueOnce(page([UNREAD_A], 1));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('Group invitation')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders both read and unread items, with "Mark as read" offered only for unread ones', async () => {
    mocked.listNotifications.mockResolvedValue(page([UNREAD_A, READ_ONE], 1));
    renderBell();

    fireEvent.click(await screen.findByRole('button', { name: 'Notifications, 1 unread' }));

    expect(await screen.findByText('Group invitation')).toBeInTheDocument();
    expect(screen.getByText('Welcome')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Mark as read' })).toHaveLength(1);
  });

  it('marking one notification read calls the API with its id and announces the result', async () => {
    mocked.listNotifications.mockResolvedValueOnce(page([UNREAD_A], 1));
    mocked.markNotificationRead.mockResolvedValue({ success: true, data: { ...UNREAD_A, isRead: true } });
    mocked.listNotifications.mockResolvedValueOnce(page([{ ...UNREAD_A, isRead: true }], 0));
    renderBell();

    fireEvent.click(await screen.findByRole('button', { name: 'Notifications, 1 unread' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Mark as read' }));

    await waitFor(() => expect(mocked.markNotificationRead).toHaveBeenCalledWith('n1'));
    expect(await screen.findByRole('status')).toHaveTextContent('Notification marked as read.');
    expect(await screen.findByRole('button', { name: 'Notifications' })).toBeInTheDocument();
  });

  it('"Mark all read" is disabled when nothing is unread', async () => {
    mocked.listNotifications.mockResolvedValueOnce(page([READ_ONE], 0));
    renderBell();
    fireEvent.click(await screen.findByRole('button', { name: 'Notifications' }));
    expect(await screen.findByRole('button', { name: 'Mark all read' })).toBeDisabled();
  });

  it('"Mark all read" calls the API and announces the result when there is something unread', async () => {
    mocked.listNotifications.mockResolvedValueOnce(page([UNREAD_A, READ_ONE], 1));
    mocked.markAllNotificationsRead.mockResolvedValue({ success: true, data: { updated: 1 } });
    mocked.listNotifications.mockResolvedValueOnce(page([{ ...UNREAD_A, isRead: true }, READ_ONE], 0));
    renderBell();

    fireEvent.click(await screen.findByRole('button', { name: 'Notifications, 1 unread' }));
    const markAll = await screen.findByRole('button', { name: 'Mark all read' });
    expect(markAll).toBeEnabled();
    fireEvent.click(markAll);

    await waitFor(() => expect(mocked.markAllNotificationsRead).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('status')).toHaveTextContent('All notifications marked as read.');
  });

  it('closes on Escape and returns focus to the bell button', async () => {
    const user = userEvent.setup();
    mocked.listNotifications.mockResolvedValue(page([UNREAD_A], 1));
    renderBell();

    const button = await screen.findByRole('button', { name: 'Notifications, 1 unread' });
    await user.click(button);
    expect(await screen.findByRole('region', { name: 'Notifications' })).toBeInTheDocument();

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('region', { name: 'Notifications' })).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });

  it('closes when clicking outside the panel', async () => {
    mocked.listNotifications.mockResolvedValue(page([UNREAD_A], 1));
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
        <div>
          <button>Outside</button>
          <NotificationBell />
        </div>
      </QueryClientProvider>
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Notifications, 1 unread' }));
    expect(await screen.findByRole('region', { name: 'Notifications' })).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole('button', { name: 'Outside' }));

    expect(screen.queryByRole('region', { name: 'Notifications' })).not.toBeInTheDocument();
  });

  it('toggles closed when the bell button is clicked again', async () => {
    mocked.listNotifications.mockResolvedValue(page([], 0));
    renderBell();

    const button = await screen.findByRole('button', { name: 'Notifications' });
    fireEvent.click(button);
    expect(await screen.findByRole('region', { name: 'Notifications' })).toBeInTheDocument();

    fireEvent.click(button);
    expect(screen.queryByRole('region', { name: 'Notifications' })).not.toBeInTheDocument();
  });

  it('sets aria-expanded to reflect the open state', async () => {
    mocked.listNotifications.mockResolvedValue(page([], 0));
    renderBell();

    const button = await screen.findByRole('button', { name: 'Notifications' });
    expect(button).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
  });
});

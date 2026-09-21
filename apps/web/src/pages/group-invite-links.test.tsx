import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreatedGroupInviteInfo, GroupInviteInfo } from '@socialplay/shared';
import { GroupDetailPage } from './group-detail';
import { Toaster } from '@/components/ui/toaster';
import { useToast } from '@/hooks/use-toast';
import { copyText } from '@/lib/clipboard';
import { inviteLink } from '@/lib/invite-link';

// Durable recovery of an invitation link.
//
// The link used to reach the manager only through a clipboard write and a
// six-second toast. If the clipboard was unavailable or refused, the toast was
// the only place the link ever appeared — and once it was dismissed the invite
// existed, unrecoverably, with nothing on the page to say so; the natural next
// move was to create it again. These use the REAL toast store and <Toaster />
// (unlike group-detail.test.tsx, which mocks the toast) so "dismiss the toast"
// is an actual dismissal.

vi.mock('@/providers/auth-provider', () => ({
  useAuth: () => ({ user: { id: 'u-owner', username: 'owner', displayName: 'Owner' }, isAuthenticated: true, isLoading: false }),
}));

vi.mock('@/lib/api', () => ({
  api: {
    getGroup: vi.fn(),
    getGroupMembers: vi.fn(),
    listGroupInvites: vi.fn(),
    listJoinRequests: vi.fn(),
    createGroupInvite: vi.fn(),
    revokeGroupInvite: vi.fn(),
  },
}));

import { api } from '@/lib/api';

const mocked = api as unknown as Record<
  'getGroup' | 'getGroupMembers' | 'listGroupInvites' | 'listJoinRequests' | 'createGroupInvite' | 'revokeGroupInvite',
  ReturnType<typeof vi.fn>
>;

const GROUP = {
  id: 'g-1',
  name: 'Private Group',
  description: null,
  imageUrl: null,
  coverUrl: null,
  isPrivate: true,
  status: 'ACTIVE',
  memberCount: 1,
  isMember: true,
  memberRole: 'OWNER',
  viewerMembershipStatus: 'ACTIVE',
  owner: { id: 'u-owner', username: 'owner', displayName: 'Owner', avatarUrl: null },
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

const invite = (n: number, overrides: Partial<GroupInviteInfo> = {}): GroupInviteInfo => ({
  id: `inv-${n}`,
  email: `person${n}@test.com`,
  role: 'MEMBER',
  status: 'PENDING',
  token: `tok-${n}`,
  expiresAt: '2030-01-01T00:00:00.000Z',
  invitedBy: 'u-owner',
  createdAt: `2024-01-0${n}T00:00:00.000Z`,
  ...overrides,
});

/** A tiny server: invites created through the API show up in later list calls, newest first. */
function installServer(initial: GroupInviteInfo[] = []) {
  const state = { invites: [...initial], creates: 0 };
  mocked.getGroup.mockResolvedValue({ success: true, data: GROUP });
  mocked.getGroupMembers.mockResolvedValue({ success: true, data: [] });
  mocked.listJoinRequests.mockResolvedValue({ success: true, data: [] });
  mocked.listGroupInvites.mockImplementation(async () => ({ success: true, data: [...state.invites] }));
  mocked.createGroupInvite.mockImplementation(async (_groupId: string, email: string) => {
    state.creates += 1;
    const created: CreatedGroupInviteInfo = { ...invite(100 + state.creates, { email, token: `tok-new-${state.creates}` }), groupId: 'g-1' };
    state.invites = [created, ...state.invites];
    return { success: true, data: created };
  });
  return state;
}

let toastProbe: ReturnType<typeof useToast> | null = null;
function ToastProbe() {
  toastProbe = useToast();
  return null;
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } } });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/groups/g-1']}>
          <Routes>
            <Route path="/groups/:id" element={<GroupDetailPage />} />
          </Routes>
        </MemoryRouter>
        <Toaster />
        <ToastProbe />
      </QueryClientProvider>
    ),
  };
}

function setClipboard(value: { writeText: (text: string) => Promise<void> } | undefined) {
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true });
}

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  // The toast store is module-global: leave it empty for the next test.
  act(() => {
    toastProbe?.toasts.forEach((t) => toastProbe?.dismiss(t.id));
  });
  cleanup();
  setClipboard(undefined);
  toastProbe = null;
});

async function createInvite(user: ReturnType<typeof userEvent.setup>, email = 'new@test.com') {
  await user.type(await screen.findByPlaceholderText('user@example.com'), email);
  await user.click(screen.getByRole('button', { name: 'Invite' }));
}

const linkField = (email: string) => screen.getByRole('textbox', { name: `Invitation link for ${email}` }) as HTMLInputElement;
const copyButton = (email: string) => screen.getByRole('button', { name: `Copy link for ${email}` });

describe('durable invite-link recovery', () => {
  it('every pending invite row exposes a selectable invitation URL and a Copy link action', async () => {
    installServer([invite(1), invite(2), invite(3)]);
    renderPage();
    await screen.findByText('Active invites (3)');

    for (const n of [1, 2, 3]) {
      const email = `person${n}@test.com`;
      expect(linkField(email).value).toBe(inviteLink(`tok-${n}`));
      expect(linkField(email)).toHaveAttribute('readonly');
      expect(copyButton(email)).toBeInTheDocument();
    }
    expect(screen.getAllByRole('button', { name: /^Copy link for / })).toHaveLength(3);
  });

  it('a row with no token offers no link at all — never a link to /groups/invite/undefined', async () => {
    installServer([{ ...invite(1), token: '' }]);
    renderPage();
    await screen.findByText('Active invites (1)');
    expect(screen.queryByRole('textbox', { name: /Invitation link/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Copy link/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeInTheDocument();
  });

  it('the link field is selectable: focusing it selects the whole URL', async () => {
    installServer([invite(1)]);
    renderPage();
    await screen.findByText('Active invites (1)');
    const field = linkField('person1@test.com');
    field.focus();
    fireEvent.focus(field);
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe(field.value.length);
  });

  describe('creating an invite', () => {
    it.each([
      ['the clipboard is unavailable', () => setClipboard(undefined)],
      ['the clipboard rejects the write', () => setClipboard({ writeText: vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError')) })],
    ])('succeeds and stays recoverable when %s — with exactly one create request', async (_label, arrange) => {
      const server = installServer();
      const user = userEvent.setup();
      arrange(); // after setup(): user-event installs its own clipboard stub
      renderPage();
      await createInvite(user);

      expect(await screen.findByText('Active invites (1)')).toBeInTheDocument();
      expect(linkField('new@test.com').value).toBe(inviteLink('tok-new-1'));
      expect(copyButton('new@test.com')).toBeInTheDocument();
      // The toast reports success and points at the list — it neither claims
      // the clipboard worked nor invites the manager to try again.
      const toast = await screen.findByText('Invite created');
      const toastText = toast.closest('[role]')?.textContent ?? toast.parentElement?.textContent ?? '';
      expect(toastText).toContain('listed under Active invites');
      expect(toastText).not.toMatch(/copied to your clipboard/i);
      expect(toastText.replace('Invite created', '')).not.toMatch(/try again|retry|create|invite again|resend/i);
      expect(server.creates).toBe(1);
      expect(mocked.createGroupInvite).toHaveBeenCalledTimes(1);
    });

    it('when the clipboard works the toast says so, and the invite is listed all the same', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      installServer();
      const user = userEvent.setup();
      setClipboard({ writeText });
      renderPage();
      await createInvite(user);

      await screen.findByText('Active invites (1)');
      expect(writeText).toHaveBeenCalledWith(inviteLink('tok-new-1'));
      expect(await screen.findByText(/copied to your clipboard/i)).toBeInTheDocument();
      expect(linkField('new@test.com').value).toBe(inviteLink('tok-new-1'));
      expect(mocked.createGroupInvite).toHaveBeenCalledTimes(1);
    });

    it('dismissing the toast does not lose the link', async () => {
      installServer();
      const user = userEvent.setup();
      setClipboard(undefined);
      renderPage();
      await createInvite(user);
      await screen.findByText('Invite created');

      fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));
      await waitFor(() => expect(screen.queryByText('Invite created')).not.toBeInTheDocument());

      // Still here, still the same URL, still selectable and copyable.
      expect(linkField('new@test.com').value).toBe(inviteLink('tok-new-1'));
      expect(copyButton('new@test.com')).toBeInTheDocument();
      expect(mocked.createGroupInvite).toHaveBeenCalledTimes(1);
    });

    it('the created invite is listed even if the refetch that follows it FAILS', async () => {
      installServer();
      const user = userEvent.setup();
      setClipboard(undefined);
      renderPage();
      await screen.findByPlaceholderText('user@example.com');
      mocked.listGroupInvites.mockRejectedValue(new Error('network down'));
      await createInvite(user);

      // The list is served from the create response, not from a refetch.
      expect(await screen.findByText('Active invites (1)')).toBeInTheDocument();
      await waitFor(() => expect(mocked.listGroupInvites.mock.calls.length).toBeGreaterThan(1));
      expect(linkField('new@test.com').value).toBe(inviteLink('tok-new-1'));
    });
  });

  describe('Copy link on an existing invite', () => {
    it('copies the link, confirms it accessibly, and never creates another invite', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      installServer([invite(1)]);
      const user = userEvent.setup();
      setClipboard({ writeText });
      renderPage();
      await screen.findByText('Active invites (1)');

      await user.click(copyButton('person1@test.com'));

      expect(writeText).toHaveBeenCalledWith(inviteLink('tok-1'));
      const row = copyButton('person1@test.com').closest('div.rounded-md') as HTMLElement;
      await waitFor(() => expect(within(row).getByRole('status')).toHaveTextContent('Invite link copied.'));
      expect(mocked.createGroupInvite).not.toHaveBeenCalled();
    });

    it('a rejected copy reports failure, selects the link for a manual copy, and creates nothing', async () => {
      installServer([invite(1)]);
      const user = userEvent.setup();
      setClipboard({ writeText: vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError')) });
      renderPage();
      await screen.findByText('Active invites (1)');

      await user.click(copyButton('person1@test.com'));

      const row = copyButton('person1@test.com').closest('div.rounded-md') as HTMLElement;
      await waitFor(() => expect(within(row).getByRole('status')).toHaveTextContent(/Couldn't copy the link/));
      const field = linkField('person1@test.com');
      expect(field).toHaveFocus();
      expect(field.selectionStart).toBe(0);
      expect(field.selectionEnd).toBe(field.value.length);
      expect(mocked.createGroupInvite).not.toHaveBeenCalled();
    });

    it('with no clipboard at all it says so, selects the link, and creates nothing', async () => {
      installServer([invite(1)]);
      const user = userEvent.setup();
      setClipboard(undefined);
      renderPage();
      await screen.findByText('Active invites (1)');

      await user.click(copyButton('person1@test.com'));

      const row = copyButton('person1@test.com').closest('div.rounded-md') as HTMLElement;
      await waitFor(() => expect(within(row).getByRole('status')).toHaveTextContent(/can't copy for you/));
      expect(linkField('person1@test.com')).toHaveFocus();
      expect(mocked.createGroupInvite).not.toHaveBeenCalled();
    });

    it('a copy that failed at creation time can be retried from the row and then succeeds', async () => {
      const server = installServer();
      const user = userEvent.setup();
      setClipboard(undefined);
      renderPage();
      await createInvite(user);
      await screen.findByText('Active invites (1)');

      const writeText = vi.fn().mockResolvedValue(undefined);
      setClipboard({ writeText });
      await user.click(copyButton('new@test.com'));

      expect(writeText).toHaveBeenCalledWith(inviteLink('tok-new-1'));
      const row = copyButton('new@test.com').closest('div.rounded-md') as HTMLElement;
      await waitFor(() => expect(within(row).getByRole('status')).toHaveTextContent('Invite link copied.'));
      expect(server.creates).toBe(1);
    });

    it('the outcome is announced each time, even when it is the same twice in a row', async () => {
      installServer([invite(1)]);
      const user = userEvent.setup();
      setClipboard({ writeText: vi.fn().mockResolvedValue(undefined) });
      renderPage();
      await screen.findByText('Active invites (1)');
      const row = copyButton('person1@test.com').closest('div.rounded-md') as HTMLElement;
      const region = within(row).getByRole('status');

      let mutations = 0;
      const observer = new MutationObserver((records) => {
        mutations += records.length;
      });
      observer.observe(region, { childList: true, characterData: true, subtree: true });

      await user.click(copyButton('person1@test.com'));
      await waitFor(() => expect(region).toHaveTextContent('Invite link copied.'));
      const afterFirst = mutations;
      await user.click(copyButton('person1@test.com'));
      await waitFor(() => expect(mutations).toBeGreaterThan(afterFirst));
      observer.disconnect();
      expect(region.textContent?.replace(/\u200B/g, '')).toBe('Invite link copied.');
    });

    it('only the row that was copied carries the message', async () => {
      installServer([invite(1), invite(2)]);
      const user = userEvent.setup();
      setClipboard({ writeText: vi.fn().mockResolvedValue(undefined) });
      renderPage();
      await screen.findByText('Active invites (2)');
      await user.click(copyButton('person2@test.com'));

      // Each ROW owns one status region; the list-level announcement regions are not rows.
      const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-invite-id] p[role="status"]'));
      expect(rows.map((r) => r.textContent?.replace(/\u200B/g, ''))).toEqual(['', 'Invite link copied.']);
    });
  });
});

describe('copyText', () => {
  afterEach(() => setClipboard(undefined));

  it("reports 'unavailable' when there is no async clipboard, without attempting anything", async () => {
    setClipboard(undefined);
    await expect(copyText('x')).resolves.toBe('unavailable');
  });

  it("reports 'failed' when the browser refuses, and 'copied' when it accepts — never throwing", async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error('no')) });
    await expect(copyText('x')).resolves.toBe('failed');
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    await expect(copyText('hello')).resolves.toBe('copied');
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('treats a clipboard object without writeText as unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: {}, configurable: true });
    await expect(copyText('x')).resolves.toBe('unavailable');
  });
});

describe('inviteLink', () => {
  it('builds the redemption URL on the current origin and encodes the token', () => {
    expect(inviteLink('abc123')).toBe(`${window.location.origin}/groups/invite/abc123`);
    expect(inviteLink('a/b c')).toBe(`${window.location.origin}/groups/invite/a%2Fb%20c`);
  });
});

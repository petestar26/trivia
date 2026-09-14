import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const listGroups = vi.fn();
const joinGroup = vi.fn();
const createGroup = vi.fn();
const toastMock = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    listGroups: (...a: unknown[]) => listGroups(...a),
    joinGroup: (...a: unknown[]) => joinGroup(...a),
    createGroup: (...a: unknown[]) => createGroup(...a),
  },
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: (...a: unknown[]) => toastMock(...a) }) }));

import { GroupsPage } from './groups';

afterEach(() => {
  cleanup();
  listGroups.mockReset();
  joinGroup.mockReset();
  createGroup.mockReset();
  toastMock.mockReset();
});

function renderPage(client: QueryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return render(<GroupsPage />, { wrapper });
}

describe('GroupsPage', () => {
  // Regression: `api.listGroups()` returns ApiResponse, so `.data` in the
  // queryFn already yields the array. The page then unwrapped `.data` a second
  // time off that array, which is always `undefined` — so every group list
  // rendered as "No groups found." regardless of what the API returned.
  it('renders groups returned by the API instead of the empty state', async () => {
    listGroups.mockResolvedValue({
      success: true,
      data: [
        {
          id: 'group-1',
          name: 'Smoke Group',
          description: 'Disposable staging smoke-test group',
          memberCount: 1,
          isMember: true,
          memberRole: 'OWNER',
          isPrivate: false,
        },
      ],
    });

    renderPage();

    expect(await screen.findByText('Smoke Group')).toBeInTheDocument();
    expect(screen.queryByText('No groups found.')).not.toBeInTheDocument();
    // A group the user already belongs to offers Open (not Join).
    expect(screen.getByRole('button', { name: 'Open' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Join' })).not.toBeInTheDocument();
    expect(screen.getByText(/1 member/)).toBeInTheDocument();
  });

  it('offers Join for a public group the user is not a member of', async () => {
    listGroups.mockResolvedValue({
      success: true,
      data: [{ id: 'group-2', name: 'Open Group', memberCount: 4, isMember: false, isPrivate: false }],
    });

    renderPage();

    expect(await screen.findByText('Open Group')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Join' })).toBeInTheDocument();
  });

  it('still shows the empty state when the API genuinely returns no groups', async () => {
    listGroups.mockResolvedValue({ success: true, data: [] });

    renderPage();

    expect(await screen.findByText('No groups found.')).toBeInTheDocument();
  });
});

describe('GroupsPage — join progression invalidation', () => {
  const OPEN_GROUP = { id: 'group-2', name: 'Open Group', memberCount: 4, isMember: false, isPrivate: false };

  it('invalidates progression caches on successful join, preserving the groups refresh', async () => {
    listGroups.mockResolvedValue({ success: true, data: [OPEN_GROUP] });
    joinGroup.mockResolvedValue({ success: true });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    renderPage(client);

    const joinButton = await screen.findByRole('button', { name: 'Join' });
    fireEvent.click(joinButton);

    await waitFor(() => expect(joinGroup).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['groups'] }))
    );
    // invalidateProgressionQueries effects.
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['achievements'] }))
    );
    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['progress'] }));
    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['tasks'] }));
    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['wallet'] }));
    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['wallet-transactions'] }));
    expect(toastMock).toHaveBeenCalledWith({ title: 'Joined group' });
  });

  it('does NOT invalidate progression caches when the join fails', async () => {
    listGroups.mockResolvedValue({ success: true, data: [OPEN_GROUP] });
    joinGroup.mockRejectedValue(new Error(JSON.stringify({ status: 500, message: 'boom' })));

    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    renderPage(client);

    const joinButton = await screen.findByRole('button', { name: 'Join' });
    fireEvent.click(joinButton);

    await waitFor(() => expect(joinGroup).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith({ title: 'Error', description: 'boom', variant: 'destructive' })
    );

    // Neither the groups refresh nor any progression surface is invalidated.
    expect(invalidateSpy).not.toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['groups'] }));
    expect(invalidateSpy).not.toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['achievements'] }));
    expect(invalidateSpy).not.toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['progress'] }));
    expect(invalidateSpy).not.toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['tasks'] }));
    expect(invalidateSpy).not.toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['wallet'] }));
    expect(invalidateSpy).not.toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['wallet-transactions'] }));
  });
});

describe('GroupsPage — self-service group creation', () => {
  it('shows the Create group CTA in the empty state', async () => {
    listGroups.mockResolvedValue({ success: true, data: [] });

    renderPage();

    expect(await screen.findByText('No groups found.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create your first group' })).toBeInTheDocument();
    // The header CTA is also present — two independent entry points to the same form.
    expect(screen.getByRole('button', { name: 'Create group' })).toBeInTheDocument();
  });

  it('submits a minimal payload, resets/closes the form, invalidates both group-list caches, and makes the new group visible', async () => {
    // Simulates the server-side effect of creation: the very next listGroups
    // call (post-invalidation refetch) includes the new group.
    let created = false;
    listGroups.mockImplementation(async () => ({
      success: true,
      data: created
        ? [{ id: 'group-new', name: 'Book Club', memberCount: 1, isMember: true, isPrivate: false, memberRole: 'OWNER' }]
        : [],
    }));
    createGroup.mockImplementation(async () => {
      created = true;
      return { success: true, data: { id: 'group-new', name: 'Book Club' } };
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    renderPage(client);

    await screen.findByText('No groups found.');
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }));

    await userEvent.type(screen.getByLabelText('Name'), 'Book Club');
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }));

    await waitFor(() => expect(createGroup).toHaveBeenCalledTimes(1));
    expect(createGroup).toHaveBeenCalledWith({ name: 'Book Club', description: undefined, isPrivate: false });

    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['groups'] })),
    );
    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['groups-for-competitions'] }));
    expect(toastMock).toHaveBeenCalledWith({ title: 'Group created' });

    // Form reset/closed.
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
    // New group now visible via the post-invalidation refetch.
    expect(await screen.findByText('Book Club')).toBeInTheDocument();
    expect(screen.queryByText('No groups found.')).not.toBeInTheDocument();
  });

  it('submits an optional description and a private flag', async () => {
    listGroups.mockResolvedValue({ success: true, data: [] });
    createGroup.mockResolvedValue({ success: true, data: { id: 'group-new', name: 'Secret Club' } });

    renderPage();
    await screen.findByText('No groups found.');
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }));

    await userEvent.type(screen.getByLabelText('Name'), 'Secret Club');
    await userEvent.type(screen.getByLabelText(/Description/), 'Members only');
    fireEvent.click(screen.getByLabelText('Private group'));
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }));

    await waitFor(() => expect(createGroup).toHaveBeenCalledTimes(1));
    expect(createGroup).toHaveBeenCalledWith({
      name: 'Secret Club',
      description: 'Members only',
      isPrivate: true,
    });
  });

  it('rejects a name shorter than 2 characters without calling the API', async () => {
    listGroups.mockResolvedValue({ success: true, data: [] });

    renderPage();
    await screen.findByText('No groups found.');
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }));

    await userEvent.type(screen.getByLabelText('Name'), 'A');
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }));

    expect(await screen.findByText('Group name must be between 2 and 100 characters.')).toBeInTheDocument();
    expect(createGroup).not.toHaveBeenCalled();
  });

  it('rejects a blank name without calling the API', async () => {
    listGroups.mockResolvedValue({ success: true, data: [] });

    renderPage();
    await screen.findByText('No groups found.');
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }));

    fireEvent.click(screen.getByRole('button', { name: 'Create group' }));

    expect(await screen.findByText('Group name must be between 2 and 100 characters.')).toBeInTheDocument();
    expect(createGroup).not.toHaveBeenCalled();
  });

  it('displays the server error and keeps the form open with entered values on failure', async () => {
    listGroups.mockResolvedValue({ success: true, data: [] });
    createGroup.mockRejectedValue(
      new Error(JSON.stringify({ status: 409, message: 'A group with this name already exists' })),
    );

    renderPage();
    await screen.findByText('No groups found.');
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }));

    await userEvent.type(screen.getByLabelText('Name'), 'Duplicate Name');
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }));

    expect(await screen.findByText('A group with this name already exists')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Duplicate Name');
    expect(screen.queryByText('No groups found.')).toBeInTheDocument();
  });

  it('disables the submit button while a request is in flight, preventing duplicate submission', async () => {
    listGroups.mockResolvedValue({ success: true, data: [] });
    let resolveCreate!: (value: { success: true; data: { id: string; name: string } }) => void;
    createGroup.mockImplementation(
      () => new Promise((resolve) => { resolveCreate = resolve; }),
    );

    renderPage();
    await screen.findByText('No groups found.');
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }));

    await userEvent.type(screen.getByLabelText('Name'), 'Slow Group');
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }));

    await waitFor(() => expect(createGroup).toHaveBeenCalledTimes(1));
    const pendingButton = screen.getByRole('button', { name: 'Creating…' });
    expect(pendingButton).toBeDisabled();
    fireEvent.click(pendingButton);
    expect(createGroup).toHaveBeenCalledTimes(1);

    resolveCreate({ success: true, data: { id: 'group-slow', name: 'Slow Group' } });
    await waitFor(() => expect(screen.queryByLabelText('Name')).not.toBeInTheDocument());
    expect(createGroup).toHaveBeenCalledTimes(1);
  });

  it('Cancel closes the form without calling the API', async () => {
    listGroups.mockResolvedValue({ success: true, data: [] });

    renderPage();
    await screen.findByText('No groups found.');
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }));

    await userEvent.type(screen.getByLabelText('Name'), 'Abandoned Group');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
    expect(createGroup).not.toHaveBeenCalled();
  });

  it('a same-tick duplicate form submission produces exactly one request', async () => {
    listGroups.mockResolvedValue({ success: true, data: [] });
    createGroup.mockImplementation(() => new Promise(() => {})); // never resolves

    renderPage();
    await screen.findByText('No groups found.');
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }));

    await userEvent.type(screen.getByLabelText('Name'), 'Race Group');

    // Dispatch the submit event directly, twice, rather than clicking the
    // submit button once and relying on its `disabled` attribute — this
    // exercises the `if (createMutation.isPending) return;` guard itself,
    // which a click-only test can never reach a second time.
    const form = screen.getByRole('form', { name: 'Create group' });
    fireEvent.submit(form);
    fireEvent.submit(form);

    await waitFor(() => expect(createGroup).toHaveBeenCalledTimes(1));
  });

  it('shows a generic message and preserves entered values on a network failure', async () => {
    listGroups.mockResolvedValue({ success: true, data: [] });
    // A network failure or CORS/offline error never reaches JSON.parse —
    // not the JSON-error-body path covered above.
    createGroup.mockRejectedValue(new TypeError('Failed to fetch'));

    renderPage();
    await screen.findByText('No groups found.');
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }));

    await userEvent.type(screen.getByLabelText('Name'), 'Offline Group');
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }));

    expect(await screen.findByText('Failed to create group')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Offline Group');
  });

  it('exposes aria-expanded/aria-controls on the toggle, stays mounted while open, and moves focus on open/Cancel', async () => {
    listGroups.mockResolvedValue({ success: true, data: [] });

    renderPage();

    const toggle = await screen.findByRole('button', { name: 'Create group' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-controls', 'create-group-form');

    fireEvent.click(toggle);

    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveFocus());
    // Proves the toggle was hidden, not unmounted: the exact same node
    // reference is still attached to the document.
    expect(document.body.contains(toggle)).toBe(true);
    expect(toggle).toHaveAttribute('hidden');
    // The `hidden` attribute alone loses the cascade to Button's own
    // `inline-flex` base class in the real built stylesheet (confirmed by
    // rendering the actual production CSS: `inline-flex` computed as the
    // element's `display`, leaving it visible and focusable). The `hidden`
    // utility class is what actually removes it from layout.
    expect(toggle).toHaveClass('hidden');
    expect(toggle).not.toHaveClass('inline-flex');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(toggle).toHaveFocus());
    expect(toggle).not.toHaveAttribute('hidden');
    expect(toggle).not.toHaveClass('hidden');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('restores focus to the toggle after a successful group creation', async () => {
    listGroups.mockResolvedValue({ success: true, data: [] });
    createGroup.mockResolvedValue({ success: true, data: { id: 'group-new', name: 'Focus Group' } });

    renderPage();

    const toggle = await screen.findByRole('button', { name: 'Create group' });
    fireEvent.click(toggle);

    await userEvent.type(screen.getByLabelText('Name'), 'Focus Group');
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }));

    await waitFor(() => expect(screen.queryByLabelText('Name')).not.toBeInTheDocument());
    await waitFor(() => expect(toggle).toHaveFocus());
    expect(toggle).not.toHaveAttribute('hidden');
  });

  it('associates a validation error with its field via aria-invalid and aria-describedby', async () => {
    listGroups.mockResolvedValue({ success: true, data: [] });

    renderPage();
    await screen.findByText('No groups found.');
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }));

    const nameInput = screen.getByLabelText('Name');
    // Blank name -> "must be between 2 and 100 characters" is field-specific.
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }));

    const alert = await screen.findByText('Group name must be between 2 and 100 characters.');
    expect(alert).toHaveAttribute('id', 'create-group-error');
    expect(nameInput).toHaveAttribute('aria-invalid', 'true');
    expect(nameInput).toHaveAttribute('aria-describedby', 'create-group-error');
  });
});

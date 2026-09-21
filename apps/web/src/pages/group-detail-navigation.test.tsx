import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import {
  A,
  ACTIONS,
  API_FUNCTIONS,
  deferred,
  fetchesOfB,
  idle,
  installApi,
  invalidatedSince,
  isInert,
  newWorld,
  addMember,
  OTHER,
  onGroup,
  primeBoth,
  refusal,
  renderRouted,
  snapshotB,
  type MockedApi,
} from './group-detail-actions.harness';

// EVERY group-scoped action on the group page, driven through the real router
// and a real QueryClient with BOTH groups already cached.
//
// `/groups/:id` renders the same GroupDetailPage element for every group, so a
// move from A to B does not unmount it. Anything the page held for A — an open
// confirmation and the member it names, an unsent invitation, a pending
// request — used to come along, and the next click applied A's target to B
// (`banGroupMember("g-b", <the user chosen in A>)`); and a late answer from A
// invalidated, patched and announced against B. The same member, the same join
// request and the same invitation id exist in BOTH groups here, so any such
// mistake is observable rather than a 404.
//
// The page is keyed by group (the boundary), and every request, callback, cache
// write and toast reads the group of the action that was initiated. This file
// exercises the boundary and the shared pending guard; the second layer, on its
// own, is in group-detail-captured-identity.test.tsx.

vi.mock('@/providers/auth-provider', () => ({
  useAuth: () => ({
    user: { id: 'u-viewer', username: 'viewer', displayName: 'Viewer' },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

vi.mock('@/lib/api', () => ({
  api: {
    getGroup: vi.fn(),
    getGroupMembers: vi.fn(),
    listGroupInvites: vi.fn(),
    listJoinRequests: vi.fn(),
    listBannedMembers: vi.fn(),
    unbanGroupMember: vi.fn(),
    banGroupMember: vi.fn(),
    removeGroupMember: vi.fn(),
    changeMemberRole: vi.fn(),
    approveJoinRequest: vi.fn(),
    rejectJoinRequest: vi.fn(),
    createGroupInvite: vi.fn(),
    revokeGroupInvite: vi.fn(),
    transferOwnership: vi.fn(),
    leaveGroup: vi.fn(),
    joinGroup: vi.fn(),
    requestJoinGroup: vi.fn(),
  },
}));

const toastMock = vi.fn();
vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: (...args: unknown[]) => toastMock(...args) }),
}));

import { api } from '@/lib/api';

const mocked = api as unknown as MockedApi;
void API_FUNCTIONS;

beforeEach(() => {
  cleanup();
  vi.resetAllMocks();
  toastMock.mockReset();
});

const NAMES = { a: 'Group A', b: 'Group B' };

/** Render both groups cached, with the world adjusted for `spec`; ends on A. */
async function start(spec: (typeof ACTIONS)[number]) {
  const world = newWorld();
  spec.setup?.(world);
  installApi(mocked, world);
  const r = renderRouted();
  await primeBoth(r, { a: NAMES.a, b: NAMES.b });
  mocked[spec.api].mockClear();
  toastMock.mockClear();
  return { world, ...r };
}

describe.each(ACTIONS)('$label', (spec) => {
  it('a late SUCCESS from A changes only A: its request, its caches, its keys, its toast — and leaves B, and the focus in B, alone', async () => {
    const { client, invalidate, goTo } = await start(spec);
    const request = deferred();
    mocked[spec.api].mockImplementation(() => request.promise);

    await spec.start();
    await waitFor(() => expect(mocked[spec.api]).toHaveBeenCalledTimes(1));
    // The request is A's, for A's target, with A's payload.
    expect(mocked[spec.api]).toHaveBeenCalledWith(...spec.args);

    goTo('B');
    await onGroup(NAMES.b);
    await waitFor(() => spec.counterpart());
    await idle(client);
    // B is not made inert by A's request, and the user is working in B.
    expect(isInert(spec.counterpart())).toBe(false);
    const bControl = spec.counterpart();
    bControl.focus();
    expect(bControl).toHaveFocus();
    const bBefore = snapshotB(client);
    const bFetches = fetchesOfB(mocked);
    const invalidationsBefore = invalidate.mock.calls.length;

    request.resolve(spec.result ?? { success: true, data: { message: 'ok' } });
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ title: spec.success.title })));
    await idle(client);

    // Still ONE request, and still A's.
    expect(mocked[spec.api]).toHaveBeenCalledTimes(1);
    expect(mocked[spec.api]).toHaveBeenCalledWith(...spec.args);
    // The answer says WHICH group it is about — and never names B.
    expect(toastMock).toHaveBeenCalledWith({
      title: spec.success.title,
      description: expect.stringContaining(spec.success.mention),
    });
    expect(JSON.stringify(toastMock.mock.calls)).not.toContain(NAMES.b);
    // Only A's keys were invalidated...
    const keys = invalidatedSince(invalidate, invalidationsBefore);
    for (const key of spec.invalidates) expect(keys).toContain(JSON.stringify(key));
    expect(keys.filter((k) => k.includes('g-b'))).toEqual([]);
    // ...B's cached data is exactly what it was, and was not refetched on A's account.
    expect(snapshotB(client)).toEqual(bBefore);
    expect(fetchesOfB(mocked)).toEqual(bFetches);
    spec.afterSuccess?.(client);
    // Focus is still where the user put it in B.
    expect(bControl).toHaveFocus();
    expect(isInert(spec.counterpart())).toBe(false);
  });

  it('a late FAILURE from A leaves B untouched, names A in the error, and does not move focus onto B', async () => {
    const { client, invalidate, goTo } = await start(spec);
    const request = deferred();
    mocked[spec.api].mockImplementation(() => request.promise);

    await spec.start();
    await waitFor(() => expect(mocked[spec.api]).toHaveBeenCalledTimes(1));
    goTo('B');
    await onGroup(NAMES.b);
    await waitFor(() => spec.counterpart());
    await idle(client);
    const bControl = spec.counterpart();
    bControl.focus();
    const bBefore = snapshotB(client);
    const bFetches = fetchesOfB(mocked);
    const invalidationsBefore = invalidate.mock.calls.length;

    request.reject(refusal('Insufficient permissions'));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'Error' })));
    await idle(client);

    expect(toastMock).toHaveBeenCalledWith({ title: 'Error', description: spec.failure, variant: 'destructive' });
    expect(JSON.stringify(toastMock.mock.calls)).not.toContain(NAMES.b);
    expect(mocked[spec.api]).toHaveBeenCalledTimes(1);
    expect(invalidatedSince(invalidate, invalidationsBefore).filter((k) => k.includes('g-b'))).toEqual([]);
    expect(snapshotB(client)).toEqual(bBefore);
    expect(fetchesOfB(mocked)).toEqual(bFetches);
    // Focus stays on B's control: the failure did not go looking for a "trigger" or a heading.
    expect(bControl).toHaveFocus();
    expect(isInert(spec.counterpart())).toBe(false);
  });

  it('A -> B -> A while the request is still running: the control is inert, and a second request cannot start', async () => {
    const { client, goTo } = await start(spec);
    const request = deferred();
    mocked[spec.api].mockImplementation(() => request.promise);

    await spec.start();
    await waitFor(() => expect(mocked[spec.api]).toHaveBeenCalledTimes(1));
    goTo('B');
    await onGroup(NAMES.b);
    goTo('A');
    await onGroup(NAMES.a);
    await idle(client);
    // A brand-new page instance: it never made the request. The mutation cache did.
    await waitFor(() => spec.counterpart());
    await spec.retry();

    expect(isInert(spec.inert())).toBe(true);
    expect(mocked[spec.api]).toHaveBeenCalledTimes(1);
    // Nothing was offered to confirm a second time.
    expect(screen.queryByRole('button', { name: /^Confirm (ban|transfer)$/ })).not.toBeInTheDocument();

    request.resolve(spec.result ?? { success: true, data: { message: 'ok' } });
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ title: spec.success.title })));
    await idle(client);
    expect(mocked[spec.api]).toHaveBeenCalledTimes(1);
  });
});

const CONFIRMATIONS = ACTIONS.filter((a) => a.open !== undefined);

describe.each(CONFIRMATIONS)('$label: the confirmation is scoped to the group where it was opened', (spec) => {
  const confirmButton = spec.id === 'ban' ? 'Confirm ban' : 'Confirm transfer';

  it('opened in A, it is gone after the move to B — and B receives no request', async () => {
    const { goTo } = await start(spec);
    await spec.open!();

    goTo('B');
    await onGroup(NAMES.b);
    await waitFor(() => spec.counterpart());

    expect(screen.queryByRole('button', { name: confirmButton })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /^Confirm (ban|ownership transfer)$/ })).not.toBeInTheDocument();
    expect(mocked[spec.api]).not.toHaveBeenCalled();
  });

  it("B's own confirmation targets B, and only B", async () => {
    const { goTo } = await start(spec);
    await spec.open!();
    goTo('B');
    await onGroup(NAMES.b);
    await waitFor(() => spec.counterpart());

    await spec.start();

    await waitFor(() => expect(mocked[spec.api]).toHaveBeenCalledTimes(1));
    expect(mocked[spec.api]).toHaveBeenCalledWith(...spec.args.map((arg) => (arg === A ? 'g-b' : arg)));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ title: spec.success.title })));
    expect(toastMock).toHaveBeenCalledWith({
      title: spec.success.title,
      description: expect.stringContaining(spec.success.mention.replace('Group A', NAMES.b)),
    });
  });

  it('rapid A -> B -> A leaves no stale confirmation, and nothing is sent', async () => {
    const { goTo, client } = await start(spec);
    await spec.open!();

    goTo('B');
    goTo('A');
    goTo('B');
    goTo('A');
    await onGroup(NAMES.a);
    await idle(client);
    await waitFor(() => spec.counterpart());

    expect(screen.queryByRole('button', { name: confirmButton })).not.toBeInTheDocument();
    expect(mocked[spec.api]).not.toHaveBeenCalled();
    // A fresh confirmation from here sends exactly one request, for A.
    await spec.start();
    await waitFor(() => expect(mocked[spec.api]).toHaveBeenCalledTimes(1));
    expect(mocked[spec.api]).toHaveBeenCalledWith(...spec.args);
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ title: spec.success.title })));
  });
});

describe('ownership transfer: B\'s ownership and member data cannot change because of A', () => {
  const spec = ACTIONS.find((a) => a.id === 'transfer')!;

  it('a late transfer from A leaves B\'s owner, members and controls exactly as they were', async () => {
    const { client, goTo } = await start(spec);
    const request = deferred();
    mocked.transferOwnership.mockImplementation(() => request.promise);
    await spec.start();
    await waitFor(() => expect(mocked.transferOwnership).toHaveBeenCalledTimes(1));
    goTo('B');
    await onGroup(NAMES.b);
    await waitFor(() => spec.counterpart());
    await idle(client);
    const before = snapshotB(client);
    expect(screen.getByText(/Owned by Viewer/)).toBeInTheDocument();

    request.resolve({ success: true, data: { message: 'ok' } });
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'Ownership transferred' })));
    await idle(client);

    // Same owner on screen, same members, same Transfer control — and no confirmation of anything.
    expect(screen.getByText(/Owned by Viewer/)).toBeInTheDocument();
    expect(snapshotB(client)).toEqual(before);
    expect(isInert(spec.counterpart())).toBe(false);
    expect(screen.queryByRole('button', { name: 'Confirm transfer' })).not.toBeInTheDocument();
    expect(mocked.transferOwnership).toHaveBeenCalledTimes(1);
    expect(mocked.transferOwnership).toHaveBeenCalledWith(A, 'u-shared');
  });

  it('only one transfer runs in a group at a time, whichever member it names', async () => {
    // A second candidate, in A only.
    const world = newWorld();
    addMember(world, A, OTHER);
    installApi(mocked, world);
    const rendered = renderRouted();
    const { client, goTo } = rendered;
    await primeBoth(rendered, { a: NAMES.a, b: NAMES.b });
    mocked.transferOwnership.mockClear();
    toastMock.mockClear();
    const request = deferred();
    mocked.transferOwnership.mockImplementation(() => request.promise);
    await spec.start();
    await waitFor(() => expect(mocked.transferOwnership).toHaveBeenCalledTimes(1));
    goTo('B');
    await onGroup(NAMES.b);
    goTo('A');
    await onGroup(NAMES.a);
    await idle(client);
    await waitFor(() => spec.counterpart());

    // The transfer to Shared Member is still running: Transfer is inert for EVERYONE in A,
    // including the member it does not name — and clicking it offers nothing.
    const otherRow = screen.getAllByText('Other Member').find((el) => el.tagName === 'SPAN')!.closest('.rounded-md') as HTMLElement;
    const otherTransfer = within(otherRow).getByRole('button', { name: 'Transfer' });
    expect(isInert(otherTransfer)).toBe(true);
    fireEvent.click(otherTransfer);
    expect(screen.queryByRole('button', { name: 'Confirm transfer' })).not.toBeInTheDocument();
    expect(mocked.transferOwnership).toHaveBeenCalledTimes(1);

    request.resolve({ success: true, data: { message: 'ok' } });
    await waitFor(() => expect(toastMock).toHaveBeenCalled());
  });
});

describe('an unsent invitation typed in A is not carried into B', () => {
  it('B\'s form is empty after the move, and A\'s draft does not come back either', async () => {
    const spec = ACTIONS.find((a) => a.id === 'invite')!;
    const { goTo } = await start(spec);
    fireEvent.change(await screen.findByPlaceholderText('user@example.com'), { target: { value: 'draft@test.com' } });

    goTo('B');
    await onGroup(NAMES.b);
    const input = (await screen.findByPlaceholderText('user@example.com')) as HTMLInputElement;
    expect(input.value).toBe('');

    goTo('A');
    await onGroup(NAMES.a);
    expect(((await screen.findByPlaceholderText('user@example.com')) as HTMLInputElement).value).toBe('');
    expect(mocked.createGroupInvite).not.toHaveBeenCalled();
  });
});

describe('Request to join / Join: the request carries the group it was made in', () => {
  it('a PUBLIC group is joined through joinGroup(A), with privacy captured at the click', async () => {
    const world = newWorld();
    world.isMember[A] = false;
    world.isMember['g-b'] = false;
    installApi(mocked, world);
    // Public: the join button is "Join", and the private-only route must not be used.
    mocked.getGroup.mockImplementation(async (groupId: string) => ({
      data: {
        id: groupId,
        name: groupId === A ? NAMES.a : NAMES.b,
        description: null,
        imageUrl: null,
        coverUrl: null,
        isPrivate: false,
        status: 'ACTIVE',
        memberCount: 3,
        isMember: false,
        memberRole: null,
        viewerMembershipStatus: null,
        requestStatus: null,
        owner: { id: 'u-viewer', username: 'viewer', displayName: 'Viewer' },
      },
    }));
    const r = renderRouted();
    await primeBoth(r, { a: NAMES.a, b: NAMES.b });
    const request = deferred();
    mocked.joinGroup.mockImplementation(() => request.promise);

    fireEvent.click(await screen.findByRole('button', { name: 'Join' }));
    await waitFor(() => expect(mocked.joinGroup).toHaveBeenCalledTimes(1));
    expect(mocked.joinGroup).toHaveBeenCalledWith(A);
    expect(mocked.requestJoinGroup).not.toHaveBeenCalled();
    r.goTo('B');
    await onGroup(NAMES.b);
    const bJoin = await screen.findByRole('button', { name: 'Join' });
    expect(isInert(bJoin)).toBe(false);

    request.resolve({ success: true, data: { message: 'ok' } });
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'Joined group' })));
    expect(toastMock).toHaveBeenCalledWith({ title: 'Joined group', description: NAMES.a });
    expect(mocked.joinGroup).toHaveBeenCalledTimes(1);
    expect(isInert(bJoin)).toBe(false);
  });
});

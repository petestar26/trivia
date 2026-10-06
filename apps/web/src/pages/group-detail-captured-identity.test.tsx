import { MutationObserver } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { groupActionKey } from '@/lib/group-actions';
import {
  A,
  ACTIONS,
  B,
  deferred,
  inMemberRow,
  fetchesOfB,
  idle,
  installApi,
  invalidatedSince,
  newWorld,
  onGroup,
  refusal,
  renderReused,
  snapshotB,
  type MockedApi,
} from './group-detail-actions.harness';

// The SECOND layer of protection against acting on the wrong group.
//
// GroupDetailPage keys the page content by group, so a move from A to B
// remounts it and nothing survives (group-detail-navigation.test.tsx, real
// router). This file is about what must STILL hold if a page instance is ever
// handed a different `groupId` without being remounted — the shape of the
// original bug. Every test here renders ONE GroupDetailContent, no key, and
// re-renders it with the other group; the confirmation, the pending request and
// the callbacks TanStack hands an in-flight mutation (the LATEST render's) are
// all still there, and the group they read must be the one the action was
// initiated for: not the prop, not the route, not a query result.
//
// (What the instance shows afterwards — an old confirmation on a new group's
// page — is the boundary's job and is not asserted here.)

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

beforeEach(() => {
  cleanup();
  vi.resetAllMocks();
  toastMock.mockReset();
});

const NAME_B = 'Group B';
/** A control that exists on every page state and is never inert: the user's focus lives here. */
const backButton = () => screen.getByRole('button', { name: /Back to groups/ });

/** One instance on A with both groups cached (B is visited once, in the same instance, then A again). */
async function startReused(spec: (typeof ACTIONS)[number]) {
  const world = newWorld();
  spec.setup?.(world);
  installApi(mocked, world);
  const r = renderReused();
  await onGroup('Group A');
  await idle(r.client);
  r.goTo('B');
  await onGroup(NAME_B);
  await idle(r.client);
  r.goTo('A');
  await onGroup('Group A');
  await idle(r.client);
  mocked[spec.api].mockClear();
  toastMock.mockClear();
  return r;
}

describe.each(ACTIONS)('$label', (spec) => {
  it('a late SUCCESS is applied to the group it was started in, even though the instance now shows B', async () => {
    const { client, invalidate, goTo } = await startReused(spec);
    const request = deferred();
    mocked[spec.api].mockImplementation(() => request.promise);
    await spec.start();
    await waitFor(() => expect(mocked[spec.api]).toHaveBeenCalledTimes(1));
    expect(mocked[spec.api]).toHaveBeenCalledWith(...spec.args);

    goTo('B');
    await onGroup(NAME_B);
    await idle(client);
    backButton().focus();
    const bBefore = snapshotB(client);
    const bFetches = fetchesOfB(mocked);
    const invalidationsBefore = invalidate.mock.calls.length;

    request.resolve(spec.result ?? { success: true, data: { message: 'ok' } });
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ title: spec.success.title })));
    await idle(client);

    // The request, the keys, the cache patches and the words all belong to A.
    expect(mocked[spec.api]).toHaveBeenCalledTimes(1);
    expect(toastMock).toHaveBeenCalledWith({
      title: spec.success.title,
      description: expect.stringContaining(spec.success.mention),
    });
    expect(JSON.stringify(toastMock.mock.calls)).not.toContain(NAME_B);
    const keys = invalidatedSince(invalidate, invalidationsBefore);
    for (const key of spec.invalidates) expect(keys).toContain(JSON.stringify(key));
    expect(keys.filter((k) => k.includes(B))).toEqual([]);
    expect(snapshotB(client)).toEqual(bBefore);
    expect(fetchesOfB(mocked)).toEqual(bFetches);
    spec.afterSuccess?.(client);
    // ...and the user, who is looking at B, is not moved.
    expect(backButton()).toHaveFocus();
    // The confirmation that was A's is closed by A's answer.
    expect(screen.queryByRole('heading', { name: /^Confirm (ban|ownership transfer)$/ })).not.toBeInTheDocument();
  });

  it('clicking and moving to B in the SAME tick still sends the request to A (it is made a moment after the click, by the latest render\'s callbacks)', async () => {
    const { goTo } = await startReused(spec);
    await spec.ready();

    spec.fire();
    goTo('B'); // nothing awaited in between: the request has not been made yet

    await waitFor(() => expect(mocked[spec.api]).toHaveBeenCalledTimes(1));
    expect(mocked[spec.api]).toHaveBeenCalledWith(...spec.args);
    await waitFor(() => expect(toastMock).toHaveBeenCalled());
    expect(JSON.stringify(toastMock.mock.calls)).not.toContain(NAME_B);
  });

  it('a late FAILURE is reported for the group it was started in, and reconciles nothing in B', async () => {
    const { client, invalidate, goTo } = await startReused(spec);
    const request = deferred();
    mocked[spec.api].mockImplementation(() => request.promise);
    await spec.start();
    await waitFor(() => expect(mocked[spec.api]).toHaveBeenCalledTimes(1));
    goTo('B');
    await onGroup(NAME_B);
    await idle(client);
    backButton().focus();
    const bBefore = snapshotB(client);
    const invalidationsBefore = invalidate.mock.calls.length;

    request.reject(refusal('Insufficient permissions'));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'Error' })));
    await idle(client);

    expect(toastMock).toHaveBeenCalledWith({ title: 'Error', description: spec.failure, variant: 'destructive' });
    expect(JSON.stringify(toastMock.mock.calls)).not.toContain(NAME_B);
    expect(invalidatedSince(invalidate, invalidationsBefore).filter((k) => k.includes(B))).toEqual([]);
    expect(snapshotB(client)).toEqual(bBefore);
    // Focus stays where the user put it: no "restore to the trigger" in a group they have left.
    expect(backButton()).toHaveFocus();
    expect(screen.queryByRole('heading', { name: /^Confirm (ban|ownership transfer)$/ })).not.toBeInTheDocument();
  });
});

const CONFIRMATIONS = ACTIONS.filter((a) => a.open !== undefined);

describe.each(CONFIRMATIONS)('$label: the confirmation carries its group', (spec) => {
  it('confirming after the instance was handed group B still sends the request to A, for A\'s target', async () => {
    const { goTo } = await startReused(spec);
    await spec.open!();

    goTo('B');
    await onGroup(NAME_B);
    // The confirmation was opened for A; it is still on screen, and Confirm acts on A.
    await spec.confirm!();

    await waitFor(() => expect(mocked[spec.api]).toHaveBeenCalledTimes(1));
    expect(mocked[spec.api]).toHaveBeenCalledWith(...spec.args);
    expect(mocked[spec.api]).not.toHaveBeenCalledWith(B, expect.anything());
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ title: spec.success.title })));
    expect(JSON.stringify(toastMock.mock.calls)).not.toContain(NAME_B);
  });

  it('cancelling that confirmation does not move focus into the group now shown', async () => {
    const { goTo } = await startReused(spec);
    await spec.open!();
    goTo('B');
    await onGroup(NAME_B);
    backButton().focus();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    // Closed — and focus is where the user put it, not on a "trigger" of the other group.
    expect(screen.queryByRole('button', { name: /^Confirm (ban|transfer)$/ })).not.toBeInTheDocument();
    expect(mocked[spec.api]).not.toHaveBeenCalled();
    if (spec.id === 'ban') expect(backButton()).toHaveFocus();
  });

  it('a duplicate is refused at Confirm when the same action is already running — even if the button looked available', async () => {
    const { client, goTo } = await startReused(spec);
    await spec.open!();
    // The confirmation was opened for A, and the instance now shows B: the guard
    // must ask about A (the action's group), not about the group on screen.
    goTo('B');
    await onGroup(NAME_B);
    // The same action, started on an earlier visit by an instance that no longer exists:
    // the mutation cache knows it, this page instance does not.
    const earlier = deferred();
    // (A transfer is one-at-a-time in a group whoever it names, so the earlier one
    // names somebody ELSE: it must still block this one.)
    void new MutationObserver<unknown, Error, { groupId: string; groupName: string; targetId: string; name: string }>(client, {
      mutationKey: groupActionKey(spec.id === 'ban' ? 'ban' : 'transfer'),
      mutationFn: () => earlier.promise,
    }).mutate(
      spec.id === 'ban'
        ? { groupId: A, groupName: 'Group A', targetId: 'u-shared', name: 'Shared Member' }
        : { groupId: A, groupName: 'Group A', targetId: 'u-other', name: 'Other Member' }
    );

    await spec.confirm!();

    expect(mocked[spec.api]).not.toHaveBeenCalled();
    earlier.resolve(undefined);
    await idle(client);
    expect(mocked[spec.api]).not.toHaveBeenCalled();
  });
});

describe('Ban: an answer from A never closes — or steals focus from — a confirmation that is B\'s', () => {
  it('A\'s late success leaves B\'s open confirmation alone; cancelling it then restores focus to B\'s own trigger', async () => {
    const spec = ACTIONS.find((a) => a.id === 'ban')!;
    const { goTo } = await startReused(spec);
    const request = deferred();
    mocked.banGroupMember.mockImplementation(() => request.promise);
    await spec.start();
    await waitFor(() => expect(mocked.banGroupMember).toHaveBeenCalledTimes(1));
    goTo('B');
    await onGroup(NAME_B);
    // The user opens a confirmation in B (its own trigger, its own target); it replaces A's on screen.
    const bTrigger = inMemberRow().getByRole('button', { name: 'Ban' });
    fireEvent.click(bTrigger);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Banning…' })).toBeInTheDocument());
    backButton().focus();

    request.resolve({ success: true, data: { message: 'ok' } });
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'Member banned' })));

    // A's answer did not dismiss B's confirmation, and did not move focus.
    expect(screen.getByRole('heading', { name: 'Confirm ban' })).toBeInTheDocument();
    expect(backButton()).toHaveFocus();
    // Now it is B's request that is settled: Cancel closes B's confirmation and,
    // because the user is still in B and the trigger still exists, restores focus there.
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('heading', { name: 'Confirm ban' })).not.toBeInTheDocument();
    expect(bTrigger).toHaveFocus();
    expect(mocked.banGroupMember).toHaveBeenCalledTimes(1);
  });
});

describe('Approve / Reject: an answer already on its way blocks the opposite answer too', () => {
  it('a reject that is already running (started elsewhere) stops an approve of the same request', async () => {
    const spec = ACTIONS.find((a) => a.id === 'approve')!;
    const { client } = await startReused(spec);
    await screen.findByRole('button', { name: 'Approve' });
    const earlier = deferred();
    // The opposite answer, started on an earlier visit. Clicking Approve in the same
    // tick — before this instance has re-rendered — must not add a second answer.
    void new MutationObserver<unknown, Error, { groupId: string; groupName: string; targetId: string; name: string }>(client, {
      mutationKey: groupActionKey('reject'),
      mutationFn: () => earlier.promise,
    }).mutate({ groupId: A, groupName: 'Group A', targetId: 'u-req', name: 'Requester' });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    expect(mocked.approveJoinRequest).not.toHaveBeenCalled();
    earlier.resolve(undefined);
    await idle(client);
    expect(mocked.approveJoinRequest).not.toHaveBeenCalled();
  });
});

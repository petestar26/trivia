import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, vi } from 'vitest';
import { GroupDetailContent, GroupDetailPage } from './group-detail';

// Shared scaffolding for the stale-group-identity tests.
//
// TWO groups, A and B, cached side by side, that share the SAME people and the
// SAME ids — the member, the join request, the invitation — so that a request
// sent to the wrong group, or a cache patched in the wrong group, is observable
// rather than a 404. Two ways of moving from A to B:
//
//   routed   the real router and the real GroupDetailPage: the group-keyed
//            boundary is in play (nothing survives the move);
//   reused   one GroupDetailContent instance handed a new `groupId` with NO
//            key: the boundary is out of the picture, which is exactly what
//            proves the second layer — every request, callback, cache write and
//            toast reads the group of the action that was initiated.
//
// This file is not a test: the test files own `vi.mock`, and pass the mocked
// API in.

export const A = 'g-a';
export const B = 'g-b';
export type GroupKey = typeof A | typeof B;

export const NAMES: Record<GroupKey, string> = { [A]: 'Group A', [B]: 'Group B' };

const VIEWER = { id: 'u-viewer', username: 'viewer', displayName: 'Viewer' };
export const SHARED = { id: 'u-shared', username: 'shared', displayName: 'Shared Member' };
export const REQUESTER = { id: 'u-req', username: 'requester', displayName: 'Requester' };

type Person = { id: string; username: string; displayName: string };
interface MemberRow {
  id: string;
  groupId: string;
  user: Person;
  role: string;
  status: string;
  joinedAt: string;
}
interface InviteRow {
  id: string;
  email: string;
  role: string;
  status: string;
  token: string;
  expiresAt: string;
  invitedBy: string;
  createdAt: string;
}

const memberRow = (groupId: string, user: Person, role: string, status = 'ACTIVE'): MemberRow => ({
  id: `m-${groupId}-${user.id}`,
  groupId,
  user,
  role,
  status,
  joinedAt: '2024-01-01T00:00:00.000Z',
});

// The SAME invitation id in both groups: an invite revoked in A and removed
// from B's list by mistake would be observable.
const inviteRow = (): InviteRow => ({
  id: 'inv-1',
  email: 'invitee@test.com',
  role: 'MEMBER',
  status: 'PENDING',
  token: 'tok-1',
  expiresAt: '2030-01-01T00:00:00.000Z',
  invitedBy: 'u-viewer',
  createdAt: '2024-01-01T00:00:00.000Z',
});

export interface World {
  /** Is the viewer a member of the group? (false: the join view.) */
  isMember: Record<GroupKey, boolean>;
  members: Record<GroupKey, MemberRow[]>;
  requests: Record<GroupKey, MemberRow[]>;
  invites: Record<GroupKey, InviteRow[]>;
}

export function newWorld(): World {
  const both = <T,>(make: (g: GroupKey) => T): Record<GroupKey, T> => ({ [A]: make(A), [B]: make(B) });
  return {
    isMember: both(() => true),
    members: both((g) => [memberRow(g, VIEWER, 'OWNER'), memberRow(g, SHARED, 'MEMBER')]),
    requests: both((g) => [memberRow(g, REQUESTER, 'MEMBER', 'PENDING')]),
    invites: both(() => [inviteRow()]),
  };
}

/** Another ACTIVE member, in one group only. */
export const OTHER = { id: 'u-other', username: 'other', displayName: 'Other Member' };
export function addMember(world: World, group: GroupKey, person: Person, role = 'MEMBER') {
  world.members[group].push(memberRow(group, person, role));
}

const pageMeta = (page: number, limit: number, total: number) => ({
  total,
  page,
  limit,
  totalPages: Math.max(1, Math.ceil(total / limit)),
  hasNextPage: false,
  hasPrevPage: page > 1,
});

export const API_FUNCTIONS = [
  'getGroup',
  'getGroupMembers',
  'listGroupInvites',
  'listJoinRequests',
  'listBannedMembers',
  'unbanGroupMember',
  'banGroupMember',
  'removeGroupMember',
  'changeMemberRole',
  'approveJoinRequest',
  'rejectJoinRequest',
  'createGroupInvite',
  'revokeGroupInvite',
  'transferOwnership',
  'leaveGroup',
  'joinGroup',
  'requestJoinGroup',
] as const;
export type MockedApi = Record<(typeof API_FUNCTIONS)[number], ReturnType<typeof vi.fn>>;

/** The API, served from `world`. Every action succeeds unless a test overrides it. */
export function installApi(mocked: MockedApi, world: World) {
  const ok = (message: string) => ({ success: true, data: { message } });
  mocked.getGroup.mockImplementation(async (groupId: GroupKey) => ({
    data: {
      id: groupId,
      name: NAMES[groupId],
      description: null,
      imageUrl: null,
      coverUrl: null,
      isPrivate: true,
      status: 'ACTIVE',
      memberCount: world.members[groupId].length,
      isMember: world.isMember[groupId],
      memberRole: world.isMember[groupId] ? 'OWNER' : null,
      viewerMembershipStatus: world.isMember[groupId] ? 'ACTIVE' : null,
      requestStatus: null,
      owner: VIEWER,
    },
  }));
  mocked.getGroupMembers.mockImplementation(async (groupId: GroupKey) => ({ data: world.members[groupId] }));
  mocked.listJoinRequests.mockImplementation(async (groupId: GroupKey) => ({ data: world.requests[groupId] }));
  mocked.listGroupInvites.mockImplementation(async (groupId: GroupKey, params: { page: number; limit: number }) => ({
    success: true,
    data: world.invites[groupId],
    meta: pageMeta(params.page, params.limit, world.invites[groupId].length),
  }));
  mocked.listBannedMembers.mockImplementation(async (_groupId: GroupKey, params: { page: number; limit: number }) => ({
    success: true,
    data: [],
    meta: pageMeta(params.page, params.limit, 0),
  }));
  for (const name of [
    'unbanGroupMember',
    'banGroupMember',
    'removeGroupMember',
    'changeMemberRole',
    'approveJoinRequest',
    'rejectJoinRequest',
    'revokeGroupInvite',
    'transferOwnership',
    'leaveGroup',
    'joinGroup',
    'requestJoinGroup',
  ] as const) {
    mocked[name].mockResolvedValue(ok(name));
  }
  mocked.createGroupInvite.mockImplementation(async (groupId: GroupKey, email: string, role: string) => ({
    success: true,
    data: {
      id: 'inv-new',
      groupId,
      email,
      role,
      status: 'PENDING',
      token: 'tok-new',
      expiresAt: '2030-01-01T00:00:00.000Z',
      invitedBy: 'u-viewer',
      createdAt: '2024-02-01T00:00:00.000Z',
    },
  }));
}

export function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export const refusal = (message: string, status = 403) => new Error(JSON.stringify({ status, message }));

/** What the tests read of the `invalidateQueries` spy. */
export interface InvalidateSpy {
  mock: { calls: unknown[][] };
}

export interface Rendered {
  client: QueryClient;
  invalidate: InvalidateSpy;
  /** Move to the other group: a link click (routed) or a new prop (reused). */
  goTo: (group: 'A' | 'B') => void;
}

const newClient = () =>
  // Caching ON and never collected: group B really is a cached group when the
  // user moves to it.
  new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });

/** The real router, the real page, links to both groups. */
export function renderRouted(): Rendered {
  const client = newClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries') as unknown as InvalidateSpy;
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/groups/${A}`]}>
        <nav>
          <Link to={`/groups/${A}`}>go to A</Link>
          <Link to={`/groups/${B}`}>go to B</Link>
        </nav>
        <Routes>
          <Route path="/groups/:id" element={<GroupDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { client, invalidate, goTo: (g) => fireEvent.click(screen.getByRole('link', { name: `go to ${g}` })) };
}

/** ONE GroupDetailContent, no key, handed a new `groupId`. */
export function renderReused(): Rendered {
  const client = newClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries') as unknown as InvalidateSpy;
  const tree = (groupId: string) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <GroupDetailContent groupId={groupId} />
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(tree(A));
  return { client, invalidate, goTo: (g) => view.rerender(tree(g === 'A' ? A : B)) };
}

export const onGroup = (name: string) => screen.findByRole('heading', { name });

/** Every query settled: nothing is mid-fetch, so a count taken now is a baseline. */
export const idle = (client: QueryClient) => waitFor(() => expect(client.isFetching()).toBe(0));

/** Visit B, then A again, so both groups are cached; ends on A. (Routed mode only.) */
export async function primeBoth(r: Rendered, opts: { a: string; b: string }) {
  await onGroup(opts.a);
  await idle(r.client);
  r.goTo('B');
  await onGroup(opts.b);
  await idle(r.client);
  r.goTo('A');
  await onGroup(opts.a);
  await idle(r.client);
}

const memberRowEl = () => {
  // The name is a <span> in the member's row; an open confirmation names the same
  // person in a <strong>, which is not the row.
  const name = screen.getAllByText('Shared Member').find((el) => el.tagName === 'SPAN');
  const row = name?.closest('.rounded-md');
  if (!(row instanceof HTMLElement)) throw new Error('member row not found');
  return row;
};
export const inMemberRow = () => within(memberRowEl());

/** Is `el` inert — natively disabled or aria-disabled? */
export const isInert = (el: HTMLElement) => (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true';

export interface ActionSpec {
  id: string;
  label: string;
  /** Adjust the world before anything renders. */
  setup?: (world: World) => void;
  /** The mocked API method the action calls, and the exact arguments it must carry. */
  api: keyof MockedApi;
  args: unknown[];
  /** The response that settles the request successfully. */
  result?: unknown;
  /** Wait until the control is there (for a confirmation: open it). */
  ready: () => Promise<void>;
  /** The final, SYNCHRONOUS user action that sends the request (for a confirmation: Confirm). */
  fire: () => void;
  /** ready + fire: everything up to the request being sent. */
  start: () => Promise<void>;
  /** Confirmation-based actions only: the steps, named. */
  open?: () => Promise<void>;
  confirm?: () => Promise<void>;
  /** The same control in the OTHER group's page (must never be inert because of A). */
  counterpart: () => HTMLElement;
  /** The control that must be inert on a re-opened A while this very action runs. */
  inert: () => HTMLElement;
  /** Try to run the same action again from a re-opened A. */
  retry: () => Promise<void>;
  /** Query keys a SUCCESSFUL action must invalidate — all of them A's. */
  invalidates: unknown[][];
  success: { title: string; mention: string };
  failure: string;
  /** Extra, action-specific effects on A's cache after success (B's is checked generically). */
  afterSuccess?: (client: QueryClient) => void;
}

const findButton = (name: string) => screen.findByRole('button', { name });
const click = (el: HTMLElement): void => {
  fireEvent.click(el);
};

type RawSpec = Omit<ActionSpec, 'start' | 'open' | 'confirm'> & { confirmation?: boolean };

const RAW_ACTIONS: RawSpec[] = [
  {
    id: 'remove',
    label: 'Remove member',
    api: 'removeGroupMember',
    args: [A, SHARED.id],
    ready: async () => {
      await screen.findByText('Shared Member');
    },
    fire: () => click(inMemberRow().getByRole('button', { name: 'Remove' })),
    counterpart: () => inMemberRow().getByRole('button', { name: 'Remove' }),
    inert: () => inMemberRow().getByRole('button', { name: 'Remove' }),
    retry: async () => {
      click(inMemberRow().getByRole('button', { name: 'Remove' }));
    },
    invalidates: [['group-members', A], ['group', A]],
    success: { title: 'Member removed', mention: 'Shared Member was removed from Group A.' },
    failure: "Couldn't remove Shared Member from Group A. Insufficient permissions",
  },
  {
    id: 'role',
    label: 'Change member role',
    api: 'changeMemberRole',
    args: [A, SHARED.id, 'ADMIN'],
    ready: async () => {
      await screen.findByText('Shared Member');
    },
    fire: () => {
      fireEvent.change(inMemberRow().getByRole('combobox'), { target: { value: 'ADMIN' } });
    },
    counterpart: () => inMemberRow().getByRole('combobox'),
    inert: () => inMemberRow().getByRole('combobox'),
    retry: async () => {
      fireEvent.change(inMemberRow().getByRole('combobox'), { target: { value: 'ADMIN' } });
    },
    invalidates: [['group-members', A]],
    success: { title: 'Role updated', mention: 'Shared Member is now ADMIN in Group A.' },
    failure: "Couldn't change Shared Member's role in Group A. Insufficient permissions",
  },
  {
    id: 'approve',
    label: 'Approve join request',
    api: 'approveJoinRequest',
    args: [A, REQUESTER.id],
    ready: async () => {
      await findButton('Approve');
    },
    fire: () => click(screen.getByRole('button', { name: 'Approve' })),
    counterpart: () => screen.getByRole('button', { name: 'Approve' }),
    inert: () => screen.getByRole('button', { name: 'Approve' }),
    retry: async () => {
      click(screen.getByRole('button', { name: 'Approve' }));
    },
    invalidates: [['group-requests', A], ['group-members', A], ['group', A]],
    success: { title: 'Request approved', mention: 'Requester was approved to join Group A.' },
    failure: "Couldn't approve Requester's request to join Group A. Insufficient permissions",
  },
  {
    id: 'reject',
    label: 'Reject join request',
    api: 'rejectJoinRequest',
    args: [A, REQUESTER.id],
    ready: async () => {
      await findButton('Reject');
    },
    fire: () => click(screen.getByRole('button', { name: 'Reject' })),
    counterpart: () => screen.getByRole('button', { name: 'Reject' }),
    inert: () => screen.getByRole('button', { name: 'Reject' }),
    retry: async () => {
      click(screen.getByRole('button', { name: 'Reject' }));
    },
    invalidates: [['group-requests', A], ['group-members', A], ['group', A]],
    success: { title: 'Request rejected', mention: "Requester's request to join Group A was rejected." },
    failure: "Couldn't reject Requester's request to join Group A. Insufficient permissions",
  },
  {
    id: 'revoke',
    label: 'Revoke invitation',
    api: 'revokeGroupInvite',
    args: [A, 'inv-1'],
    ready: async () => {
      await findButton('Revoke');
    },
    fire: () => click(screen.getByRole('button', { name: 'Revoke' })),
    counterpart: () => screen.getByRole('button', { name: 'Revoke' }),
    inert: () => screen.getByRole('button', { name: 'Revoke' }),
    retry: async () => {
      click(screen.getByRole('button', { name: 'Revoke' }));
    },
    invalidates: [['group-invites', A]],
    success: { title: 'Invite revoked', mention: 'The invite for invitee@test.com to Group A was revoked.' },
    failure: "Couldn't revoke the invite for invitee@test.com in Group A. Insufficient permissions",
    afterSuccess: (client) => {
      // A's list lost the invitation the request named...
      const a = client.getQueryData<{ pages: { invites: { id: string }[] }[] }>(['group-invites', A]);
      expect(a?.pages.flatMap((p) => p.invites.map((i) => i.id))).toEqual([]);
    },
  },
  {
    id: 'invite',
    label: 'Create invitation',
    api: 'createGroupInvite',
    args: [A, 'new@test.com', 'MEMBER'],
    // What the API answers with: the created invitation, token and all.
    result: {
      success: true,
      data: {
        id: 'inv-new',
        groupId: A,
        email: 'new@test.com',
        role: 'MEMBER',
        status: 'PENDING',
        token: 'tok-new',
        expiresAt: '2030-01-01T00:00:00.000Z',
        invitedBy: 'u-viewer',
        createdAt: '2024-02-01T00:00:00.000Z',
      },
    },
    ready: async () => {
      await screen.findByPlaceholderText('user@example.com');
    },
    fire: () => {
      fireEvent.change(screen.getByPlaceholderText('user@example.com'), { target: { value: 'new@test.com' } });
      click(screen.getByRole('button', { name: 'Invite' }));
    },
    counterpart: () => screen.getByPlaceholderText('user@example.com'),
    inert: () => screen.getByRole('button', { name: 'Invite' }),
    retry: async () => {
      fireEvent.change(screen.getByPlaceholderText('user@example.com'), { target: { value: 'new@test.com' } });
      click(screen.getByRole('button', { name: 'Invite' }));
    },
    invalidates: [['group-invites', A]],
    success: { title: 'Invite created', mention: 'For Group A' },
    failure: "Couldn't invite new@test.com to Group A. Insufficient permissions",
    afterSuccess: (client) => {
      // The created invitation — a bearer-equivalent link — is in A's list...
      const a = client.getQueryData<{ pages: { invites: { id: string }[] }[] }>(['group-invites', A]);
      expect(a?.pages.flatMap((p) => p.invites.map((i) => i.id))).toContain('inv-new');
    },
  },
  {
    id: 'leave',
    label: 'Leave group',
    api: 'leaveGroup',
    args: [A],
    ready: async () => {
      await findButton('Leave');
    },
    fire: () => click(screen.getByRole('button', { name: 'Leave' })),
    counterpart: () => screen.getByRole('button', { name: 'Leave' }),
    inert: () => screen.getByRole('button', { name: 'Leave' }),
    retry: async () => {
      click(screen.getByRole('button', { name: 'Leave' }));
    },
    invalidates: [['group', A]],
    success: { title: 'Left group', mention: 'Group A' },
    failure: "Couldn't leave Group A. Insufficient permissions",
  },
  {
    id: 'request-to-join',
    label: 'Request to join (private group)',
    setup: (world) => {
      world.isMember[A] = false;
      world.isMember[B] = false;
    },
    api: 'requestJoinGroup',
    args: [A],
    ready: async () => {
      await findButton('Request to join');
    },
    fire: () => click(screen.getByRole('button', { name: 'Request to join' })),
    counterpart: () => screen.getByRole('button', { name: 'Request to join' }),
    inert: () => screen.getByRole('button', { name: 'Request to join' }),
    retry: async () => {
      click(screen.getByRole('button', { name: 'Request to join' }));
    },
    invalidates: [['group', A], ['group-members', A]],
    success: { title: 'Join request submitted', mention: 'Group A' },
    failure: "Couldn't join Group A. Insufficient permissions",
  },
  {
    id: 'ban',
    label: 'Ban member',
    api: 'banGroupMember',
    args: [A, SHARED.id],
    confirmation: true,
    ready: async () => {
      await screen.findByText('Shared Member');
      click(inMemberRow().getByRole('button', { name: 'Ban' }));
      await screen.findByRole('button', { name: 'Confirm ban' });
    },
    fire: () => click(screen.getByRole('button', { name: 'Confirm ban' })),
    counterpart: () => inMemberRow().getByRole('button', { name: 'Ban' }),
    inert: () => inMemberRow().getByRole('button', { name: 'Ban' }),
    retry: async () => {
      click(inMemberRow().getByRole('button', { name: 'Ban' }));
    },
    invalidates: [['group-members', A], ['group-requests', A], ['group-invites', A], ['group-banned-members', A], ['group', A]],
    success: { title: 'Member banned', mention: 'Shared Member was banned from Group A.' },
    failure: "Couldn't ban Shared Member from Group A. Insufficient permissions",
  },
  {
    id: 'transfer',
    label: 'Transfer ownership',
    api: 'transferOwnership',
    args: [A, SHARED.id],
    confirmation: true,
    ready: async () => {
      await screen.findByText('Shared Member');
      click(inMemberRow().getByRole('button', { name: 'Transfer' }));
      await screen.findByRole('button', { name: 'Confirm transfer' });
    },
    fire: () => click(screen.getByRole('button', { name: 'Confirm transfer' })),
    counterpart: () => inMemberRow().getByRole('button', { name: 'Transfer' }),
    inert: () => inMemberRow().getByRole('button', { name: 'Transfer' }),
    retry: async () => {
      click(inMemberRow().getByRole('button', { name: 'Transfer' }));
    },
    invalidates: [['group', A], ['group-members', A]],
    success: { title: 'Ownership transferred', mention: 'Shared Member now owns Group A.' },
    failure: "Couldn't transfer Group A to Shared Member. Insufficient permissions",
  },
];

export const ACTIONS: ActionSpec[] = RAW_ACTIONS.map(({ confirmation, ...raw }) => ({
  ...raw,
  start: async () => {
    await raw.ready();
    raw.fire();
  },
  ...(confirmation ? { open: raw.ready, confirm: async () => raw.fire() } : {}),
}));

/** Every query result cached for B — the things a stray answer from A must not change. */
export const snapshotB = (client: QueryClient) => ({
  group: client.getQueryData(['group', B]),
  members: client.getQueryData(['group-members', B]),
  requests: client.getQueryData(['group-requests', B]),
  invites: client.getQueryData(['group-invites', B]),
  banned: client.getQueryData(['group-banned-members', B]),
});

/** How many times B's data was fetched — an answer from A must not cause a refetch of B. */
export const fetchesOfB = (mocked: MockedApi) =>
  (['getGroup', 'getGroupMembers', 'listJoinRequests', 'listGroupInvites', 'listBannedMembers'] as const).map(
    (name) => mocked[name].mock.calls.filter((c: unknown[]) => c[0] === B).length
  );

/** JSON of every key passed to invalidateQueries since `since`. */
export const invalidatedSince = (invalidate: Rendered['invalidate'], since: number) =>
  invalidate.mock.calls.slice(since).map((c: unknown[]) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey));

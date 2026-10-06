import { describe, expect, it } from 'vitest';
import type { GroupBannedMemberInfo } from '@socialplay/shared';
import {
  applyUnbannedMember,
  bannedMembersQueryKey,
  flattenBannedMembersPages,
  toBannedMembersPage,
  type BannedMembersInbox,
  type BannedMembersPage,
} from './group-banned-members-pages';

const member = (id: string): GroupBannedMemberInfo => ({
  id: `m-${id}`,
  groupId: 'g-1',
  user: { id, username: `user-${id}`, displayName: `User ${id}`, avatarUrl: null },
});

const page = (n: number, ids: string[], hasNextPage = false): BannedMembersPage => ({
  page: n,
  hasNextPage,
  members: ids.map(member),
});

describe('bannedMembersQueryKey', () => {
  it('is scoped to the group, and is the key the page invalidates', () => {
    expect(bannedMembersQueryKey('g-1')).toEqual(['group-banned-members', 'g-1']);
    expect(bannedMembersQueryKey('g-1')).not.toEqual(bannedMembersQueryKey('g-2'));
  });
});

describe('toBannedMembersPage', () => {
  it('keeps only the server-claimed next-page flag, never trusting meta.page', () => {
    const result = toBannedMembersPage(
      {
        success: true,
        data: [member('a')],
        meta: { total: 40, page: 9, limit: 20, totalPages: 2, hasNextPage: true, hasPrevPage: false },
      },
      1
    );
    expect(result).toEqual({ members: [member('a')], page: 1, hasNextPage: true });
  });

  it('reads a missing or false next-page claim as false', () => {
    expect(toBannedMembersPage({ success: true, data: [member('a')] }, 2).hasNextPage).toBe(false);
    expect(
      toBannedMembersPage(
        { success: true, data: [], meta: { total: 0, page: 1, limit: 20, totalPages: 0, hasNextPage: false, hasPrevPage: false } },
        1
      ).hasNextPage
    ).toBe(false);
  });

  it('reads a missing data array as an empty page', () => {
    expect(toBannedMembersPage({ success: true }, 1).members).toEqual([]);
  });

  it('rejects an unsuccessful body instead of reading it as an empty list', () => {
    expect(() => toBannedMembersPage({ success: false, error: { code: 'X', message: 'boom' } }, 1)).toThrow('boom');
    expect(() => toBannedMembersPage({ success: false }, 1)).toThrow('Failed to load banned members');
  });
});

describe('flattenBannedMembersPages', () => {
  it('flattens pages in order, one row per USER (a repeat across a page boundary is dropped)', () => {
    const pages = [page(1, ['a', 'b'], true), page(2, ['b', 'c'])];
    expect(flattenBannedMembersPages(pages).map((m) => m.user.id)).toEqual(['a', 'b', 'c']);
  });

  it('de-duplicates on the user, not on the membership row id', () => {
    const twin: GroupBannedMemberInfo = { ...member('a'), id: 'a-different-row' };
    const pages: BannedMembersPage[] = [
      { page: 1, hasNextPage: true, members: [member('a')] },
      { page: 2, hasNextPage: false, members: [twin] },
    ];
    expect(flattenBannedMembersPages(pages)).toEqual([member('a')]);
  });

  it('does not change the pages it is given', () => {
    const pages = [page(1, ['a', 'b'], true), page(2, ['b', 'c'])];
    const before = JSON.stringify(pages);
    flattenBannedMembersPages(pages);
    expect(JSON.stringify(pages)).toBe(before);
  });

  it('returns an empty array for no pages', () => {
    expect(flattenBannedMembersPages(undefined)).toEqual([]);
    expect(flattenBannedMembersPages([])).toEqual([]);
  });
});

describe('applyUnbannedMember', () => {
  const inbox = (): BannedMembersInbox => ({
    pages: [page(1, ['a', 'b', 'c'], true), page(2, ['d', 'e'])],
    pageParams: [1, 2],
  });

  it('removes that ONE user from whichever page holds them, and nobody else', () => {
    const result = applyUnbannedMember(inbox(), 'd')!;
    expect(result.pages.map((p) => p.members.map((m) => m.user.id))).toEqual([['a', 'b', 'c'], ['e']]);

    const first = applyUnbannedMember(inbox(), 'a')!;
    expect(first.pages.map((p) => p.members.map((m) => m.user.id))).toEqual([['b', 'c'], ['d', 'e']]);
  });

  it('removes the user from EVERY page that lists them (offset paging can repeat a row)', () => {
    const repeated: BannedMembersInbox = { pages: [page(1, ['a', 'b'], true), page(2, ['b', 'c'])], pageParams: [1, 2] };
    const result = applyUnbannedMember(repeated, 'b')!;
    expect(result.pages.map((p) => p.members.map((m) => m.user.id))).toEqual([['a'], ['c']]);
  });

  it('keeps every page, the cursor claims and the page params — only rows change', () => {
    const result = applyUnbannedMember(inbox(), 'a')!;
    expect(result.pageParams).toEqual([1, 2]);
    expect(result.pages.map((p) => [p.page, p.hasNextPage])).toEqual([
      [1, true],
      [2, false],
    ]);
  });

  it('leaves the cache untouched when the user is not in it', () => {
    const result = applyUnbannedMember(inbox(), 'zzz')!;
    expect(result.pages.map((p) => p.members.map((m) => m.user.id))).toEqual([['a', 'b', 'c'], ['d', 'e']]);
  });

  it('does not mutate the cache it was handed', () => {
    const original = inbox();
    const before = JSON.stringify(original);
    applyUnbannedMember(original, 'a');
    expect(JSON.stringify(original)).toBe(before);
  });

  it('returns undefined when nothing is cached, so setQueryData does not write', () => {
    expect(applyUnbannedMember(undefined, 'a')).toBeUndefined();
  });
});

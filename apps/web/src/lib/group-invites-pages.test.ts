import { describe, expect, it } from 'vitest';
import { applyCreatedInvite, applyRevokedInvite, flattenInvitesPages, toInvitesPage } from './group-invites-pages';
import type { InvitesPage } from './group-invites-pages';
import type { InfiniteData } from '@tanstack/react-query';

const inv = (id: string) => ({
  id,
  email: `${id}@test.com`,
  role: 'MEMBER' as const,
  status: 'PENDING' as const,
  token: `tok-${id}`,
  expiresAt: '',
  invitedBy: '',
  createdAt: '',
});

describe('toInvitesPage', () => {
  it('keeps only the server-claimed next-page flag, never trusting meta.page', () => {
    const page = toInvitesPage(
      {
        success: true,
        data: [inv('a')],
        meta: { total: 2, page: 1, limit: 50, totalPages: 2, hasNextPage: true, hasPrevPage: false },
      },
      1
    );
    expect(page).toEqual({ invites: [inv('a')], page: 1, hasNextPage: true });
  });

  it('reads a missing next page as false', () => {
    const page = toInvitesPage({ success: true, data: [inv('a')] }, 2);
    expect(page.hasNextPage).toBe(false);
  });

  it('rejects an unsuccessful body instead of reading it as an empty list', () => {
    expect(() => toInvitesPage({ success: false, error: { code: 'X', message: 'boom' } }, 1)).toThrow('boom');
  });
});

describe('flattenInvitesPages', () => {
  it('flattens pages in order, one row per invite id (deduplicates across page boundaries)', () => {
    const pages: InvitesPage[] = [
      { page: 1, hasNextPage: true, invites: [inv('a'), inv('b')] },
      { page: 2, hasNextPage: false, invites: [inv('b'), inv('c')] },
    ];
    expect(flattenInvitesPages(pages).map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('returns an empty array for no pages', () => {
    expect(flattenInvitesPages(undefined)).toEqual([]);
  });
});

describe('applyCreatedInvite', () => {
  it('prepends the created invite into the first page and preserves the cursor and later pages', () => {
    const data: InfiniteData<InvitesPage, number> = {
      pages: [
        { page: 1, hasNextPage: true, invites: [inv('existing')] },
        { page: 2, hasNextPage: false, invites: [inv('old')] },
      ],
      pageParams: [1, 2],
    };
    const next = applyCreatedInvite(data, inv('new'));
    expect(next?.pages[0].invites.map((i) => i.id)).toEqual(['new', 'existing']);
    expect(next?.pages[1]).toBe(data.pages[1]);
    expect(next?.pageParams).toEqual(data.pageParams);
  });

  it('does not duplicate an invite that is already present in the first page', () => {
    const data: InfiniteData<InvitesPage, number> = {
      pages: [{ page: 1, hasNextPage: false, invites: [inv('dup')] }],
      pageParams: [1],
    };
    const next = applyCreatedInvite(data, inv('dup'));
    expect(next?.pages[0].invites).toHaveLength(1);
  });

  it('gives the invite a page of its own when nothing is cached — a link that exists must be on screen whatever the list query is doing', () => {
    const next = applyCreatedInvite(undefined, inv('x'));
    expect(next.pages).toEqual([{ page: 1, hasNextPage: false, invites: [inv('x')] }]);
    expect(next.pageParams).toEqual([1]);
  });

  it('does the same when the cache holds no pages at all', () => {
    const next = applyCreatedInvite({ pages: [], pageParams: [] }, inv('x'));
    expect(next.pages[0].invites.map((i) => i.id)).toEqual(['x']);
    expect(next.pageParams).toEqual([1]);
  });

  it('does not mutate what it was given', () => {
    const data: InfiniteData<InvitesPage, number> = {
      pages: [{ page: 1, hasNextPage: true, invites: [inv('a')] }],
      pageParams: [1],
    };
    applyCreatedInvite(data, inv('new'));
    expect(data.pages[0].invites.map((i) => i.id)).toEqual(['a']);
  });
});

describe('applyRevokedInvite', () => {
  const data = (): InfiniteData<InvitesPage, number> => ({
    pages: [
      { page: 1, hasNextPage: true, invites: [inv('a'), inv('b')] },
      { page: 2, hasNextPage: false, invites: [inv('c')] },
    ],
    pageParams: [1, 2],
  });

  it('takes the invite out of the page it is on, keeping every page and the cursor', () => {
    const before = data();
    const next = applyRevokedInvite(before, 'c')!;
    expect(next.pages.map((p) => p.invites.map((i) => i.id))).toEqual([['a', 'b'], []]);
    expect(next.pages.map((p) => p.hasNextPage)).toEqual([true, false]);
    expect(next.pageParams).toEqual([1, 2]);
    expect(before.pages[1].invites).toHaveLength(1); // input untouched
  });

  it('removes it from every page it appears on', () => {
    const dup: InfiniteData<InvitesPage, number> = {
      pages: [
        { page: 1, hasNextPage: true, invites: [inv('a'), inv('b')] },
        { page: 2, hasNextPage: false, invites: [inv('b')] },
      ],
      pageParams: [1, 2],
    };
    expect(applyRevokedInvite(dup, 'b')!.pages.flatMap((p) => p.invites).map((i) => i.id)).toEqual(['a']);
  });

  it('returns undefined when nothing is cached, so setQueryData will not write', () => {
    expect(applyRevokedInvite(undefined, 'a')).toBeUndefined();
  });
});

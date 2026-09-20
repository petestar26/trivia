import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  GroupDetailFull,
  GroupDetailInfo,
  GroupDetailSummary,
  GroupInvitePreview,
  GroupMembershipStatus,
  GroupRole,
} from '@socialplay/shared';

// GET /groups/:id answers in TWO shapes. The shared type models them
// explicitly so a client cannot read a field one shape never has as though it
// were always there. These assertions are checked by `tsc` (the web typecheck):
// vitest strips types, so a wrong model fails the typecheck, not the run.

const summary: GroupDetailSummary = {
  id: 'g1',
  name: 'Secret Club',
  description: null,
  imageUrl: null,
  coverUrl: null,
  isPrivate: true,
  status: 'ACTIVE',
  memberCount: 4,
  isMember: false,
  memberRole: null,
  viewerMembershipStatus: 'PENDING',
  requestStatus: 'PENDING',
  owner: null,
};

const full: GroupDetailFull = {
  id: 'g2',
  name: 'Open Club',
  description: 'hello',
  imageUrl: null,
  coverUrl: null,
  isPrivate: false,
  status: 'ACTIVE',
  memberCount: 10,
  isMember: true,
  memberRole: 'ADMIN',
  viewerMembershipStatus: 'ACTIVE',
  owner: { id: 'u1', username: 'own', displayName: null, avatarUrl: null },
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-02T00:00:00.000Z',
};

describe('GroupDetailInfo — safe summary vs full detail', () => {
  it('the safe summary has a null memberRole and owner and NO dates', () => {
    expectTypeOf(summary.memberRole).toEqualTypeOf<null>();
    expectTypeOf(summary.owner).toEqualTypeOf<null>();
    expectTypeOf(summary.createdAt).toEqualTypeOf<undefined>();
    expectTypeOf(summary.updatedAt).toEqualTypeOf<undefined>();
    expectTypeOf(summary.isPrivate).toEqualTypeOf<true>();
    expectTypeOf(summary.isMember).toEqualTypeOf<false>();
    expect(summary).not.toHaveProperty('createdAt');
  });

  it('full detail always has both dates, and memberRole is a role or an explicit null — never absent', () => {
    expectTypeOf(full.createdAt).toEqualTypeOf<string>();
    expectTypeOf(full.updatedAt).toEqualTypeOf<string>();
    expectTypeOf(full.memberRole).toEqualTypeOf<GroupRole | null>();
    expectTypeOf(full.requestStatus).toEqualTypeOf<undefined>();
  });

  it('a field either shape may not have reads as possibly-undefined from the union, never as always present', () => {
    const anyDetail = full as GroupDetailInfo;
    expectTypeOf(anyDetail.createdAt).toEqualTypeOf<string | undefined>();
    expectTypeOf(anyDetail.requestStatus).toEqualTypeOf<GroupMembershipStatus | null | undefined>();
    expectTypeOf(anyDetail.memberRole).toEqualTypeOf<GroupRole | null>();
    expectTypeOf(anyDetail.viewerMembershipStatus).toEqualTypeOf<GroupMembershipStatus | null>();
  });

  it('rejects mis-modelled responses at compile time', () => {
    // @ts-expect-error the safe summary carries no dates
    const withDates: GroupDetailSummary = { ...summary, createdAt: '2024-01-01T00:00:00.000Z' };
    // @ts-expect-error a summary never names an owner
    const withOwner: GroupDetailSummary = { ...summary, owner: full.owner };
    // @ts-expect-error memberRole may be null but is never omitted
    const missingRole: GroupDetailFull = { ...full, memberRole: undefined };
    // @ts-expect-error full detail needs its dates
    const missingDate: GroupDetailFull = { ...full, createdAt: undefined };
    // @ts-expect-error not a real membership status
    const badStatus: GroupMembershipStatus = 'SUSPENDED';
    expect([withDates, withOwner, missingRole, missingDate, badStatus]).toHaveLength(5);
  });

  it('the invite preview carries no email or token, and its status is the EFFECTIVE one', () => {
    const preview: GroupInvitePreview = {
      id: 'i1',
      group: { id: 'g1', name: 'Club', isPrivate: true },
      status: 'EXPIRED',
      expiresAt: '2024-01-01T00:00:00.000Z',
    };
    expectTypeOf(preview).not.toHaveProperty('email');
    expectTypeOf(preview).not.toHaveProperty('token');
    expect(preview.status).toBe('EXPIRED');
  });
});

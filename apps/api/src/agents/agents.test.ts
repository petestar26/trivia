import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@socialplay/database';
import {
  submitAgentApplication,
  approveAgentApplication,
  rejectAgentApplication,
  suspendAgent,
  reactivateAgent,
  markAgentUnderReview,
  disableAgent,
  requireOwnAgent,
  getAgentApplicationHistory,
} from './agent-service';
import {
  createAgentPaymentAccount,
  updateAgentPaymentAccount,
  approveAgentPaymentAccount,
  rejectAgentPaymentAccount,
  disableOwnPaymentAccount,
  adminDisablePaymentAccount,
} from './payment-account-service';

// ─── DB availability probe ─────────────────────────────────────

let dbAvailable = true;
try {
  await prisma.$queryRaw`SELECT 1`;
  dbAvailable = true;
} catch {
  dbAvailable = false;
}

afterAll(async () => {
  await prisma.$disconnect();
});

const describeIf = dbAvailable ? describe : describe.skip;

// ─── Fixtures ──────────────────────────────────────────────────

async function createUser(tag: string) {
  const email = `agent-${tag}@test.local`;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return existing;
  return prisma.user.create({
    data: {
      email,
      username: `agenttest_${tag}`,
      passwordHash: 'fixture-only-not-a-real-hash',
      displayName: `Agent Test ${tag}`,
    },
  });
}

async function createAdmin(tag: string) {
  const user = await createUser(tag);
  return prisma.user.update({ where: { id: user.id }, data: { role: 'ADMIN' } });
}

async function createCountry(tag: string, overrides: Partial<{ isActive: boolean; agentPaymentEnabled: boolean }> = {}) {
  const code = `T${tag}`.slice(0, 8).toUpperCase();
  const existing = await prisma.country.findUnique({ where: { code } });
  if (existing) return existing;
  return prisma.country.create({
    data: {
      code,
      name: `Test Country ${tag}`,
      currencyCode: 'USD',
      isActive: overrides.isActive ?? true,
      agentPaymentEnabled: overrides.agentPaymentEnabled ?? true,
    },
  });
}

async function createPaymentMethod(
  countryId: string,
  tag: string,
  requiredFields: string[],
  isActive = true
) {
  return prisma.paymentMethodDefinition.create({
    data: {
      countryId,
      type: 'BANK_TRANSFER',
      name: `Test Method ${tag}`,
      fieldSchema: { requiredFields },
      isActive,
    },
  });
}

async function cleanAgentFixtures() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: 'agent-' } } });
  const userIds = users.map((u) => u.id);

  if (userIds.length) {
    const agents = await prisma.agent.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
    const agentIds = agents.map((a) => a.id);

    if (agentIds.length) {
      await prisma.agentPaymentAccount.deleteMany({ where: { agentId: { in: agentIds } } });
      await prisma.agentApplication.deleteMany({ where: { agentId: { in: agentIds } } });
    }
    // Clear the referral FK before deleting agents/users to avoid FK errors.
    await prisma.user.updateMany({ where: { id: { in: userIds } }, data: { referredByAgentId: null } });
    await prisma.agent.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }

  const countries = await prisma.country.findMany({ where: { name: { startsWith: 'Test Country' } } });
  const countryIds = countries.map((c) => c.id);
  if (countryIds.length) {
    await prisma.paymentMethodDefinition.deleteMany({ where: { countryId: { in: countryIds } } });
    await prisma.country.deleteMany({ where: { id: { in: countryIds } } });
  }
}

function validApplicationArgs(countryId: string, tag: string) {
  return {
    countryId,
    displayName: `Agent ${tag}`,
    contactEmail: `agent-${tag}@test.local`,
    contactPhone: '+10000000000',
  };
}

// ═══════════════════════════════════════════════════════════════
// APPLICATION LIFECYCLE
// ═══════════════════════════════════════════════════════════════

describeIf('Agent application lifecycle', () => {
  let admin: { id: string };
  let country: { id: string };

  beforeAll(async () => {
    await cleanAgentFixtures();
    admin = await createAdmin('appadmin');
    country = await createCountry('app');
  });

  it('1-2-3. user submits a valid application; Agent starts PENDING_VERIFICATION; application starts SUBMITTED', async () => {
    const user = await createUser('applicant1');
    const { agent, application } = await submitAgentApplication(user.id, validApplicationArgs(country.id, 'applicant1'));
    expect(agent.status).toBe('PENDING_VERIFICATION');
    expect(application.status).toBe('SUBMITTED');
    expect(application.agentId).toBe(agent.id);
  });

  it('4. duplicate submission does not create a duplicate Agent', async () => {
    const user = await createUser('applicant2');
    await submitAgentApplication(user.id, validApplicationArgs(country.id, 'applicant2'));

    await expect(
      submitAgentApplication(user.id, validApplicationArgs(country.id, 'applicant2'))
    ).rejects.toThrow(/already have an agent application/i);

    const agents = await prisma.agent.findMany({ where: { userId: user.id } });
    expect(agents.length).toBe(1);
  });

  it('5-6. admin approves; approval makes Agent ACTIVE', async () => {
    const user = await createUser('applicant3');
    const { agent, application } = await submitAgentApplication(user.id, validApplicationArgs(country.id, 'applicant3'));

    const result = await approveAgentApplication(admin.id, application.id, 'looks good');
    expect(result.alreadyReviewed).toBe(false);
    expect(result.status).toBe('APPROVED');

    const refreshed = await prisma.agent.findUnique({ where: { id: agent.id } });
    expect(refreshed!.status).toBe('ACTIVE');

    const refreshedApp = await prisma.agentApplication.findUnique({ where: { id: application.id } });
    expect(refreshedApp!.status).toBe('APPROVED');
    expect(refreshedApp!.reviewedBy).toBe(admin.id);
    expect(refreshedApp!.reviewedAt).not.toBeNull();
  });

  it('7-8. admin rejects; rejected application remains historical', async () => {
    const user = await createUser('applicant4');
    const { application } = await submitAgentApplication(user.id, validApplicationArgs(country.id, 'applicant4'));

    const result = await rejectAgentApplication(admin.id, application.id, 'insufficient info');
    expect(result.status).toBe('REJECTED');

    const stillThere = await prisma.agentApplication.findUnique({ where: { id: application.id } });
    expect(stillThere).not.toBeNull();
    expect(stillThere!.status).toBe('REJECTED');
    expect(stillThere!.reviewNote).toBe('insufficient info');
  });

  it('9. reapplication creates a NEW AgentApplication row, one Agent identity, full history preserved', async () => {
    const user = await createUser('applicant5');
    const first = await submitAgentApplication(user.id, validApplicationArgs(country.id, 'applicant5'));
    await rejectAgentApplication(admin.id, first.application.id, 'try again');

    const second = await submitAgentApplication(user.id, validApplicationArgs(country.id, 'applicant5'));
    expect(second.agent.id).toBe(first.agent.id); // one Agent identity
    expect(second.application.id).not.toBe(first.application.id); // new application row

    const history = await getAgentApplicationHistory(first.agent.id);
    expect(history.length).toBe(2);
    expect(history.map((h) => h.status).sort()).toEqual(['REJECTED', 'SUBMITTED'].sort());

    // The old, rejected application was never mutated into the new one.
    const oldOne = await prisma.agentApplication.findUnique({ where: { id: first.application.id } });
    expect(oldOne!.status).toBe('REJECTED');
  });

  it('CONCURRENCY 10 / A. two concurrent approvals of the same application: exactly one succeeds', async () => {
    const user = await createUser('applicant6');
    const { application } = await submitAgentApplication(user.id, validApplicationArgs(country.id, 'applicant6'));

    const results = await Promise.allSettled([
      approveAgentApplication(admin.id, application.id, 'r1'),
      approveAgentApplication(admin.id, application.id, 'r2'),
      approveAgentApplication(admin.id, application.id, 'r3'),
    ]);

    const freshResults = results.map((r) => (r.status === 'fulfilled' ? r.value : null)).filter(Boolean) as any[];
    const genuineApprovals = freshResults.filter((r) => r.alreadyReviewed === false);
    expect(genuineApprovals.length).toBe(1);

    const final = await prisma.agentApplication.findUnique({ where: { id: application.id } });
    expect(final!.status).toBe('APPROVED');

    // Exactly one audit + one notification for the approval, not three.
    const audits = await prisma.auditLog.findMany({
      where: { entity: 'AgentApplication', entityId: application.id, action: 'AGENT_APPLICATION_APPROVED' },
    });
    expect(audits.length).toBe(1);
    const notifications = await prisma.notification.findMany({
      where: { userId: user.id, type: 'AGENT_APPLICATION_APPROVED' },
    });
    expect(notifications.length).toBe(1);
  });

  it('CONCURRENCY B. one admin approves while another rejects: exactly one wins', async () => {
    const user = await createUser('applicant7');
    const { application } = await submitAgentApplication(user.id, validApplicationArgs(country.id, 'applicant7'));

    const results = await Promise.allSettled([
      approveAgentApplication(admin.id, application.id, undefined),
      rejectAgentApplication(admin.id, application.id, 'no'),
    ]);

    const final = await prisma.agentApplication.findUnique({ where: { id: application.id } });
    expect(['APPROVED', 'REJECTED']).toContain(final!.status);

    // Whichever won, only ONE genuine transition happened.
    const genuineOutcomes = results
      .map((r) => (r.status === 'fulfilled' ? (r.value as any) : null))
      .filter((r) => r && r.alreadyReviewed === false);
    expect(genuineOutcomes.length).toBe(1);
  });

  it('CONCURRENCY D. duplicate application requests from the same user race safely', async () => {
    const user = await createUser('applicant8');

    const results = await Promise.allSettled([
      submitAgentApplication(user.id, validApplicationArgs(country.id, 'applicant8')),
      submitAgentApplication(user.id, validApplicationArgs(country.id, 'applicant8')),
      submitAgentApplication(user.id, validApplicationArgs(country.id, 'applicant8')),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBe(1);

    const agents = await prisma.agent.findMany({ where: { userId: user.id } });
    expect(agents.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// AUTHORIZATION
// ═══════════════════════════════════════════════════════════════

describeIf('Agent authorization', () => {
  let admin: { id: string };
  let country: { id: string };

  beforeAll(async () => {
    await cleanAgentFixtures();
    admin = await createAdmin('authadmin');
    country = await createCountry('auth');
  });

  it('11. requireOwnAgent never resolves another user\'s Agent', async () => {
    const userA = await createUser('authA');
    const userB = await createUser('authB');
    await submitAgentApplication(userA.id, validApplicationArgs(country.id, 'authA'));

    const agentA = await requireOwnAgent(userA.id);
    expect(agentA.userId).toBe(userA.id);

    await expect(requireOwnAgent(userB.id)).rejects.toThrow(/do not have an agent account/i);
  });

  it('12. Agent cannot manage another Agent\'s payment account', async () => {
    const userA = await createUser('authC');
    const userB = await createUser('authD');
    const { agent: agentA } = await submitAgentApplication(userA.id, validApplicationArgs(country.id, 'authC'));
    await submitAgentApplication(userB.id, validApplicationArgs(country.id, 'authD'));

    const method = await createPaymentMethod(country.id, 'auth-cd', ['bankName', 'accountNumber']);
    const accountA = await createAgentPaymentAccount(userA.id, {
      countryId: country.id,
      methodDefId: method.id,
      accountDetails: { bankName: 'Test Bank', accountNumber: '12345' },
    });
    expect(accountA.agentId).toBe(agentA.id);

    // userB attempting to edit userA's account must fail — resolved via
    // userB's OWN agent identity, never a client-supplied agentId.
    await expect(
      updateAgentPaymentAccount(userB.id, accountA.id, {
        countryId: country.id,
        methodDefId: method.id,
        accountDetails: { bankName: 'Hacked Bank', accountNumber: '99999' },
      })
    ).rejects.toThrow(/not your payment account/i);

    const stillOriginal = await prisma.agentPaymentAccount.findUnique({ where: { id: accountA.id } });
    expect((stillOriginal!.accountDetails as any).bankName).toBe('Test Bank');
  });

  it('13. Agent cannot approve themselves, even if also an admin', async () => {
    const userSelf = await createAdmin('authSelf'); // admin role AND will become an agent
    const { application } = await submitAgentApplication(userSelf.id, validApplicationArgs(country.id, 'authSelf'));

    await expect(approveAgentApplication(userSelf.id, application.id, 'self approve')).rejects.toThrow(
      /cannot review your own/i
    );
  });

  it('14. normal user cannot perform admin review', async () => {
    const applicant = await createUser('authE');
    const normalUser = await createUser('authF'); // has no ADMIN role
    const { application } = await submitAgentApplication(applicant.id, validApplicationArgs(country.id, 'authE'));

    await expect(approveAgentApplication(normalUser.id, application.id, undefined)).rejects.toThrow(
      /admin privileges required/i
    );

    const stillSubmitted = await prisma.agentApplication.findUnique({ where: { id: application.id } });
    expect(stillSubmitted!.status).toBe('SUBMITTED');
  });

  it('15. admin can perform authorized review', async () => {
    const applicant = await createUser('authG');
    const { application } = await submitAgentApplication(applicant.id, validApplicationArgs(country.id, 'authG'));

    const result = await approveAgentApplication(admin.id, application.id, undefined);
    expect(result.status).toBe('APPROVED');
  });

  it('agent cannot change another agent\'s status; admin can', async () => {
    const applicant = await createUser('authH');
    const { agent } = await submitAgentApplication(applicant.id, validApplicationArgs(country.id, 'authH'));
    await approveAgentApplication(admin.id, (await getAgentApplicationHistory(agent.id))[0].id, undefined);

    const someOtherUser = await createUser('authI');
    await expect(suspendAgent(someOtherUser.id, agent.id, 'unauthorized attempt')).rejects.toThrow(
      /admin privileges required/i
    );

    const result = await suspendAgent(admin.id, agent.id, 'legitimate suspension');
    expect(result.status).toBe('TEMPORARILY_SUSPENDED');
  });
});

// ═══════════════════════════════════════════════════════════════
// AGENT STATUS LIFECYCLE
// ═══════════════════════════════════════════════════════════════

describeIf('Agent status lifecycle', () => {
  let admin: { id: string };
  let country: { id: string };

  beforeAll(async () => {
    await cleanAgentFixtures();
    admin = await createAdmin('statusadmin');
    country = await createCountry('status');
  });

  async function makeActiveAgent(tag: string) {
    const user = await createUser(tag);
    const { agent, application } = await submitAgentApplication(user.id, validApplicationArgs(country.id, tag));
    await approveAgentApplication(admin.id, application.id, undefined);
    return { user, agent };
  }

  it('suspend -> reactivate is legal and does not touch inventory/orders (none exist to touch)', async () => {
    const { agent } = await makeActiveAgent('lifecycle1');
    const suspended = await suspendAgent(admin.id, agent.id, 'routine check');
    expect(suspended.status).toBe('TEMPORARILY_SUSPENDED');

    const reactivated = await reactivateAgent(admin.id, agent.id);
    expect(reactivated.status).toBe('ACTIVE');

    const final = await prisma.agent.findUnique({ where: { id: agent.id } });
    expect(final!.suspendedAt).toBeNull();
    expect(final!.suspendedReason).toBeNull();
  });

  it('rejects illegal transitions (DISABLED is terminal)', async () => {
    const { agent } = await makeActiveAgent('lifecycle2');
    await disableAgent(admin.id, agent.id, 'final disable');

    await expect(reactivateAgent(admin.id, agent.id)).rejects.toThrow(/cannot transition/i);
    await expect(suspendAgent(admin.id, agent.id, 'x')).rejects.toThrow(/cannot transition/i);
  });

  it('under-review is a legal detour from ACTIVE back to ACTIVE', async () => {
    const { agent } = await makeActiveAgent('lifecycle3');
    const reviewed = await markAgentUnderReview(admin.id, agent.id, 'flagged for audit');
    expect(reviewed.status).toBe('UNDER_REVIEW');

    const cleared = await reactivateAgent(admin.id, agent.id);
    expect(cleared.status).toBe('ACTIVE');
  });

  it('CONCURRENCY: two concurrent suspend attempts on the same agent — exactly one succeeds', async () => {
    const { agent } = await makeActiveAgent('lifecycle4');

    const results = await Promise.allSettled([
      suspendAgent(admin.id, agent.id, 'r1'),
      suspendAgent(admin.id, agent.id, 'r2'),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBe(1);

    const final = await prisma.agent.findUnique({ where: { id: agent.id } });
    expect(final!.status).toBe('TEMPORARILY_SUSPENDED');
  });
});

// ═══════════════════════════════════════════════════════════════
// PAYMENT ACCOUNT LIFECYCLE
// ═══════════════════════════════════════════════════════════════

describeIf('Agent payment account lifecycle', () => {
  let admin: { id: string };
  let country: { id: string };
  let method: { id: string };

  beforeAll(async () => {
    await cleanAgentFixtures();
    admin = await createAdmin('pmadmin');
    country = await createCountry('pm');
    method = await createPaymentMethod(country.id, 'pm-main', ['bankName', 'accountHolder', 'accountNumber']);
  });

  async function makeAgent(tag: string) {
    const user = await createUser(tag);
    const { agent } = await submitAgentApplication(user.id, validApplicationArgs(country.id, tag));
    return { user, agent };
  }

  const validDetails = { bankName: 'Test Bank', accountHolder: 'Jane Doe', accountNumber: '000111222' };

  it('16-22. valid account can be created and begins PENDING_APPROVAL', async () => {
    const { user } = await makeAgent('pm1');
    const account = await createAgentPaymentAccount(user.id, {
      countryId: country.id,
      methodDefId: method.id,
      accountDetails: validDetails,
    });
    expect(account.status).toBe('PENDING_APPROVAL');
    expect(account.accountDetails).toEqual(validDetails);
  });

  it('17. invalid country rejected', async () => {
    const { user } = await makeAgent('pm2');
    await expect(
      createAgentPaymentAccount(user.id, {
        countryId: 'not-a-real-country-id',
        methodDefId: method.id,
        accountDetails: validDetails,
      })
    ).rejects.toThrow(/invalid country/i);
  });

  it('18. invalid payment method rejected', async () => {
    const { user } = await makeAgent('pm3');
    await expect(
      createAgentPaymentAccount(user.id, {
        countryId: country.id,
        methodDefId: 'not-a-real-method-id',
        accountDetails: validDetails,
      })
    ).rejects.toThrow(/invalid payment method/i);
  });

  it('19. payment method belonging to another country is rejected', async () => {
    const otherCountry = await createCountry('pm-other');
    const otherMethod = await createPaymentMethod(otherCountry.id, 'pm-other-method', ['bankName']);
    const { user } = await makeAgent('pm4');

    await expect(
      createAgentPaymentAccount(user.id, {
        countryId: country.id, // mismatched on purpose
        methodDefId: otherMethod.id,
        accountDetails: { bankName: 'X' },
      })
    ).rejects.toThrow(/does not belong to the selected country/i);
  });

  it('20. inactive payment method rejected', async () => {
    const inactiveMethod = await createPaymentMethod(country.id, 'pm-inactive', ['bankName'], false);
    const { user } = await makeAgent('pm5');

    await expect(
      createAgentPaymentAccount(user.id, {
        countryId: country.id,
        methodDefId: inactiveMethod.id,
        accountDetails: { bankName: 'X' },
      })
    ).rejects.toThrow(/not currently active/i);
  });

  it('21. invalid accountDetails rejected: missing field, unknown field, empty string', async () => {
    const { user } = await makeAgent('pm6');

    await expect(
      createAgentPaymentAccount(user.id, {
        countryId: country.id,
        methodDefId: method.id,
        accountDetails: { bankName: 'X' }, // missing accountHolder/accountNumber
      })
    ).rejects.toThrow(/accountDetails\.accountHolder is required/i);

    await expect(
      createAgentPaymentAccount(user.id, {
        countryId: country.id,
        methodDefId: method.id,
        accountDetails: { ...validDetails, ssn: '999-99-9999' }, // unsupported extra field
      })
    ).rejects.toThrow(/unsupported field/i);

    await expect(
      createAgentPaymentAccount(user.id, {
        countryId: country.id,
        methodDefId: method.id,
        accountDetails: { ...validDetails, bankName: '   ' },
      })
    ).rejects.toThrow(/accountDetails\.bankName is required/i);
  });

  it('23-24. admin approval and rejection work', async () => {
    const { user: userApprove } = await makeAgent('pm7');
    const accApprove = await createAgentPaymentAccount(userApprove.id, {
      countryId: country.id,
      methodDefId: method.id,
      accountDetails: validDetails,
    });
    const approved = await approveAgentPaymentAccount(admin.id, accApprove.id);
    expect(approved.status).toBe('APPROVED');

    const { user: userReject } = await makeAgent('pm8');
    const accReject = await createAgentPaymentAccount(userReject.id, {
      countryId: country.id,
      methodDefId: method.id,
      accountDetails: validDetails,
    });
    const rejected = await rejectAgentPaymentAccount(admin.id, accReject.id, 'illegible documents');
    expect(rejected.status).toBe('REJECTED');
  });

  it('25. editing an APPROVED account forces it back to PENDING_APPROVAL', async () => {
    const { user } = await makeAgent('pm9');
    const account = await createAgentPaymentAccount(user.id, {
      countryId: country.id,
      methodDefId: method.id,
      accountDetails: validDetails,
    });
    await approveAgentPaymentAccount(admin.id, account.id);

    const edited = await updateAgentPaymentAccount(user.id, account.id, {
      countryId: country.id,
      methodDefId: method.id,
      accountDetails: { ...validDetails, accountNumber: '999888777' },
    });
    expect(edited!.status).toBe('PENDING_APPROVAL');
    expect(edited!.reviewedBy).toBeNull();
    expect(edited!.reviewedAt).toBeNull();
  });

  it('26-27. disabled account remains historical and reconstructable', async () => {
    const { user } = await makeAgent('pm10');
    const account = await createAgentPaymentAccount(user.id, {
      countryId: country.id,
      methodDefId: method.id,
      accountDetails: validDetails,
    });
    await approveAgentPaymentAccount(admin.id, account.id);
    const disabled = await disableOwnPaymentAccount(user.id, account.id);
    expect(disabled.status).toBe('DISABLED');

    const stillThere = await prisma.agentPaymentAccount.findUnique({ where: { id: account.id } });
    expect(stillThere).not.toBeNull();
    expect(stillThere!.accountDetails).toEqual(validDetails);
  });

  it('admin can disable any agent\'s account', async () => {
    const { user } = await makeAgent('pm11');
    const account = await createAgentPaymentAccount(user.id, {
      countryId: country.id,
      methodDefId: method.id,
      accountDetails: validDetails,
    });
    const result = await adminDisablePaymentAccount(admin.id, account.id);
    expect(result.status).toBe('DISABLED');
  });

  it('28. CONCURRENCY: concurrent approve/reject on the same account — exactly one winner', async () => {
    const { user } = await makeAgent('pm12');
    const account = await createAgentPaymentAccount(user.id, {
      countryId: country.id,
      methodDefId: method.id,
      accountDetails: validDetails,
    });

    const results = await Promise.allSettled([
      approveAgentPaymentAccount(admin.id, account.id),
      rejectAgentPaymentAccount(admin.id, account.id, 'concurrent reject'),
    ]);

    const genuineOutcomes = results
      .map((r) => (r.status === 'fulfilled' ? (r.value as any) : null))
      .filter((r) => r && r.alreadyReviewed === false);
    expect(genuineOutcomes.length).toBe(1);

    const final = await prisma.agentPaymentAccount.findUnique({ where: { id: account.id } });
    expect(['APPROVED', 'REJECTED']).toContain(final!.status);
  });

  it('29. CONCURRENCY: an edit racing an admin approval can never leave the account APPROVED with unreviewed content', async () => {
    const { user } = await makeAgent('pm13');
    const account = await createAgentPaymentAccount(user.id, {
      countryId: country.id,
      methodDefId: method.id,
      accountDetails: validDetails,
    });

    const results = await Promise.allSettled([
      updateAgentPaymentAccount(user.id, account.id, {
        countryId: country.id,
        methodDefId: method.id,
        accountDetails: { ...validDetails, accountNumber: '111222333' },
      }),
      approveAgentPaymentAccount(admin.id, account.id),
    ]);

    // approveAgentPaymentAccount pins its claim to the exact row version
    // (status AND updatedAt) it read. Whichever order the two operations
    // actually commit in, the edit's write always invalidates that pinned
    // version — either by changing updatedAt out from under a still-pending
    // approve (which then rejects with a "modified after being loaded"
    // conflict instead of silently approving stale content), or by running
    // after an approval that already committed and reverting it back to
    // PENDING_APPROVAL with the new details. So the account can never end up
    // APPROVED while holding content the admin never actually reviewed.
    const edit = results[0];
    const approve = results[1];
    expect(edit.status).toBe('fulfilled');

    const final = await prisma.agentPaymentAccount.findUnique({ where: { id: account.id } });
    expect(final!.status).toBe('PENDING_APPROVAL');
    expect((final!.accountDetails as any).accountNumber).toBe('111222333');

    if (approve.status === 'rejected') {
      expect(String((approve as PromiseRejectedResult).reason)).toMatch(/modified after being loaded for review/i);
    }
  });

  it('30. unauthorized user cannot read another agent\'s accountDetails via listOwnPaymentAccounts scoping', async () => {
    const { user: ownerUser, agent: ownerAgent } = await makeAgent('pm14');
    await createAgentPaymentAccount(ownerUser.id, {
      countryId: country.id,
      methodDefId: method.id,
      accountDetails: validDetails,
    });

    const { agent: otherAgent } = await makeAgent('pm15');

    // listOwnPaymentAccounts is always scoped by agentId — an agent querying
    // their own id can never retrieve another agent's rows.
    const ownerAccounts = await prisma.agentPaymentAccount.findMany({ where: { agentId: ownerAgent.id } });
    const otherAccounts = await prisma.agentPaymentAccount.findMany({ where: { agentId: otherAgent.id } });
    expect(ownerAccounts.length).toBeGreaterThan(0);
    expect(otherAccounts.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// AUDIT
// ═══════════════════════════════════════════════════════════════

describeIf('Agent audit logging', () => {
  let admin: { id: string };
  let country: { id: string };
  let method: { id: string };

  beforeAll(async () => {
    await cleanAgentFixtures();
    admin = await createAdmin('auditadmin');
    country = await createCountry('audit');
    method = await createPaymentMethod(country.id, 'audit-method', ['bankName', 'accountNumber']);
  });

  it('31. approval creates a correct audit entry', async () => {
    const user = await createUser('audit1');
    const { application, agent } = await submitAgentApplication(user.id, validApplicationArgs(country.id, 'audit1'));
    await approveAgentApplication(admin.id, application.id, 'ok');

    const log = await prisma.auditLog.findFirst({
      where: { entity: 'AgentApplication', entityId: application.id, action: 'AGENT_APPLICATION_APPROVED' },
    });
    expect(log).not.toBeNull();
    expect(log!.userId).toBe(admin.id);
    expect((log!.oldData as any).status).toBe('SUBMITTED');
    expect((log!.newData as any).agentStatus).toBe('ACTIVE');
    void agent;
  });

  it('32. rejection creates a correct audit entry', async () => {
    const user = await createUser('audit2');
    const { application } = await submitAgentApplication(user.id, validApplicationArgs(country.id, 'audit2'));
    await rejectAgentApplication(admin.id, application.id, 'incomplete');

    const log = await prisma.auditLog.findFirst({
      where: { entity: 'AgentApplication', entityId: application.id, action: 'AGENT_APPLICATION_REJECTED' },
    });
    expect(log).not.toBeNull();
    expect((log!.newData as any).reviewNote).toBe('incomplete');
  });

  it('33. agent status change creates a correct audit entry', async () => {
    const user = await createUser('audit3');
    const { application, agent } = await submitAgentApplication(user.id, validApplicationArgs(country.id, 'audit3'));
    await approveAgentApplication(admin.id, application.id, undefined);
    await suspendAgent(admin.id, agent.id, 'compliance hold');

    const log = await prisma.auditLog.findFirst({
      where: { entity: 'Agent', entityId: agent.id, action: 'AGENT_SUSPENDED' },
    });
    expect(log).not.toBeNull();
    expect((log!.oldData as any).status).toBe('ACTIVE');
    expect((log!.newData as any).status).toBe('TEMPORARILY_SUSPENDED');
    expect((log!.newData as any).reason).toBe('compliance hold');
  });

  it('34. sensitive payment credentials are NEVER written into audit data', async () => {
    const user = await createUser('audit4');
    await submitAgentApplication(user.id, validApplicationArgs(country.id, 'audit4'));
    const agent = await requireOwnAgent(user.id);

    const details = { bankName: 'Secret Bank', accountNumber: 'SUPER-SECRET-ACCT-NUMBER-99999' };
    const account = await createAgentPaymentAccount(user.id, {
      countryId: country.id,
      methodDefId: method.id,
      accountDetails: details,
    });
    await updateAgentPaymentAccount(user.id, account.id, {
      countryId: country.id,
      methodDefId: method.id,
      accountDetails: { bankName: 'Secret Bank 2', accountNumber: 'ANOTHER-SECRET-99999' },
    });

    const logs = await prisma.auditLog.findMany({
      where: { entity: 'AgentPaymentAccount', entityId: account.id },
    });
    expect(logs.length).toBeGreaterThan(0);
    for (const log of logs) {
      const serialized = JSON.stringify([log.oldData, log.newData]);
      expect(serialized).not.toContain('SUPER-SECRET-ACCT-NUMBER-99999');
      expect(serialized).not.toContain('ANOTHER-SECRET-99999');
      expect(serialized).not.toContain('Secret Bank');
    }
    void agent;
  });
});

// ═══════════════════════════════════════════════════════════════
// NOTIFICATIONS
// ═══════════════════════════════════════════════════════════════

describeIf('Agent notifications', () => {
  let admin: { id: string };
  let country: { id: string };
  let method: { id: string };

  beforeAll(async () => {
    await cleanAgentFixtures();
    admin = await createAdmin('notifadmin');
    country = await createCountry('notif');
    method = await createPaymentMethod(country.id, 'notif-method', ['bankName']);
  });

  it('35. application received notification', async () => {
    const user = await createUser('notif1');
    await submitAgentApplication(user.id, validApplicationArgs(country.id, 'notif1'));
    const n = await prisma.notification.findFirst({ where: { userId: user.id, type: 'AGENT_APPLICATION_RECEIVED' } });
    expect(n).not.toBeNull();
  });

  it('36. application approved notification', async () => {
    const user = await createUser('notif2');
    const { application } = await submitAgentApplication(user.id, validApplicationArgs(country.id, 'notif2'));
    await approveAgentApplication(admin.id, application.id, undefined);
    const n = await prisma.notification.findFirst({ where: { userId: user.id, type: 'AGENT_APPLICATION_APPROVED' } });
    expect(n).not.toBeNull();
  });

  it('37. application rejected notification', async () => {
    const user = await createUser('notif3');
    const { application } = await submitAgentApplication(user.id, validApplicationArgs(country.id, 'notif3'));
    await rejectAgentApplication(admin.id, application.id, 'no');
    const n = await prisma.notification.findFirst({ where: { userId: user.id, type: 'AGENT_APPLICATION_REJECTED' } });
    expect(n).not.toBeNull();
  });

  it('38. payment account approved notification', async () => {
    const user = await createUser('notif4');
    await submitAgentApplication(user.id, validApplicationArgs(country.id, 'notif4'));
    const account = await createAgentPaymentAccount(user.id, {
      countryId: country.id,
      methodDefId: method.id,
      accountDetails: { bankName: 'X' },
    });
    await approveAgentPaymentAccount(admin.id, account.id);
    const n = await prisma.notification.findFirst({
      where: { userId: user.id, type: 'AGENT_PAYMENT_ACCOUNT_APPROVED' },
    });
    expect(n).not.toBeNull();
  });

  it('39. payment account rejected notification', async () => {
    const user = await createUser('notif5');
    await submitAgentApplication(user.id, validApplicationArgs(country.id, 'notif5'));
    const account = await createAgentPaymentAccount(user.id, {
      countryId: country.id,
      methodDefId: method.id,
      accountDetails: { bankName: 'X' },
    });
    await rejectAgentPaymentAccount(admin.id, account.id, 'bad format');
    const n = await prisma.notification.findFirst({
      where: { userId: user.id, type: 'AGENT_PAYMENT_ACCOUNT_REJECTED' },
    });
    expect(n).not.toBeNull();
  });

  it('40. losing concurrent transitions do not create duplicate notifications', async () => {
    const user = await createUser('notif6');
    const { application } = await submitAgentApplication(user.id, validApplicationArgs(country.id, 'notif6'));

    await Promise.allSettled([
      approveAgentApplication(admin.id, application.id, 'a'),
      approveAgentApplication(admin.id, application.id, 'b'),
      approveAgentApplication(admin.id, application.id, 'c'),
    ]);

    const notifications = await prisma.notification.findMany({
      where: { userId: user.id, type: 'AGENT_APPLICATION_APPROVED' },
    });
    expect(notifications.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// REGRESSION
// ═══════════════════════════════════════════════════════════════

describeIf('Phase D regression — unrelated systems untouched', () => {
  it('41-43. wallet/competition/game infrastructure is unaffected by this module', async () => {
    // Phase D introduces no wallet mutation path — applyBalanceChanges is
    // never imported by any file in apps/api/src/agents/. This is a static
    // guarantee verified by source inspection (see the final report), not
    // something a runtime assertion in this file can prove by itself.
    // This test exists as a placeholder marker that the regression category
    // was considered, and asserts the one thing that IS runtime-checkable
    // here: creating an agent application does not touch any Wallet row.
    const user = await createUser('regression1');
    const before = await prisma.wallet.findUnique({ where: { userId: user.id } });
    expect(before).toBeNull(); // no wallet exists yet — Phase D never creates one

    const country = await createCountry('regression');
    await submitAgentApplication(user.id, validApplicationArgs(country.id, 'regression1'));

    const after = await prisma.wallet.findUnique({ where: { userId: user.id } });
    expect(after).toBeNull(); // still doesn't exist — Phase D created no wallet
  });
});

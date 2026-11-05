import { credentialDb as prisma } from './credential-database.js';
import { z } from 'zod';
import { emailSchema, passwordSchema, usernameSchema } from '@socialplay/shared';
import { ApiError } from '../middleware/index.js';
import { hashPassword, verifyPassword } from '../utils/auth.js';
import { assertPlatformAdmin } from './agent-service.js';

const safePassword = passwordSchema.refine((value) => Buffer.byteLength(value, 'utf8') <= 72);
export const adminAgentSchema = z
  .object({
    username: usernameSchema,
    email: emailSchema,
    temporaryPassword: safePassword,
    displayName: z.string().trim().min(1).max(100),
    countryId: z.string().uuid(),
  })
  .strict();
export const activateAgentSchema = z
  .object({
    email: emailSchema,
    temporaryPassword: z.string().min(1).max(128),
    newPassword: safePassword,
  })
  .strict();
const existingAgentSchema = z.object({
  email: emailSchema,
  displayName: z.string().trim().min(1).max(100),
  countryId: z.string().uuid(),
}).strict();
const DUMMY_HASH = '$2a$12$W2Ji.cO4XXOUNGX56WvLlOWP0oAGdNZ0UDeFj5TCLuWWV2oUo/Q9W';
function sanitize(error: unknown): never {
  if (error instanceof ApiError) throw error;
  if ((error as { code?: string })?.code === 'P2002')
    throw ApiError.conflict(
      'Username or email already exists. Check the account directory before retrying.'
    );
  // Prisma errors can embed query arguments; never propagate a credential query.
  throw ApiError.internal(
    'Account setup could not be completed. Check account status before retrying.'
  );
}
export async function createAdminAgent(adminId: string, input: unknown) {
  const parsed = adminAgentSchema.safeParse(input);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    const messages: Record<string, string> = {
      username: 'Username must contain 3–30 letters, numbers or underscores.',
      email: 'Enter a valid email address.',
      countryId: 'Choose an active country.',
      displayName: 'Enter a display name of 1–100 characters.',
      temporaryPassword: 'Temporary password needs 8 or more characters, uppercase, lowercase, a number and a symbol, with a maximum of 72 UTF-8 bytes.',
    };
    throw ApiError.badRequest(messages[String(field)] ?? 'Check the account details and try again.');
  }
  const args = parsed.data;
  await assertPlatformAdmin(adminId);
  try {
    const credentialHash = await hashPassword(args.temporaryPassword);
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM public.users WHERE id=${adminId} FOR SHARE`;
      const admin = await tx.user.findUnique({
        where: { id: adminId },
        select: { role: true, status: true },
      });
      if (!admin || admin.status !== 'ACTIVE' || !['ADMIN', 'SUPER_ADMIN'].includes(admin.role))
        throw ApiError.forbidden('Admin privileges required');
      await tx.$queryRaw`SELECT id FROM public.countries WHERE id=${args.countryId} FOR SHARE`;
      const country = await tx.country.findUnique({ where: { id: args.countryId } });
      if (!country?.isActive) throw ApiError.badRequest('Choose an active country');
      const user = await tx.user.create({
        data: {
          username: args.username,
          email: args.email,
          displayName: args.displayName,
          role: 'USER',
          status: 'PENDING_VERIFICATION',
          passwordHash: null,
        },
        select: { id: true, username: true, email: true },
      });
      await tx.userAuthIdentity.create({
        data: { userId: user.id, provider: 'EMAIL', providerSubject: args.email },
      });
      const agent = await tx.agent.create({
        data: {
          userId: user.id,
          countryId: args.countryId,
          displayName: args.displayName,
          contactEmail: args.email,
          status: 'ACTIVE',
        },
        select: { id: true },
      });
      await tx.agentApplication.create({
        data: {
          agentId: agent.id,
          status: 'APPROVED',
          reviewedBy: adminId,
          reviewedAt: new Date(),
          reviewNote:
            'Created and approved by administrator; receiving accounts require separate review.',
          submittedData: {
            displayName: args.displayName,
            contactEmail: args.email,
            countryId: args.countryId,
            source: 'ADMIN_PROVISIONED',
          },
        },
      });
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await tx.agentAccountSetup.create({
        data: { userId: user.id, createdBy: adminId, credentialHash, expiresAt },
      });
      await tx.auditLog.create({
        data: {
          userId: adminId,
          action: 'ADMIN_AGENT_ACCOUNT_CREATED',
          entity: 'Agent',
          entityId: agent.id,
          newData: {
            accountId: user.id,
            countryId: args.countryId,
            status: 'PENDING_VERIFICATION',
            activationExpiresAt: expiresAt.toISOString(),
          },
        },
      });
      return {
        userId: user.id,
        agentId: agent.id,
        username: user.username,
        email: user.email,
        expiresAt: expiresAt.toISOString(),
        status: 'ACTIVATION_REQUIRED',
      };
    });
  } catch (error) {
    sanitize(error);
  }
}

/** Approve a registered member without replacing their password or wallet. */
export async function approveExistingMemberAgent(adminId: string, input: unknown, expectedUserId?: string) {
  const parsed = existingAgentSchema.safeParse(input);
  if (!parsed.success) throw ApiError.badRequest('A valid member email, display name and country are required.');
  const args = parsed.data;
  await assertPlatformAdmin(adminId);
  try {
    return await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM public.users WHERE id=${adminId} FOR SHARE`;
      const admin = await tx.user.findUnique({ where: { id: adminId }, select: { role: true, status: true } });
      if (!admin || admin.status !== 'ACTIVE' || !['ADMIN', 'SUPER_ADMIN'].includes(admin.role))
        throw ApiError.forbidden('Admin privileges required');
      const matches = await tx.user.findMany({ where: { email: { equals: args.email, mode: 'insensitive' } }, take: 2, select: { id: true } });
      if (!matches.length) throw ApiError.notFound('No member uses this email. Create a new agent account instead.');
      if (matches.length !== 1) throw ApiError.conflict('This email matches more than one account. Resolve the duplicate accounts first.');
      const userId = matches[0].id;
      if (expectedUserId && userId !== expectedUserId) throw ApiError.conflict('The selected member account changed.');
      if (userId === adminId) throw ApiError.forbidden('Use a separate member account for the agent.');
      await tx.$queryRaw`SELECT id FROM public.users WHERE id=${userId} FOR UPDATE`;
      const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true, username: true, email: true, role: true, status: true, agentProfile: { select: { id: true } } } });
      if (!user || user.role !== 'USER' || user.status !== 'ACTIVE')
        throw ApiError.badRequest('Only an active member account can be approved as an agent.');
      if (user.email?.toLowerCase() !== args.email.toLowerCase()) throw ApiError.conflict('The member email changed. Refresh before continuing.');
      if (user.agentProfile) throw ApiError.conflict('This member already has an agent profile. Manage it from Agents.');
      await tx.$queryRaw`SELECT id FROM public.countries WHERE id=${args.countryId} FOR SHARE`;
      const country = await tx.country.findUnique({ where: { id: args.countryId }, select: { isActive: true } });
      if (!country?.isActive) throw ApiError.badRequest('Choose an active country.');
      const agent = await tx.agent.create({ data: { userId, countryId: args.countryId, displayName: args.displayName, contactEmail: user.email!, status: 'ACTIVE' }, select: { id: true } });
      await tx.agentApplication.create({ data: { agentId: agent.id, status: 'APPROVED', reviewedBy: adminId, reviewedAt: new Date(), reviewNote: 'Existing member approved by administrator; receiving accounts require separate review.', submittedData: { source: 'ADMIN_APPROVED_EXISTING_MEMBER', countryId: args.countryId, displayName: args.displayName } } });
      await tx.auditLog.create({ data: { userId: adminId, action: 'ADMIN_EXISTING_MEMBER_AGENT_APPROVED', entity: 'Agent', entityId: agent.id, newData: { accountId: userId, countryId: args.countryId } } });
      return { userId, agentId: agent.id, username: user.username, email: user.email, status: 'READY_TO_SIGN_IN' };
    });
  } catch (error) { sanitize(error); }
}
export async function activateAdminAgent(input: unknown) {
  const parsed = activateAgentSchema.safeParse(input);
  if (!parsed.success)
    throw ApiError.badRequest(
      'Valid email, temporary password and a strong new password of at most 72 UTF-8 bytes are required'
    );
  const args = parsed.data;
  try {
    const candidate = await prisma.user.findUnique({
      where: { email: args.email },
      include: { agentAccountSetup: true },
    });
    const setup = candidate?.agentAccountSetup;
    const valid = await verifyPassword(args.temporaryPassword, setup?.credentialHash ?? DUMMY_HASH);
    const invalid = () =>
      ApiError.unauthorized('Temporary credentials are invalid, expired or already used');
    if (
      !valid ||
      !candidate ||
      !setup?.credentialHash ||
      setup.consumedAt ||
      setup.expiresAt <= new Date() ||
      candidate.status !== 'PENDING_VERIFICATION' ||
      candidate.role !== 'USER'
    )
      throw invalid();
    if (await verifyPassword(args.newPassword, setup.credentialHash))
      throw ApiError.badRequest('Choose a new password different from the temporary password');
    const passwordHash = await hashPassword(args.newPassword);
    await prisma.$transaction(async (tx) => {
      // Same lock ordering on all account changes: user, then setup row.
      await tx.$queryRaw`SELECT id FROM public.users WHERE id=${candidate.id} FOR UPDATE`;
      const current = await tx.user.findUnique({
        where: { id: candidate.id },
        include: { agentAccountSetup: true, agentProfile: { select: { status: true } } },
      });
      const currentSetup = current?.agentAccountSetup;
      if (
        !current ||
        current.status !== 'PENDING_VERIFICATION' ||
        current.role !== 'USER' ||
        current.agentProfile?.status !== 'ACTIVE' ||
        !currentSetup ||
        currentSetup.consumedAt ||
        currentSetup.expiresAt <= new Date() ||
        currentSetup.credentialHash !== setup.credentialHash
      )
        throw invalid();
      const [activation] = await tx.$queryRaw<Array<{ activated: boolean }>>`
        SELECT public.activate_provisioned_agent(${candidate.id}, ${setup.credentialHash}, ${passwordHash}) AS activated`;
      if (!activation?.activated) throw invalid();
      await tx.auditLog.create({
        data: {
          userId: candidate.id,
          action: 'ADMIN_AGENT_ACCOUNT_ACTIVATED',
          entity: 'User',
          entityId: candidate.id,
          newData: { status: 'ACTIVE', temporaryCredentialConsumed: true },
        },
      });
    });
    return { message: 'Password set. Sign in to your agent workspace with your new password.' };
  } catch (error) {
    sanitize(error);
  }
}

export async function listPendingAgentAccounts(adminId: string) {
  await assertPlatformAdmin(adminId);
  return prisma.agentAccountSetup.findMany({
    where: { consumedAt: null, user: { status: 'PENDING_VERIFICATION' } },
    take: 100,
    orderBy: [{ createdAt: 'desc' }, { userId: 'desc' }],
    select: { userId: true, expiresAt: true, user: { select: { username: true, email: true } } },
  });
}
export async function reissueAgentPassword(adminId: string, userId: string, input: unknown) {
  const parsed = z.object({ temporaryPassword: safePassword }).strict().safeParse(input);
  if (!parsed.success || !z.string().uuid().safeParse(userId).success)
    throw ApiError.badRequest('Valid account and strong temporary password required');
  await assertPlatformAdmin(adminId);
  try {
    const credentialHash = await hashPassword(parsed.data.temporaryPassword);
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM public.users WHERE id=${adminId} FOR SHARE`;
      const admin = await tx.user.findUnique({ where: { id: adminId } });
      if (!admin || admin.status !== 'ACTIVE' || !['ADMIN', 'SUPER_ADMIN'].includes(admin.role))
        throw ApiError.forbidden('Admin privileges required');
      await tx.$queryRaw`SELECT id FROM public.users WHERE id=${userId} FOR UPDATE`;
      const user = await tx.user.findUnique({
        where: { id: userId },
        include: { agentAccountSetup: true },
      });
      if (
        !user ||
        user.role !== 'USER' ||
        user.status !== 'PENDING_VERIFICATION' ||
        user.passwordHash ||
        !user.agentAccountSetup ||
        user.agentAccountSetup.consumedAt
      )
        throw ApiError.conflict('Only unused agent activation credentials can be replaced');
      const expiresAt = new Date(Date.now() + 86400000);
      await tx.agentAccountSetup.update({ where: { userId }, data: { credentialHash, expiresAt } });
      await tx.auditLog.create({
        data: {
          userId: adminId,
          action: 'ADMIN_AGENT_TEMPORARY_PASSWORD_REISSUED',
          entity: 'User',
          entityId: userId,
          newData: { expiresAt: expiresAt.toISOString() },
        },
      });
      return { userId, expiresAt: expiresAt.toISOString() };
    });
  } catch (error) {
    sanitize(error);
  }
}

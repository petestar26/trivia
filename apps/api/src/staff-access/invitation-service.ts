import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { type PrismaClient } from '@prisma/client';
import { type Tx, staffId as id, operation, users, profile, grant, clock, unexpired, validId, deny } from './authority.js';
export { StaffAccessDenied } from './authority.js';
import { z } from 'zod';

/** DORMANT: no routes, global client, schema activation or real grants.
 * actorId must come from authenticated server identity, never request payload.
 * All future grant/designation/profile writers must take this same advisory lock.
 * Existing user/agent suspension is serialized by row locks as well.
 */
const key = z.string().min(1).max(128);
async function agent(tx: Tx, agentId: string, expectedRecipient?: string) {
  const rows = await tx.$queryRaw<Array<{ id: string; userId: string; status: string }>>`
    SELECT id, "userId", status::text FROM public.agents WHERE id=${agentId} FOR UPDATE`;
  if (!rows[0] || rows[0].status !== 'ACTIVE'
      || (expectedRecipient !== undefined && rows[0].userId !== expectedRecipient)) deny();
  return rows[0];
}
type Assignment = { id: string; manager_id: string; agent_id: string; ended_at: Date | null };
async function current(tx: Tx, agentId: string) {
  const rows = await tx.$queryRaw<Assignment[]>`
    SELECT id, manager_id, agent_id, ended_at FROM staff_access.assignments
    WHERE agent_id=${agentId} AND ended_at IS NULL FOR UPDATE`;
  return rows[0];
}
async function audit(tx: Tx, input: {
  actorId: string; action: string; agentId: string; managerId: string;
  invitationId?: string; assignmentId?: string; previousId?: string; requestKey?: string; now: Date;
}) {
  await tx.$executeRaw`INSERT INTO staff_access.audit
    (id,actor_id,action,agent_id,manager_id,invitation_id,assignment_id,previous_assignment_id,request_key,created_at)
    VALUES (${randomUUID()},${input.actorId},${input.action},${input.agentId},${input.managerId},
      ${input.invitationId ?? null},${input.assignmentId ?? null},${input.previousId ?? null},
      ${input.requestKey ?? null},${input.now})`;
}

/** Issues a recipient-bound token; caller must deliver it through a separately
 * approved channel. No account creation, sending, grant changes or approval. */
export async function createAgentInvitation(db: PrismaClient, actorId: string, agentId: string, expiresAt: Date) {
  validId(actorId); validId(agentId);
  if (!z.date().safeParse(expiresAt).success) deny();
  const token = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(token).digest('hex');
  return operation(db, async (tx, mainAdminId, issuerEpoch) => {
    const targets = await tx.$queryRaw<Array<{ userId: string }>>`SELECT "userId" FROM public.agents WHERE id=${agentId}`;
    if (!targets[0]) deny();
    const recipient = targets[0].userId;
    await users(tx, [actorId, recipient]);
    const grantExpiry = await grant(tx, actorId, 'agent:invite', mainAdminId);
    await agent(tx, agentId, recipient);
    if (await current(tx, agentId)) deny();
    const now = await clock(tx);
    unexpired(grantExpiry, now); unexpired(expiresAt, now);
    const invitationId = randomUUID();
    await tx.$executeRaw`INSERT INTO staff_access.invitation_records
      (id,issuer_id,issuer_epoch,token_hash,manager_id,agent_id,recipient_id,created_at,expires_at)
      VALUES (${invitationId},${mainAdminId},${issuerEpoch},${hash},${actorId},${agentId},${recipient},${now},${expiresAt})`;
    await audit(tx, { actorId, action: 'INVITE_CREATED', agentId, managerId: actorId, invitationId, now });
    return { invitationId, token }; // Never persisted or audited in plaintext.
  });
}

type Invitation = {
  id: string; issuer_id: string; issuer_epoch: bigint; manager_id: string; agent_id: string; recipient_id: string;
  expires_at: Date; revoked_at: Date | null; assignment_id: string | null;
};
export async function acceptAgentInvitation(db: PrismaClient, actorId: string, token: string) {
  validId(actorId);
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) deny();
  const hash = createHash('sha256').update(token).digest('hex');
  return operation(db, async (tx, mainAdminId, issuerEpoch) => {
    const invites = await tx.$queryRaw<Invitation[]>`SELECT id, issuer_id, issuer_epoch, manager_id, agent_id, recipient_id,
      expires_at, revoked_at, assignment_id FROM staff_access.invitation_records WHERE token_hash=${hash} FOR UPDATE`;
    const invitation = invites[0];
    if (!invitation || invitation.recipient_id !== actorId || invitation.issuer_id !== mainAdminId
      || invitation.issuer_epoch !== issuerEpoch) deny();
    await users(tx, [actorId, invitation.manager_id]);
    const grantExpiry = await grant(tx, invitation.manager_id, 'agent:invite', mainAdminId);
    await agent(tx, invitation.agent_id, actorId);
    const assigned = await current(tx, invitation.agent_id);
    const now = await clock(tx);
    unexpired(grantExpiry, now);
    if (invitation.revoked_at) deny();
    // Replay returns only the caller's still-current exact assignment. It must
    // not restore an assignment closed by a later administrator reassignment.
    if (invitation.assignment_id) {
      if (!assigned || assigned.id !== invitation.assignment_id
          || assigned.manager_id !== invitation.manager_id) deny();
      return { assignmentId: assigned.id };
    }
    unexpired(invitation.expires_at, now);
    if (assigned) deny(); // Even another invite from the SAME manager conflicts.
    const assignmentId = randomUUID();
    await tx.$executeRaw`INSERT INTO staff_access.assignments
      (id,agent_id,manager_id,started_at,invitation_id)
      VALUES (${assignmentId},${invitation.agent_id},${invitation.manager_id},${now},${invitation.id})`;
    await tx.$executeRaw`UPDATE staff_access.invitation_records SET accepted_at=${now}, assignment_id=${assignmentId}
      WHERE id=${invitation.id}`;
    await audit(tx, { actorId, action: 'INVITE_ACCEPTED', agentId: invitation.agent_id,
      managerId: invitation.manager_id, invitationId: invitation.id, assignmentId, now });
    return { assignmentId };
  });
}

export async function revokeAgentInvitation(db: PrismaClient, actorId: string, invitationId: string) {
  validId(actorId); validId(invitationId);
  return operation(db, async (tx, mainAdminId, issuerEpoch) => {
    const rows = await tx.$queryRaw<Invitation[]>`SELECT id, issuer_id, issuer_epoch, manager_id, agent_id, recipient_id,
      expires_at, revoked_at, assignment_id FROM staff_access.invitation_records WHERE id=${invitationId} FOR UPDATE`;
    const invitation = rows[0];
    if (!invitation || invitation.manager_id !== actorId) deny();
    await users(tx, [actorId]);
    const grantExpiry = await grant(tx, actorId, 'agent:invite', mainAdminId);
    const now = await clock(tx); unexpired(grantExpiry, now);
    if (invitation.assignment_id) deny(); // Revoking an invite cannot unassign an agent.
    if (invitation.revoked_at) return;
    await tx.$executeRaw`UPDATE staff_access.invitation_records SET revoked_at=${now} WHERE id=${invitationId}`;
    await audit(tx, { actorId, action: 'INVITE_REVOKED', agentId: invitation.agent_id,
      managerId: actorId, invitationId, now });
  });
}

export async function reassignAgent(db: PrismaClient, actorId: string, input: {
  agentId: string; managerId: string; expectedAssignmentId: string; requestKey: string;
}) {
  validId(actorId);
  const parsed = z.object({ agentId: id, managerId: id, expectedAssignmentId: id, requestKey: key }).strict().safeParse(input);
  if (!parsed.success) return deny();
  const data = parsed.data;
  return operation(db, async (tx, mainAdminId, issuerEpoch) => {
    const owners = await tx.$queryRaw<Array<{ user_id: string }>>`SELECT user_id FROM staff_access.main_admin WHERE singleton=true FOR SHARE`;
    if (owners[0]?.user_id !== actorId) deny();
    const targets = await tx.$queryRaw<Array<{ userId: string }>>`SELECT "userId" FROM public.agents WHERE id=${data.agentId}`;
    if (!targets[0]) deny();
    const actors = await users(tx, [actorId, data.managerId, targets[0].userId]);
    if (!actors.some(row => row.id === actorId && ['ADMIN','SUPER_ADMIN'].includes(row.role))) deny();
    await profile(tx, data.managerId);
    await agent(tx, data.agentId, targets[0].userId);
    const assigned = await current(tx, data.agentId);
    const previous = await tx.$queryRaw<Array<{ agent_id: string; manager_id: string; previous_assignment_id: string; assignment_id: string }>>`
      SELECT agent_id,manager_id,previous_assignment_id,assignment_id FROM staff_access.audit
      WHERE actor_id=${actorId} AND action='AGENT_REASSIGNED' AND request_key=${data.requestKey}`;
    if (previous[0]) {
      const old = previous[0];
      if (old.agent_id !== data.agentId || old.manager_id !== data.managerId
          || old.previous_assignment_id !== data.expectedAssignmentId
          || assigned?.id !== old.assignment_id) deny();
      return { assignmentId: old.assignment_id };
    }
    if (!assigned || assigned.id !== data.expectedAssignmentId || assigned.manager_id === data.managerId) deny();
    const now = await clock(tx), assignmentId = randomUUID();
    await tx.$executeRaw`UPDATE staff_access.assignments SET ended_at=${now} WHERE id=${assigned.id}`;
    await tx.$executeRaw`INSERT INTO staff_access.assignments
      (id,agent_id,manager_id,started_at,previous_assignment_id)
      VALUES (${assignmentId},${data.agentId},${data.managerId},${now},${assigned.id})`;
    // Pending invitations cannot silently reclaim the agent after reassignment.
    await tx.$executeRaw`UPDATE staff_access.invitation_records SET revoked_at=${now}
      WHERE agent_id=${data.agentId} AND accepted_at IS NULL AND revoked_at IS NULL`;
    await audit(tx, { actorId, action: 'AGENT_REASSIGNED', agentId: data.agentId,
      managerId: data.managerId, assignmentId, previousId: assigned.id, requestKey: data.requestKey, now });
    return { assignmentId };
  });
}

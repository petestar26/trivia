import { randomUUID } from 'node:crypto';
import { type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { currentStaffSession, operation, staffId, permissionName, validId, deny, clock, unexpired } from './authority.js';
const changeSchema=z.object({
  managerId:staffId, permission:permissionName, active:z.boolean(),
  expectedRevision:staffId.nullable().optional(),
  // An explicit null is required for no expiry; omitted fields must not erase it.
  expiresAt:z.date().nullable(), requestKey:z.string().trim().min(1).max(128),
}).strict().refine(value=>value.active || value.expiresAt===null);

/** Main-admin-only; changes capability, never accounts or agent assignments.
 * Exact retries are bound to actor+payload and must still be the current revision.
 */
export async function setManagerPermission(db:PrismaClient,actorId:string,input:unknown,expectedTokenVersion?:number) {
  validId(actorId);
  const parsed=changeSchema.safeParse(input);
  if(!parsed.success) return deny();
  const data=parsed.data;
  return operation(db,async(tx,mainAdminId,issuerEpoch)=>{
    if(actorId!==mainAdminId || data.managerId===mainAdminId) deny();
    await currentStaffSession(tx,actorId,expectedTokenVersion);
    const managers=await tx.$queryRaw<Array<{status:string;active:boolean}>>`
      SELECT u.status::text,m.active FROM staff_access.managers m JOIN public.users u ON u.id=m.user_id
      WHERE m.user_id=${data.managerId} FOR SHARE OF m,u`;
    if(!managers[0] || (data.active && (managers[0].status!=='ACTIVE' || !managers[0].active))) deny();
    const current=await tx.$queryRaw<Array<{revision_id:string}>>`
      SELECT revision_id FROM staff_access.grant_records WHERE manager_id=${data.managerId} AND permission=${data.permission} FOR UPDATE`;
    const previous=await tx.$queryRaw<Array<{id:string;manager_id:string;permission:string;active:boolean;expires_at:Date|null;issuer_epoch:bigint;previous_revision_id:string|null}>>`
      SELECT id,manager_id,permission,active,expires_at,issuer_epoch,previous_revision_id FROM staff_access.permission_audit
      WHERE actor_id=${actorId} AND request_key=${data.requestKey}`;
    const now=await clock(tx);
    if(previous[0]) {
      const old=previous[0];
      if((data.expectedRevision!==undefined&&old.previous_revision_id!==data.expectedRevision)||old.issuer_epoch!==issuerEpoch || old.manager_id!==data.managerId || old.permission!==data.permission || old.active!==data.active
        || old.expires_at?.getTime()!==data.expiresAt?.getTime() || current[0]?.revision_id!==old.id) deny();
      return {revisionId:old.id}; // An expired grant remains expired; no restoration.
    }
    if(data.expectedRevision!==undefined&&(current[0]?.revision_id??null)!==data.expectedRevision)deny();
    if(data.active) unexpired(data.expiresAt,now);
    const revisionId=randomUUID();
    await tx.$executeRaw`INSERT INTO staff_access.permission_audit
      (id,actor_id,issuer_epoch,manager_id,permission,active,expires_at,previous_revision_id,request_key,created_at)
      VALUES (${revisionId},${actorId},${issuerEpoch},${data.managerId},${data.permission},${data.active},${data.expiresAt},
        ${current[0]?.revision_id??null},${data.requestKey},${now})`;
    // Separate INSERT/UPDATE avoids INSERT triggers seeing an existing revision
    // during an upsert before PostgreSQL decides the conflict path.
    if(current[0]) await tx.$executeRaw`UPDATE staff_access.grant_records SET active=${data.active},expires_at=${data.expiresAt},
      issuer_id=${actorId},revision_id=${revisionId} WHERE manager_id=${data.managerId} AND permission=${data.permission}`;
    else await tx.$executeRaw`INSERT INTO staff_access.grant_records(manager_id,permission,active,expires_at,issuer_id,revision_id)
      VALUES (${data.managerId},${data.permission},${data.active},${data.expiresAt},${actorId},${revisionId})`;
    return {revisionId};
  });
}

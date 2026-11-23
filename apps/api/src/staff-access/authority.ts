import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
export type Tx = Prisma.TransactionClient;
export const staffId = z.string().min(1).max(128).refine(value => value.trim() === value);
export const permissionName = z.enum(['agent:invite', 'agent:directory:read', 'agent:payment-account:recommend']);
export class StaffAccessDenied extends Error {
  constructor() { super('Staff operation unavailable'); }
}
export function deny(): never { throw new StaffAccessDenied(); }
export function validId(value: unknown) { if (!staffId.safeParse(value).success) deny(); }

/** No global client or route. Caller supplies authenticated identity.
 * All staff writes/reads use the gate first, then designation and current owner.
 * Dormant owner transfer uses this protocol; profile onboarding remains absent.
 * Issuer epoch SHARE follows current owner/User SHARE to serialize loss triggers.
 */
export async function operation<T>(db: PrismaClient, work: (tx: Tx, mainAdminId: string, issuerEpoch: bigint) => Promise<T>): Promise<T> {
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT true AS locked FROM pg_advisory_xact_lock(481516,2342)`;
    const rows = await tx.$queryRaw<Array<{ id: string; status: string; role: string }>>`
      SELECT u.id,u.status::text,u.role::text FROM staff_access.main_admin d
      JOIN public.users u ON u.id=d.user_id WHERE d.singleton=true FOR SHARE OF d,u`;
    const owner = rows[0];
    if (!owner || owner.status !== 'ACTIVE' || !['ADMIN','SUPER_ADMIN'].includes(owner.role)) deny();
    const epochs=await tx.$queryRaw<Array<{epoch:bigint}>>`
      SELECT epoch FROM staff_access.issuer_state WHERE user_id=${owner.id} FOR SHARE`;
    if(!epochs[0]) deny();
    return work(tx, owner.id, epochs[0].epoch);
  }, { timeout: 15000, maxWait: 15000 });
}
export async function users(tx: Tx, ids: string[]) {
  const rows = await tx.$queryRaw<Array<{ id: string; status: string; role: string }>>`
    SELECT id,status::text,role::text FROM public.users
    WHERE id IN (${Prisma.join([...new Set(ids)].sort())}) ORDER BY id FOR SHARE`;
  if (rows.length !== new Set(ids).size || rows.some(row=>row.status!=='ACTIVE')) deny();
  return rows;
}
export async function profile(tx: Tx, managerId: string) {
  const rows = await tx.$queryRaw<Array<{active:boolean}>>`
    SELECT active FROM staff_access.managers WHERE user_id=${managerId} FOR SHARE`;
  if (!rows[0]?.active) deny();
}
export async function currentGrant(tx: Tx, managerId: string, permission: string, mainAdminId: string) {
  if (!permissionName.safeParse(permission).success) deny();
  await profile(tx,managerId);
  const rows = await tx.$queryRaw<Array<{active:boolean;expires_at:Date|null;issuer_id:string;revision_id:string}>>`
    SELECT g.active,g.expires_at,g.issuer_id,g.revision_id FROM staff_access.grant_records g
    JOIN staff_access.permission_audit e ON e.id=g.revision_id AND e.manager_id=g.manager_id
      AND e.permission=g.permission AND e.actor_id=g.issuer_id AND e.active=g.active
      AND e.expires_at IS NOT DISTINCT FROM g.expires_at
    JOIN staff_access.issuer_state s ON s.user_id=e.actor_id AND s.epoch=e.issuer_epoch
    WHERE g.manager_id=${managerId} AND g.permission=${permission} FOR SHARE OF g,e,s`;
  if (!rows[0]?.active || rows[0].issuer_id!==mainAdminId) deny();
  return { revisionId: rows[0].revision_id, expiresAt: rows[0].expires_at };
}
export async function grant(tx: Tx, managerId: string, permission: string, mainAdminId: string) {
  return (await currentGrant(tx, managerId, permission, mainAdminId)).expiresAt;
}
export async function clock(tx: Tx) {
  const rows=await tx.$queryRaw<Array<{now:Date}>>`SELECT clock_timestamp() AS now`;
  return rows[0].now;
}
export function unexpired(expiresAt: Date|null, now: Date) {
  if (expiresAt!==null && expiresAt.getTime()<=now.getTime()) deny();
}

/** Optional only for trusted internal callers; HTTP mutations must supply the
 * verified token version. Called inside the authority transaction, after owner
 * checks, so logout/version changes serialize with committing staff mutations. */
export async function currentStaffSession(tx:Tx,actorId:string,expectedTokenVersion?:number) {
  if(expectedTokenVersion===undefined)return;
  if(!Number.isSafeInteger(expectedTokenVersion)||expectedTokenVersion<0)deny();
  const rows=await tx.$queryRaw<Array<{tokenVersion:number;status:string}>>`
    SELECT "tokenVersion",status::text FROM public.users WHERE id=${actorId} FOR SHARE`;
  if(rows[0]?.status!=='ACTIVE'||rows[0].tokenVersion!==expectedTokenVersion)deny();
}

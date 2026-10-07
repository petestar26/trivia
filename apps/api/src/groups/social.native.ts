import {afterAll,afterEach,beforeAll,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {prisma as db} from '@socialplay/database';
import {createMessage} from '../realtime/chat-service.js';
import {lockSocialGroup,expireSocialGroups} from './lifecycle.js';
import {createGroupPvpService} from '../games/group-pvp/service.js';
import {applyBalanceChanges} from '../economy/wallet-service.js';
import {PVP_POLICY} from '../games/economics/policy.js';
import {buildServer} from '../server.js';
const url=new URL(process.env.DATABASE_URL??'http://invalid');
if(!['localhost','127.0.0.1'].includes(url.hostname)||url.pathname!=='/playqube_scheduled_throwaway'||process.env.SCHEDULED_NATIVE_DB_ACK!=='throwaway')throw new Error('Throwaway database required');
let server:Awaited<ReturnType<typeof buildServer>>;
beforeAll(async()=>{server=await buildServer();await server.ready();});
afterAll(async()=>{await server?.close();await db.$disconnect();});
afterEach(()=>{vi.unstubAllEnvs();});
function headers(userId:string){return {authorization:`Bearer ${server.jwt.sign({sub:userId,roles:['USER']})}`};}
async function fixture(lifetime=86400000){
  const users=[randomUUID(),randomUUID(),randomUUID()];const groupId=randomUUID();
  for(const id of users){await db.user.create({data:{id,username:`social_${id.replaceAll('-','')}`}});await db.wallet.create({data:{userId:id}});}
  await db.group.create({data:{id:groupId,name:'Private social QA',ownerId:users[0],isPrivate:true,expiresAt:new Date(Date.now()+lifetime)}});
  for(const id of users.slice(0,2))await db.groupMember.create({data:{groupId,userId:id,role:id===users[0]?'OWNER':'MEMBER'}});
  return {users,groupId};
}
it('serves private inboxes, personal archives and lifecycle through authenticated HTTP',async()=>{
  const f=await fixture();const base='/api/v1/groups';
  expect((await server.inject({url:`${base}/inbox`})).statusCode).toBe(401);
  await createMessage({groupId:f.groupId,userId:f.users[0],content:'Private preview'});
  const inbox=await server.inject({url:`${base}/inbox`,headers:headers(f.users[1])});
  expect(inbox.statusCode).toBe(200);expect(inbox.headers['cache-control']).toBe('private, no-store');
  expect(inbox.json().data).toContainEqual(expect.objectContaining({id:f.groupId,lastMessage:'Private preview',closed:false}));
  expect((await server.inject({url:`${base}/inbox`,headers:headers(f.users[2])})).json().data).toEqual([]);
  expect((await server.inject({url:`${base}/${f.groupId}/lifecycle`,headers:headers(f.users[2])})).statusCode).toBe(403);
  const lifecycle=(await server.inject({url:`${base}/${f.groupId}/lifecycle`,headers:headers(f.users[0])})).json().data;
  expect(lifecycle).toMatchObject({closed:false,archived:false});
  expect(lifecycle.expiresAt-lifecycle.serverTime).toBeGreaterThan(86_000_000);
  const results=await Promise.all([true,true].map(archived=>server.inject({method:'POST',url:`${base}/${f.groupId}/archive`,headers:headers(f.users[0]),payload:{archived}})));
  expect(results.map(result=>result.statusCode)).toEqual([200,200]);
  expect((await server.inject({url:`${base}/inbox`,headers:headers(f.users[0])})).json().data).toEqual([]);
  expect((await server.inject({url:`${base}/inbox?archived=true`,headers:headers(f.users[0])})).json().data).toHaveLength(1);
  expect((await server.inject({url:`${base}/inbox`,headers:headers(f.users[1])})).json().data).toHaveLength(1);
  await server.inject({method:'POST',url:`${base}/${f.groupId}/archive`,headers:headers(f.users[0]),payload:{archived:false}});
  expect((await server.inject({url:`${base}/inbox`,headers:headers(f.users[0])})).json().data).toHaveLength(1);
  await db.user.update({where:{id:f.users[0]},data:{status:'SUSPENDED'}});
  const denied = await server.inject({url:`${base}/inbox`,headers:headers(f.users[0])});
  expect(denied.statusCode).toBe(403);
  expect(denied.json().data).toBeUndefined();
  expect(denied.json().error.message).toBe('An active account is required');
});
it('returns a safe HTTP conflict when an owner tries to ban a paid player',async()=>{
  const f=await fixture();const service=createGroupPvpService(db);
  await db.$transaction(tx=>applyBalanceChanges(tx,f.users[1],[{currency:'GAME_POINTS',amount:500,ledgerType:'CREDIT',transactionType:'GAME_POINT_CREDIT',referenceType:'ADMIN',description:'Disposable fixture'}]));
  const roundId=randomUUID();await db.$executeRaw`INSERT INTO group_pvp_rounds(id,group_id,creator_id,request_id,game,rules_id,policy_id,entry_amount,expires_at)
    VALUES(${roundId},${f.groupId},${f.users[0]},${randomUUID()},'dice','group-pvp-dice-v1',${PVP_POLICY},100,clock_timestamp()+interval '15 minutes')`;
  await service.join(f.groupId,f.users[1],roundId);await service.ready(f.groupId,f.users[1],roundId,[7],PVP_POLICY,100);
  const banned=await server.inject({method:'POST',url:`/api/v1/groups/${f.groupId}/members/${f.users[1]}/ban`,headers:headers(f.users[0])});
  const deleted=await server.inject({method:'DELETE',url:`/api/v1/groups/${f.groupId}`,headers:headers(f.users[0])});expect(deleted.statusCode).toBe(409);expect(deleted.body).toContain('game or gift history');
  expect(banned.statusCode).toBe(409);expect(banned.body).not.toContain('prisma');expect(banned.body).not.toContain('PVP_MEMBER_PROTECTED');
  expect((await db.groupMember.findUniqueOrThrow({where:{groupId_userId:{groupId:f.groupId,userId:f.users[1]}}})).status).toBe('ACTIVE');
});
it('serializes duplicate text receipts, rejects changed replays, and keeps replies in the group',async()=>{
  const f=await fixture();const body={groupId:f.groupId,userId:f.users[0],content:' Hello ',clientRequestId:randomUUID()};
  const results=await Promise.all([createMessage(body),createMessage(body)]);
  expect(new Set(results.map(message=>message.id)).size).toBe(1);expect(results.map(message=>message.isReplay).sort()).toEqual([false,true]);
  await expect(createMessage({...body,content:'Changed'})).rejects.toThrow('different message');
  const other=await fixture();await expect(createMessage({groupId:other.groupId,userId:other.users[0],content:'reply',replyToId:results[0].id})).rejects.toThrow('Parent message');
  const reply=await createMessage({...body,clientRequestId:randomUUID(),content:'Reply',replyToId:results[0].id});expect(reply.replyTo?.id).toBe(results[0].id);
  await expect(createMessage({...body,userId:f.users[2],clientRequestId:randomUUID()})).rejects.toThrow('Join this group');
});
it('enforces expiry without a worker, preserves read access and exact sent receipts',async()=>{
  const f=await fixture(1000);const body={groupId:f.groupId,userId:f.users[0],content:'Before closing',clientRequestId:randomUUID()};
  const first=await createMessage(body);await new Promise(resolve=>setTimeout(resolve,1050));
  await expect(createMessage({...body,clientRequestId:randomUUID()})).rejects.toThrow('closed');
  expect((await createMessage(body)).id).toBe(first.id);
  await expect(db.message.create({data:{groupId:f.groupId,userId:f.users[0],content:'Direct late write'}})).rejects.toThrow('GROUP_CLOSED');
  await expect(db.groupMember.create({data:{groupId:f.groupId,userId:f.users[2]}})).rejects.toThrow('GROUP_CLOSED');
  await expireSocialGroups(db);
  expect((await db.$transaction(tx=>lockSocialGroup(tx,f.groupId,f.users[0],false))).group.status).toBe('ARCHIVED');
  await db.groupMember.update({where:{groupId_userId:{groupId:f.groupId,userId:f.users[0]}},data:{archivedAt:new Date()}});
  expect((await db.groupMember.findUniqueOrThrow({where:{groupId_userId:{groupId:f.groupId,userId:f.users[1]}}})).archivedAt).toBeNull();
  await expect(db.group.update({where:{id:f.groupId},data:{expiresAt:new Date(Date.now()+86400000)}})).rejects.toThrow('GROUP_DEADLINE_IMMUTABLE');
});
it('expiry refunds a suspended player without any live session and keeps audit records readable',async()=>{
  const f=await fixture(1200);const service=createGroupPvpService(db);
  await db.$transaction(tx=>applyBalanceChanges(tx,f.users[1],[{currency:'GAME_POINTS',amount:500,ledgerType:'CREDIT',transactionType:'GAME_POINT_CREDIT',referenceType:'ADMIN',description:'Disposable fixture'}]));
  // A lobby created earlier in the room, now nearing its final deadline.
  const roundId=randomUUID();await db.$executeRaw`INSERT INTO group_pvp_rounds(id,group_id,creator_id,request_id,game,rules_id,policy_id,entry_amount,expires_at)
    VALUES(${roundId},${f.groupId},${f.users[0]},${randomUUID()},'dice','group-pvp-dice-v1',${PVP_POLICY},100,clock_timestamp()+interval '15 minutes')`;
  await service.join(f.groupId,f.users[1],roundId);await service.ready(f.groupId,f.users[1],roundId,[7],PVP_POLICY,100);
  await db.user.update({where:{id:f.users[1]},data:{status:'SUSPENDED'}});
  await new Promise(resolve=>setTimeout(resolve,1250));await service.tick();await service.tick();
  const snapshot=await service.snapshot(f.groupId,f.users[0]);expect(snapshot.enabled).toBe(false);expect(snapshot.round!.state).toBe('VOID');expect(snapshot.round!.settlement!.platformFee).toBe(0);
  expect((await db.wallet.findUniqueOrThrow({where:{userId:f.users[1]}})).gamePointsBalance).toBe(500);
});
it('a draw already committed before closure still pays its winner',async()=>{
  const f=await fixture(1200);const service=createGroupPvpService(db);const roundId=randomUUID();
  for(const userId of f.users.slice(0,2))await db.$transaction(tx=>applyBalanceChanges(tx,userId,[{currency:'GAME_POINTS',amount:500,ledgerType:'CREDIT',transactionType:'GAME_POINT_CREDIT',referenceType:'ADMIN',description:'Disposable fixture'}]));
  await db.$executeRaw`INSERT INTO group_pvp_rounds(id,group_id,creator_id,request_id,game,rules_id,policy_id,entry_amount,expires_at)
    VALUES(${roundId},${f.groupId},${f.users[0]},${randomUUID()},'dice','group-pvp-dice-v1',${PVP_POLICY},100,clock_timestamp()+interval '15 minutes')`;
  for(const [index,userId] of f.users.slice(0,2).entries()){await service.join(f.groupId,userId,roundId);await service.ready(f.groupId,userId,roundId,[index?12:7],PVP_POLICY,100);}
  await db.$executeRaw`UPDATE group_pvp_rounds SET state='COUNTDOWN',starts_at=clock_timestamp()-interval '1 second' WHERE id=${roundId}`;
  await db.$executeRaw`UPDATE group_pvp_rounds SET state='DRAWN',outcome='[6,6]' WHERE id=${roundId}`;
  await new Promise(resolve=>setTimeout(resolve,1250));await service.tick();
  const round=(await service.snapshot(f.groupId,f.users[1])).round!;expect(round.state).toBe('SETTLED');expect(round.settlement!.prizes[0].userId).toBe(f.users[1]);
  expect((await db.wallet.findUniqueOrThrow({where:{userId:f.users[1]}})).gamePointsBalance).toBe(586);
});
it.each(['ARCHIVED','expired'])('preserves chat-only %s history and allows only narrow manager moderation',async mode=>{
  const f=await fixture(mode==='expired'?900:86400000);
  const message=await createMessage({groupId:f.groupId,userId:f.users[1],content:'Moderation fixture'});
  if(mode==='expired')await new Promise(resolve=>setTimeout(resolve,950));
  else await db.group.update({where:{id:f.groupId},data:{status:'ARCHIVED'}});
  const base=`/api/v1/groups/${f.groupId}`;
  const gone=await server.inject({method:'DELETE',url:base,headers:headers(f.users[0])});
  expect(gone.statusCode,gone.body).toBe(409);expect(gone.body).toContain('closed');
  expect((await server.inject({url:`${base}/messages`,headers:headers(f.users[1])})).json().data).toContainEqual(expect.objectContaining({id:message.id}));
  expect((await server.inject({method:'DELETE',url:`${base}/messages/${message.id}`,headers:headers(f.users[1])})).statusCode).toBe(403);
  await expect(db.message.update({where:{id:message.id},data:{isDeleted:true}})).rejects.toThrow('GROUP_CLOSED');
  // Even the server's trusted actor context cannot authorize content changes.
  await expect(db.$transaction(async tx=>{
    await tx.$executeRaw`SELECT set_config('playqube.moderator_id',${f.users[0]},true)`;
    await tx.message.update({where:{id:message.id},data:{isDeleted:true,content:'Changed'}});
  })).rejects.toThrow('GROUP_CLOSED');
  const hidden=await server.inject({method:'DELETE',url:`${base}/messages/${message.id}`,headers:headers(f.users[0])});
  expect(hidden.statusCode,hidden.body).toBe(200);
  expect(await db.message.findUniqueOrThrow({where:{id:message.id}})).toMatchObject({isDeleted:true,content:'Moderation fixture'});
  await expect(db.message.update({where:{id:message.id},data:{isDeleted:false}})).rejects.toThrow('GROUP_CLOSED');
  expect((await server.inject({url:`${base}/messages`,headers:headers(f.users[1])})).json().data).toEqual([]);
  expect((await server.inject({method:'POST',url:`${base}/archive`,headers:headers(f.users[1]),payload:{archived:true}})).statusCode).toBe(200);
});
it('removing an unpaid participant withdraws their lobby entry so paid players can start',async()=>{
  const f=await fixture();const service=createGroupPvpService(db);
  await db.groupMember.create({data:{groupId:f.groupId,userId:f.users[2]}});
  for(const userId of f.users.slice(0,2))await db.$transaction(tx=>applyBalanceChanges(tx,userId,[{currency:'GAME_POINTS',amount:500,ledgerType:'CREDIT',transactionType:'GAME_POINT_CREDIT',referenceType:'ADMIN',description:'Disposable fixture'}]));
  const round=await service.create(f.groupId,f.users[0],'dice',100,randomUUID());
  for(const userId of f.users)await service.join(f.groupId,userId,round);
  for(const userId of f.users.slice(0,2))await service.ready(f.groupId,userId,round,[7],PVP_POLICY,100);
  const removed=await server.inject({method:'DELETE',url:`/api/v1/groups/${f.groupId}/members/${f.users[2]}`,headers:headers(f.users[0])});
  expect(removed.statusCode,removed.body).toBe(200);
  const [entry]=await db.$queryRaw<{state:string;debit_id:string|null;refund_id:string|null}[]>`SELECT state,debit_id,refund_id FROM group_pvp_entries WHERE round_id=${round} AND user_id=${f.users[2]}`;
  expect(entry).toEqual({state:'WITHDRAWN',debit_id:null,refund_id:null});
  await service.start(f.groupId,f.users[0],round);
  expect((await service.snapshot(f.groupId,f.users[0])).round?.state).toBe('COUNTDOWN');
});
it('leaving an unpaid lobby cleans its entry without a debit or refund',async()=>{
  const f=await fixture();const service=createGroupPvpService(db);
  const round=await service.create(f.groupId,f.users[0],'dice',100,randomUUID());
  await service.join(f.groupId,f.users[1],round);
  const left=await server.inject({method:'POST',url:`/api/v1/groups/${f.groupId}/leave`,headers:headers(f.users[1])});
  expect(left.statusCode,left.body).toBe(200);
  const [entry]=await db.$queryRaw<{state:string;debit_id:string|null;refund_id:string|null}[]>`SELECT state,debit_id,refund_id FROM group_pvp_entries WHERE round_id=${round} AND user_id=${f.users[1]}`;
  expect(entry).toEqual({state:'WITHDRAWN',debit_id:null,refund_id:null});
});

it('allows only the suspended player to reverse their own unstarted PVP entry through HTTP', async () => {
 vi.stubEnv('GROUP_PVP_GAME_POINTS_ENABLED','true');
 const f=await fixture(); const service=createGroupPvpService(db);
 await db.$transaction(tx=>applyBalanceChanges(tx,f.users[1],[{currency:'GAME_POINTS',amount:500,ledgerType:'CREDIT',transactionType:'GAME_POINT_CREDIT',referenceType:'ADMIN',description:'Disposable refund fixture'}]));
 const roundId=randomUUID();
 await db.$executeRaw`INSERT INTO group_pvp_rounds(id,group_id,creator_id,request_id,game,rules_id,policy_id,entry_amount,expires_at) VALUES(${roundId},${f.groupId},${f.users[0]},${randomUUID()},'dice','group-pvp-dice-v1',${PVP_POLICY},100,clock_timestamp()+interval '15 minutes')`;
 await service.join(f.groupId,f.users[1],roundId);
 await service.ready(f.groupId,f.users[1],roundId,[7],PVP_POLICY,100);
 await db.user.update({where:{id:f.users[1]},data:{status:'SUSPENDED'}});
 const base=`/api/v1/groups/${f.groupId}/pvp/${roundId}`;
 expect((await server.inject({method:'POST',url:`${base}/withdraw`})).statusCode).toBe(401);
 expect((await server.inject({method:'POST',url:`${base}/join`,headers:headers(f.users[1])})).statusCode).toBe(403);
 // An unrelated caller cannot select a different recipient to return funds to.
 await server.inject({method:'POST',url:`${base}/withdraw`,headers:headers(f.users[2])});
 expect((await db.wallet.findUniqueOrThrow({where:{userId:f.users[1]}})).gamePointsBalance).toBe(400);
 const responses=await Promise.all([0,1].map(()=>server.inject({method:'POST',url:`${base}/withdraw`,headers:headers(f.users[1])})));
 expect(responses.map(r=>r.statusCode)).toEqual([200,200]);
 expect((await db.wallet.findUniqueOrThrow({where:{userId:f.users[1]}})).gamePointsBalance).toBe(500);
 expect((await server.inject({url:`/api/v1/groups/${f.groupId}/pvp`,headers:headers(f.users[1])})).statusCode).toBe(403);
});

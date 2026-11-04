import { PrismaClient } from '@prisma/client';
import { activationTarget } from '../practice-activation/provision.js';
async function main() {
 activationTarget(process.env,false);
 if(process.env.PRACTICE_ETB_ENABLED!=='true') throw Error('PRACTICE_ETB_DISABLED');
 const db=new PrismaClient({log:[]});
 try {
  const result=await db.$transaction(async tx=>{
   await tx.$executeRaw`SET TRANSACTION READ ONLY`;
   const [catalog]=await tx.$queryRaw<{count:number;minimum:number;maximum:number}[]>`SELECT count(*)::integer AS count,min(face_value) AS minimum,max(face_value) AS maximum FROM practice_etb_gift_catalog WHERE is_active`;
   if(catalog.count!==6||catalog.minimum<500||catalog.maximum>10000) throw Error('PRACTICE_GIFT_CATALOG_INVALID');
   const [proof]=await tx.$queryRaw<{invalid:number}[]>`SELECT count(*)::integer AS invalid FROM practice_etb_gift_accounts a WHERE balance<>(10000+COALESCE((SELECT SUM(CASE kind WHEN 'BUY' THEN -amount WHEN 'CONVERT' THEN amount ELSE 0 END) FROM practice_etb_gift_operations o WHERE o.actor_id=a.user_id),0))`;
   if(proof.invalid) throw Error('PRACTICE_GIFT_BALANCE_INVALID');
   return {catalog,balancesValid:true,currency:'PRACTICE_ETB',cashWalletConnected:false};
  },{timeout:15000});
  console.log(JSON.stringify({event:'PRACTICE_GIFTS_READY',...result}));
 } finally {await db.$disconnect();}
}
main().catch(()=>{console.error(JSON.stringify({event:'PRACTICE_GIFTS_CHECK_FAILED'}));process.exitCode=1;});

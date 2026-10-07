import {expect,it,vi} from 'vitest';
const lookup=vi.hoisted(()=>vi.fn());
vi.mock('@socialplay/database',()=>({prisma:{user:{findUnique:lookup}}}));
import {requirePermission,requireRole} from './auth.js';
it.each([{role:'USER',status:'ACTIVE'},{role:'ADMIN',status:'BANNED'},null])('rejects stale admin claims when current authority is %j',async actor=>{
 lookup.mockResolvedValue(actor);await expect(requirePermission('withdrawal:admin')({user:{sub:'u',roles:['ADMIN']}} as any,{} as any)).rejects.toThrow('Permission required');
});
it('permits an active administrator based on the current database role',async()=>{
 lookup.mockResolvedValue({role:'ADMIN',status:'ACTIVE'});await expect(requirePermission('agent:review')({user:{sub:'u',roles:['USER']}} as any,{} as any)).resolves.toBeUndefined();
});

it('rejects a stale super-admin role at the ledger boundary',async()=>{
 lookup.mockResolvedValue({role:'USER',status:'ACTIVE'});await expect(requireRole('SUPER_ADMIN')({user:{sub:'u',roles:['SUPER_ADMIN']}} as any,{} as any)).rejects.toThrow('Insufficient permissions');
});

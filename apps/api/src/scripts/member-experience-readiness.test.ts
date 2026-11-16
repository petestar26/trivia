import { describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { checkSupportReadiness } from './member-experience-readiness.js';

const reader = (rows: unknown[]) => ({ $queryRaw: async () => rows }) as unknown as Pick<Prisma.TransactionClient, '$queryRaw'>;
describe('member support readiness', () => {
  it('requires ticket and message capabilities but permits absent optional group tables', async () => {
    await expect(checkSupportReadiness(reader([{tickets:true,messages:true,groupTables:false}]))).resolves.toEqual({tickets:true,messages:true,groupTables:false});
    for (const rows of [[], [{tickets:false,messages:true}], [{tickets:true,messages:false}], [{tickets:null,messages:true}]])
      await expect(checkSupportReadiness(reader(rows))).rejects.toThrow('SUPPORT_ACCESS_UNAVAILABLE');
  });
  it.skipIf(!process.env.MEMBER_READINESS_TEST_DATABASE_URL)('accepts column-only UPDATE and rejects each missing required column in PostgreSQL', async () => {
    const url = new URL(process.env.MEMBER_READINESS_TEST_DATABASE_URL!);
    if (!['localhost','127.0.0.1','[::1]'].includes(url.hostname) || url.pathname !== '/salem_member_readiness_throwaway'
      || process.env.MEMBER_READINESS_TEST_ACK !== 'throwaway') throw Error('Acknowledged loopback throwaway database required');
    const db = new PrismaClient({datasourceUrl:url.toString(),log:[]});
    try {
      await db.$transaction(async tx => {
        await tx.$executeRawUnsafe('CREATE ROLE salem_member_readiness_test NOLOGIN');
        await tx.$executeRawUnsafe('CREATE TABLE support_tickets (id text PRIMARY KEY, status text, last_sender text, updated_at timestamptz)');
        await tx.$executeRawUnsafe('CREATE TABLE support_messages (id text PRIMARY KEY, ticket_id text REFERENCES support_tickets(id) ON UPDATE CASCADE)');
        await tx.$executeRawUnsafe('GRANT USAGE ON SCHEMA public TO salem_member_readiness_test');
        await tx.$executeRawUnsafe('GRANT SELECT, INSERT ON support_tickets, support_messages TO salem_member_readiness_test');
        await tx.$executeRawUnsafe('GRANT UPDATE(status,last_sender,updated_at) ON support_tickets TO salem_member_readiness_test');
        await tx.$executeRawUnsafe('SET LOCAL ROLE salem_member_readiness_test');
        const [rights] = await tx.$queryRaw<{whole:boolean;key:boolean}[]>`SELECT has_table_privilege(current_user,'support_tickets','UPDATE') AS whole, has_column_privilege(current_user,'support_tickets','id','UPDATE') AS key`;
        expect(rights).toEqual({whole:false,key:false});
        await expect(checkSupportReadiness(tx)).resolves.toEqual({tickets:true,messages:true,groupTables:false});
        for (const column of ['status','last_sender','updated_at']) {
          await tx.$executeRawUnsafe('RESET ROLE');
          await tx.$executeRawUnsafe(`REVOKE UPDATE(${column}) ON support_tickets FROM salem_member_readiness_test`);
          await tx.$executeRawUnsafe('SET LOCAL ROLE salem_member_readiness_test');
          await expect(checkSupportReadiness(tx)).rejects.toThrow('SUPPORT_ACCESS_UNAVAILABLE');
          await tx.$executeRawUnsafe('RESET ROLE');
          await tx.$executeRawUnsafe(`GRANT UPDATE(${column}) ON support_tickets TO salem_member_readiness_test`);
        }
        throw Error('ROLLBACK_TEST_FIXTURE');
      }).catch(error => { if (error.message !== 'ROLLBACK_TEST_FIXTURE') throw error; });
    } finally { await db.$disconnect(); }
  });
});

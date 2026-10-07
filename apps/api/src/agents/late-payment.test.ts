import { afterAll, beforeAll, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { reportSchema, refundSchema } from './late-payment-service.js';
const db = new PGlite();
beforeAll(async () => {
  await db.exec(`CREATE TABLE users(id text PRIMARY KEY); CREATE TABLE agent_orders(id text PRIMARY KEY, "paymentMethodDefId" text DEFAULT 'method'); CREATE TABLE payment_evidence(id text PRIMARY KEY, "orderId" text REFERENCES agent_orders(id), "referenceNumber" text);
 INSERT INTO users VALUES ('customer'),('admin'); INSERT INTO agent_orders(id) VALUES ('order');`);
  await db.exec(
    readFileSync(
      new URL(
        '../../../../packages/database/prisma/migrations/20261007020000_late_payment_cases/migration.sql',
        import.meta.url
      ),
      'utf8'
    )
  );
  await db.exec(readFileSync(new URL('../../../../packages/database/prisma/migrations/20261007021000_late_payment_guard_paths/migration.sql', import.meta.url), 'utf8'));
  await db.exec(readFileSync(new URL('../../../../packages/database/prisma/migrations/20261007030000_late_payment_supervision/migration.sql', import.meta.url), 'utf8'));
  await db.exec(readFileSync(new URL('../../../../packages/database/prisma/migrations/20261007031000_recovery_reference_boundary/migration.sql', import.meta.url), 'utf8'));
  await db.exec(`INSERT INTO late_payment_cases(id,"orderId","openedBy","idempotencyKey","paymentReference","paidAmount","paidAt",description)
 VALUES ('case','order','customer','request-key','PAY123',100,CURRENT_TIMESTAMP,'Report');`);
});
afterAll(() => db.close());
it('rejects malformed money and future client authority fields', () => {
  const report = {
    orderId: '00000000-0000-4000-8000-000000000001',
    idempotencyKey: 'request-key',
    paymentReference: 'abc123',
    paidAmount: 100,
    paidAt: new Date().toISOString(),
    description: 'Actual receipt',
  };
  expect(reportSchema.parse(report).paymentReference).toBe('ABC123');
  for (const paidAmount of [0, -1, 1.5, NaN, Infinity, 2147483648, '100'])
    expect(reportSchema.safeParse({ ...report, paidAmount }).success).toBe(false);
  expect(reportSchema.safeParse({ ...report, status: 'REFUNDED' }).success).toBe(false);
  expect(refundSchema.safeParse({ verified: false }).success).toBe(false);
});
it('protects immutable reports and only permits claim then complete refund', async () => {
  await expect(
    db.exec(`UPDATE late_payment_cases SET "paidAmount"=200 WHERE id='case'`)
  ).rejects.toThrow(/immutable/);
  await expect(db.exec(`DELETE FROM late_payment_cases WHERE id='case'`)).rejects.toThrow(
    /cannot be deleted/
  );
  await expect(
    db.exec(`UPDATE late_payment_cases SET status='REFUNDED' WHERE id='case'`)
  ).rejects.toThrow(/transition/);
  await db.exec(
    `UPDATE late_payment_cases SET status='ASSIGNED',"assignedAdminId"='admin',"assignedAt"=CURRENT_TIMESTAMP WHERE id='case'`
  );
  await expect(
    db.exec(`UPDATE late_payment_cases SET status='REFUNDED' WHERE id='case'`)
  ).rejects.toThrow();
  await db.exec(
    `UPDATE late_payment_cases SET status='REFUNDED',"resolutionKey"='resolve-key',"verifiedPaymentReference"='PAY123',"verifiedAmount"=100,"refundReference"='REFUND123',"refundedAt"=CURRENT_TIMESTAMP,"resolutionNote"='Verified full refund',"resolvedAt"=CURRENT_TIMESTAMP WHERE id='case'`
  );
  await expect(
    db.exec(`UPDATE late_payment_cases SET status='ASSIGNED' WHERE id='case'`)
  ).rejects.toThrow(/transition/);
});
it('prevents verified reference reuse and deletion', async () => {
  await db.exec(
    `INSERT INTO late_payment_reference_claims VALUES ('method','PAY123','case','PAYMENT')`
  );
  await expect(
    db.exec(`INSERT INTO late_payment_reference_claims VALUES ('method','PAY123','case','REFUND')`)
  ).rejects.toThrow(/duplicate key/);
  await expect(db.exec(`DELETE FROM late_payment_reference_claims`)).rejects.toThrow(/immutable/);
});

it('pins invoker guards to the canonical platform search path', async () => {
 const result=await db.query<{prosecdef:boolean;proconfig:string[]}>("SELECT prosecdef,proconfig FROM pg_proc WHERE proname IN ('guard_late_payment_case','guard_late_payment_reference')");
 expect(result.rows).toHaveLength(2);
 for(const row of result.rows){expect(row.prosecdef).toBe(false);expect(row.proconfig).toContain('search_path=public, pg_temp');}
});

it('allows assignment release and reasoned rejection while keeping final history immutable', async () => {
  await db.exec(`INSERT INTO agent_orders(id) VALUES ('reject-order');
    INSERT INTO late_payment_cases(id,"orderId","openedBy","idempotencyKey","paymentReference","paidAmount","paidAt",description)
    VALUES ('reject-case','reject-order','customer','request-key2','PAY456',100,CURRENT_TIMESTAMP,'Report');
    UPDATE late_payment_cases SET status='ASSIGNED',"assignedAdminId"='admin',"assignedAt"=CURRENT_TIMESTAMP WHERE id='reject-case';
    UPDATE late_payment_cases SET status='OPEN',"assignedAdminId"=NULL,"assignedAt"=NULL WHERE id='reject-case';
    UPDATE late_payment_cases SET status='ASSIGNED',"assignedAdminId"='admin',"assignedAt"=CURRENT_TIMESTAMP WHERE id='reject-case';`);
  await expect(db.exec(`UPDATE late_payment_cases SET status='REJECTED' WHERE id='reject-case'`)).rejects.toThrow();
  await db.exec(`UPDATE late_payment_cases SET status='REJECTED',"resolutionKey"='reject-key',"resolutionNote"='Transfer not verified',"resolvedAt"=CURRENT_TIMESTAMP WHERE id='reject-case'`);
  await expect(db.exec(`UPDATE late_payment_cases SET status='OPEN',"assignedAdminId"=NULL,"assignedAt"=NULL WHERE id='reject-case'`)).rejects.toThrow(/transition/);
  await expect(db.exec(`UPDATE late_payment_cases SET "resolutionNote"='Changed decision' WHERE id='reject-case'`)).rejects.toThrow(/transition/);
});

it('guards recovery references against normalized legacy evidence in both write directions', async () => {
  await db.exec(`INSERT INTO agent_orders(id) VALUES ('legacy-order');
    INSERT INTO payment_evidence VALUES ('legacy','legacy-order',' legacy-ref ');`);
  await expect(db.exec(`INSERT INTO late_payment_reference_claims VALUES ('method','LEGACY-REF','case','PAYMENT')`)).rejects.toThrow(/existing deposit evidence/);
  await expect(db.exec(`INSERT INTO payment_evidence VALUES ('reuse','legacy-order',' pay123 ')`)).rejects.toThrow(/already used/);
  await db.exec(`INSERT INTO payment_evidence VALUES ('own','order','PAY123')`);
  await expect(db.exec(`INSERT INTO late_payment_reference_claims VALUES ('method','PAY123','case','REFUND')`)).rejects.toThrow();
  await expect(db.exec(`INSERT INTO late_payment_reference_claims VALUES ('wrong-method','UNIQUE','case','PAYMENT')`)).rejects.toThrow(/provider/);
});

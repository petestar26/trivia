import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
const root = new URL('../../../', import.meta.url);
const config = JSON.parse(readFileSync(new URL('reset-cutover.railway.json', import.meta.url)));
const expected = [
  'pnpm --filter @socialplay/database exec prisma migrate status',
  'node apps/api/dist/scripts/practice-activation.js --check',
  'node apps/api/dist/scripts/practice-gifts-check.js',
  'node apps/api/dist/scripts/payment-readiness.js',
  'node apps/api/dist/scripts/member-experience-check.js',
];
test('overrides only predeploy, retaining platform build/start/network/replica settings', () => {
  assert.deepEqual(Object.keys(config).sort(), ['$schema', 'deploy']);
  assert.deepEqual(Object.keys(config.deploy), ['preDeployCommand']);
});
test('status check then all four current product checks, fail closed using &&', () => {
  assert.deepEqual(config.deploy.preDeployCommand, [expected.join(' && ')]);
  assert.doesNotMatch(config.deploy.preDeployCommand[0], /migrate:deploy|migrate deploy|--apply|\|\||;|\n/);
});
test('each checked entrypoint exists in this exact baseline', () => {
  for (const command of expected.slice(1)) {
    const source = command.split(' ')[1].replace('/dist/', '/src/').replace(/\.js$/, '.ts');
    assert.ok(readFileSync(new URL(source, root)).length > 0);
  }
});
test('migration SQL remains exact baseline 130-file manifest', () => {
  const dir = new URL('packages/database/prisma/migrations/', root);
  const manifest = readdirSync(dir, { withFileTypes: true }).filter(x => x.isDirectory())
    .map(x => x.name).sort().map(name => {
      const hash = createHash('sha256').update(readFileSync(new URL(`${name}/migration.sql`, dir))).digest('hex');
      return `${name} ${hash}\n`;
    }).join('');
  assert.equal(manifest.split('\n').filter(Boolean).length, 130);
  assert.equal(createHash('sha256').update(manifest).digest('hex'), 'bce3be9647860349edc8266ddf0b3ecf10c034a59d270aae2fa222ea5103ef1e');
});

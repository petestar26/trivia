// Negative test for the visual audit's failure gate.
//
//   node --test evidence/member-mobile-ui-review/review.selftest.cjs
//
// The rule tests always run. The end-to-end tests run when REVIEW_ORIGIN (a loopback web
// server) and PLAYWRIGHT_MODULE are set: they launch the real audit against one page, once
// untouched and once per deliberately injected defect, and assert the process exit code.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { evaluate } = require('./gate.cjs');

const clean = () => ({
  id: 'page.en.390',
  overflow: false,
  writes: [],
  pageErrors: [],
  external: [],
  lang: 'en',
  expectLang: 'en',
  dir: 'ltr',
  expectDir: 'ltr',
  touchRequired: true,
  smallTargets: [],
  unlabelled: [],
  focus: { focusable: 5, missingIndicator: [] },
  alerts: 0,
  statusRegions: 0,
});

test('a clean render passes', () => {
  assert.deepEqual(evaluate([clean()]), { ok: true, failures: [] });
});

test('an audit that rendered nothing fails', () => {
  assert.equal(evaluate([]).ok, false);
});

const DEFECTS = {
  render: { error: 'Timeout' },
  'horizontal-overflow': { overflow: true },
  'unexpected-write': { writes: ['POST /agent-orders'] },
  'page-error': { pageErrors: ['boom'] },
  'external-origin': { external: ['https://example.invalid'] },
  language: { lang: 'en', expectLang: 'am' },
  direction: { dir: 'ltr', expectDir: 'rtl' },
  'touch-target': { smallTargets: ['button "x" 20x20'] },
  'unlabelled-control': { unlabelled: ['input ""'] },
  'focus-indicator': { focus: { focusable: 5, missingIndicator: ['button "x"'] } },
  'error-state': { expectAlert: true, alerts: 0 },
  'loading-state': { expectStatus: true, statusRegions: 0 },
};
for (const [check, change] of Object.entries(DEFECTS))
  test(`a render with a ${check} defect fails`, () => {
    const verdict = evaluate([clean(), { ...clean(), ...change }]);
    assert.equal(verdict.ok, false);
    assert.deepEqual(
      verdict.failures.map((f) => f.check),
      [check]
    );
  });

test('small targets are reported but not required where touch is not required', () => {
  assert.equal(
    evaluate([{ ...clean(), touchRequired: false, smallTargets: ['a "x" 20x20'] }]).ok,
    true
  );
});

const live = !!process.env.REVIEW_ORIGIN && !!process.env.PLAYWRIGHT_MODULE;
function audit(inject) {
  const out = mkdtempSync(join(tmpdir(), 'salem-gate-'));
  return spawnSync(process.execPath, [join(__dirname, 'review.cjs'), 'selftest', out], {
    env: {
      ...process.env,
      REVIEW_ONLY: '^order-room$',
      REVIEW_CELL: '^en\.390$',
      REVIEW_INJECT: inject,
    },
    encoding: 'utf8',
    timeout: 180000,
  });
}
test('end to end: the untouched page exits 0', { skip: !live }, () => {
  const run = audit('');
  assert.equal(run.status, 0, run.stdout + run.stderr);
});
for (const [inject, check] of [
  ['overflow', 'horizontal-overflow'],
  ['small-target', 'touch-target'],
  ['page-error', 'page-error'],
  ['write', 'unexpected-write'],
])
  test(`end to end: an injected ${inject} defect exits 1`, { skip: !live }, () => {
    const run = audit(inject);
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout, new RegExp(`\[${check}\]`));
  });

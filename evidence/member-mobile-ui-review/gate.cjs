// Pass/fail rules for the visual audit. Pure functions so the gate itself can be tested.
const TOUCH_MIN = 44;

// Returns one human-readable failure per broken required check in a single render.
function failuresFor(entry) {
  const out = [];
  const add = (check, detail) => out.push({ id: entry.id, check, detail });
  if (entry.error) add('render', entry.error);
  if (entry.overflow)
    add(
      'horizontal-overflow',
      (entry.overflowDetail || []).join('; ') || 'document is wider than the viewport'
    );
  for (const write of entry.writes || []) add('unexpected-write', write);
  for (const message of entry.pageErrors || []) add('page-error', message);
  for (const item of entry.external || []) add('external-origin', item);
  if (entry.expectLang && entry.lang !== entry.expectLang)
    add('language', `html lang is ${entry.lang}, expected ${entry.expectLang}`);
  if (entry.expectDir && entry.dir !== entry.expectDir)
    add('direction', `html dir is ${entry.dir}, expected ${entry.expectDir}`);
  if (entry.touchRequired) for (const item of entry.smallTargets || []) add('touch-target', item);
  for (const item of entry.unlabelled || []) add('unlabelled-control', item);
  if (entry.focus)
    for (const item of entry.focus.missingIndicator || []) add('focus-indicator', item);
  if (entry.expectAlert && !entry.alerts) add('error-state', 'no role=alert region was rendered');
  if (entry.expectStatus && !entry.statusRegions)
    add('loading-state', 'no role=status region was rendered');
  return out;
}

function evaluate(results) {
  const failures = results.flatMap(failuresFor);
  if (!results.length)
    failures.push({ id: '-', check: 'coverage', detail: 'no render was audited' });
  return { ok: failures.length === 0, failures };
}

module.exports = { TOUCH_MIN, failuresFor, evaluate };

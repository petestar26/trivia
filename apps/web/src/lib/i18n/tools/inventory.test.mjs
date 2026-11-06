import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectSource, buildInventory } from './inventory.mjs';

const keys = (result) =>
  result.records.filter((row) => row.kind === 'translation-key').map((row) => row.text);

test('includes display helpers while excluding catalogue and formatter implementation text', () => {
  for (const filename of ['game-labels.ts', 'together-text.ts', 'labels.ts']) {
    assert.deepEqual(keys(inspectSource(`/fixture/lib/i18n/${filename}`, "t('Visible label');")), [
      'Visible label',
    ]);
  }
  for (const filename of [
    'catalogues/demo.ts',
    'catalogue.ts',
    'format.ts',
    'types.ts',
    'validation.ts',
    'text.tsx',
    'tools/demo.ts',
    'game-labels.test.ts',
  ]) {
    assert.deepEqual(
      inspectSource(
        `/fixture/lib/i18n/${filename}`,
        "t('Internal text'); const x = <p>Not interface content</p>;"
      ).records,
      []
    );
  }
});

test('collects nested conditional output keys and unwraps parentheses and type syntax', () => {
  const source = [
    "t((state === 'TECHNICAL_CODE' ? ('Open') : ready ? (`Ready`) : ('Closed' as const)));",
    "translateUi2(((flag ? 'Enabled' : 'Disabled') satisfies string));",
    "translateInterface(('Unchanged'));",
    "t(username); t(`Hello ${username}`); t('Prefix ' + username);",
  ].join('\n');
  const result = inspectSource('/fixture/page.tsx', source);
  assert.deepEqual(keys(result), ['Open', 'Ready', 'Closed', 'Enabled', 'Disabled', 'Unchanged']);
  assert.equal(result.records[0].line, 1);
  assert.equal(result.records.find((row) => row.text === 'Disabled').line, 2);
  assert.ok(!result.records.some((row) => row.text === 'TECHNICAL_CODE' || row.text === 'Prefix '));
});

test('recognizes localized message attributes without also reporting their branches as raw JSX', () => {
  const source = `<><LocalizedText message="Saved" />
    <LocalizedText message={(ready ? 'Ready now' : ('Waiting'))} values={{name: user.name}} />
    <LocalizedText message={notice} />
    <button aria-label={ready ? 'Raw ready label' : 'Raw waiting label'}>Raw button</button></>`;
  const result = inspectSource('/fixture/page.tsx', source);
  assert.deepEqual(keys(result), ['Saved', 'Ready now', 'Waiting']);
  const raw = result.records
    .filter((row) => row.kind !== 'translation-key')
    .map((row) => row.text.trim());
  assert.deepEqual(raw, ['Raw ready label', 'Raw waiting label', 'Raw button']);
});

test('follows reachable helper imports and does not retain records from an earlier audit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'salem-i18n-inventory-'));
  try {
    const helperDirectory = join(directory, 'lib/i18n');
    await mkdir(join(helperDirectory, 'catalogues'), { recursive: true });
    const entry = join(directory, 'main.tsx');
    await writeFile(
      entry,
      "import './lib/i18n/game-labels';\nimport './lib/i18n/format';\nt('Page title');"
    );
    await writeFile(
      join(helperDirectory, 'game-labels.ts'),
      "export const label = ready => t(ready ? 'Ready helper' : 'Waiting helper');"
    );
    await writeFile(
      join(helperDirectory, 'format.ts'),
      "import './catalogues/demo';\nt('Internal formatter');"
    );
    await writeFile(
      join(helperDirectory, 'catalogues/demo.ts'),
      "export default {label: 'Dictionary content'};"
    );
    const first = await buildInventory(entry);
    assert.deepEqual(keys(first), ['Page title', 'Ready helper', 'Waiting helper']);
    assert.equal(first.files.length, 4);
    await writeFile(entry, "t('Replacement page');");
    const second = await buildInventory(entry);
    assert.deepEqual(keys(second), ['Replacement page']);
    assert.equal(second.files.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

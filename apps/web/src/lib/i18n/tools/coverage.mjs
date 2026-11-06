// Read-only coverage audit of the application's reachable module graph.
// Missing catalogue entries are never counted as translated English fallbacks.
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile, readdir, readFile } from 'node:fs/promises';
import { buildInventory } from './inventory.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..');
const require = createRequire(resolve(root, 'apps/web/package.json'));
const ts = require('typescript');
const directory = resolve(root, 'apps/web/src/lib/i18n');
// Catalogue files are source-owned static modules. Transpile them offline;
// never start a Vite/network server just to audit a translation dictionary.
const cache = new Map();
async function load(file) {
  if (cache.has(file)) return cache.get(file);
  const source = await readFile(file, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const dependencies = {};
  for (const match of output.matchAll(/require\("([^"\n]+)"\)/g)) {
    if (!match[1].startsWith('./'))
      throw new Error('Unexpected runtime catalogue dependency: ' + match[1]);
    dependencies[match[1]] = await load(resolve(dirname(file), match[1] + '.ts'));
  }
  new Function('module', 'exports', 'require', output)(
    module,
    module.exports,
    (name) => dependencies[name]
  );
  cache.set(file, module.exports);
  return module.exports;
}
const { mergeCatalogues, validateCatalogue } = await load(resolve(directory, 'validation.ts'));
const chunks = {};
for (const file of (await readdir(resolve(directory, 'catalogues'))).filter((file) =>
  file.endsWith('.ts')
)) {
  chunks[file] = (await load(resolve(directory, 'catalogues', file))).default;
}
const catalogue = mergeCatalogues(chunks);
const catalogueOutput = process.argv.indexOf('--catalogue-json');
if (catalogueOutput >= 0)
  await writeFile(
    resolve(process.argv[catalogueOutput + 1]),
    JSON.stringify(catalogue, null, 2) + '\n'
  );
{
  const { files, records } = await buildInventory();
  const calls = records.filter((record) => record.kind === 'translation-key');
  const keys = [...new Set(calls.map((record) => record.text))].sort();
  const missing = keys.filter((key) => !Object.hasOwn(catalogue, key));
  const raw = records.filter((record) => record.kind !== 'translation-key');
  const issues = validateCatalogue(catalogue);
  const report = {
    generatedAt: new Date().toISOString(),
    reachableModules: files.length,
    usedKeys: keys.length,
    coveredKeys: keys.length - missing.length,
    catalogueKeys: Object.keys(catalogue).length,
    validationIssues: issues,
    missing: missing.map((key) => ({
      key,
      locations: calls.filter((record) => record.text === key),
    })),
    // These require human review: metadata can be rendered through t(variable),
    // while names, codes, user messages and technical evidence must stay intact.
    reviewRequired: raw,
  };
  const output = process.argv.indexOf('--json');
  if (output >= 0)
    await writeFile(resolve(process.argv[output + 1]), JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify({ ...report, missing: missing.length, reviewRequired: raw.length }, null, 2)
  );
  if (issues.length || (process.argv.includes('--strict') && missing.length)) process.exitCode = 1;
}

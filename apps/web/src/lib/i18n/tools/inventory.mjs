import { readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, resolve, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url),
  ts = require('typescript');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..');
const web = resolve(root, 'apps/web/src');
const attributes = new Set([
  'title',
  'placeholder',
  'aria-label',
  'alt',
  'label',
  'description',
  'emptyText',
  'tooltip',
  'hint',
  'helperText',
  'message',
  'text',
  'caption',
]);
const dataNames = new Set([
  'title',
  'description',
  'label',
  'rules',
  'message',
  'heading',
  'detail',
  'body',
  'placeholder',
  'emptyTitle',
  'emptyDescription',
  'actionLabel',
  'alt',
  'ariaLabel',
  'hint',
  'help',
  'text',
  'caption',
  'reason',
]);
export function jsxText(text) {
  const lines = text.split(/\r\n|\n|\r/);
  let last = 0;
  for (let i = 0; i < lines.length; i++) if (/[^ \t]/.test(lines[i])) last = i;
  let result = '';
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].replace(/\t/g, ' ');
    if (i !== 0) line = line.replace(/^ +/, '');
    if (i !== lines.length - 1) line = line.replace(/ +$/, '');
    if (line) {
      result += line;
      if (i !== last) result += ' ';
    }
  }
  return result;
}
const readable = (text) =>
  /[A-Za-z]/.test(text) && !/^https?:\/\//.test(text) && !/^\/[a-z0-9/_:.-]+$/i.test(text);
const name = (node) => node && ('text' in node ? node.text : node.getText());
function displayed(node) {
  let at = node;
  while (at.parent) {
    const p = at.parent;
    if (ts.isCallExpression(p)) return false;
    if (
      ts.isBinaryExpression(p) &&
      ![
        ts.SyntaxKind.PlusToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken,
      ].includes(p.operatorToken.kind)
    )
      return false;
    if (ts.isConditionalExpression(p) && p.condition === at) return false;
    if (ts.isJsxAttribute(p)) return attributes.has(name(p.name));
    if (ts.isJsxExpression(p)) {
      if (p.parent && ts.isJsxAttribute(p.parent)) return attributes.has(name(p.parent.name));
      return true;
    }
    if (ts.isStatement(p) || ts.isSourceFile(p)) return false;
    at = p;
  }
  return false;
}
async function target(specifier, from) {
  let base;
  if (specifier.startsWith('@/')) base = resolve(web, specifier.slice(2));
  else if (specifier === '@socialplay/shared') base = resolve(root, 'packages/shared/src/index');
  else if (specifier.startsWith('@socialplay/shared/'))
    base = resolve(root, 'packages/shared/src', specifier.slice(19));
  else if (specifier.startsWith('.')) base = resolve(dirname(from), specifier);
  else return null;
  const bare = /\.[cm]?jsx?$/.test(base) ? base.replace(/\.[cm]?jsx?$/, '') : base;
  for (const file of [
    base,
    bare + '.tsx',
    bare + '.ts',
    resolve(base, 'index.tsx'),
    resolve(base, 'index.ts'),
  ]) {
    if (!/\.tsx?$/.test(file) || /\.test\./.test(file)) continue;
    try {
      if ((await stat(file)).isFile()) return file;
    } catch {}
  }
  return null;
}
// Display helpers contain real interface messages; only dictionary/runtime
// infrastructure is excluded, rather than the whole i18n directory.
const implementationFiles = new Set([
  'catalogue.ts',
  'format.ts',
  'types.ts',
  'validation.ts',
  'text.tsx',
]);
function isImplementationSource(file) {
  const part = file.replaceAll('\\', '/').split('/lib/i18n/')[1];
  return (
    part !== undefined &&
    (part.startsWith('catalogues/') ||
      part.startsWith('tools/') ||
      implementationFiles.has(part) ||
      /\.test\.[cm]?[jt]sx?$/.test(part))
  );
}
function literalBranches(expression) {
  if (!expression) return [];
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression))
    return [expression];
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression)
  )
    return literalBranches(expression.expression);
  if (ts.isConditionalExpression(expression))
    return [...literalBranches(expression.whenTrue), ...literalBranches(expression.whenFalse)];
  // Dynamic content is not a static key. In particular, never collect the
  // comparison literal in a condition or fragments of interpolated user text.
  return [];
}
export function inspectSource(file, source) {
  const records = [];
  const translatedLiterals = new WeakSet();
  const ast = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const deps = [];
  const add = (node, text, kind) => {
    if (!readable(text)) return;
    const lc = ast.getLineAndCharacterOfPosition(node.getStart(ast));
    records.push({
      file: relative(root, file),
      line: lc.line + 1,
      column: lc.character + 1,
      kind,
      text,
    });
  };
  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      deps.push(node.moduleSpecifier.text);
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      ts.isStringLiteral(node.arguments[0])
    )
      deps.push(node.arguments[0].text);
    if (!isImplementationSource(file)) {
      if (ts.isJsxText(node)) add(node, jsxText(node.text), 'jsx-text');
      if (ts.isJsxAttribute(node) && attributes.has(name(node.name)) && node.initializer) {
        const tag = node.parent.parent;
        const translated =
          name(node.name) === 'message' &&
          (ts.isJsxOpeningElement(tag) || ts.isJsxSelfClosingElement(tag)) &&
          /^(LocalizedText|LocalizedRichText)$/.test(name(tag.tagName));
        const expression = ts.isJsxExpression(node.initializer)
          ? node.initializer.expression
          : node.initializer;
        if (translated) {
          for (const literal of literalBranches(expression)) {
            translatedLiterals.add(literal);
            add(literal, literal.text, 'translation-key');
          }
        } else if (ts.isStringLiteral(node.initializer)) {
          add(node.initializer, node.initializer.text, 'jsx-attribute');
        }
      }
      if (
        (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
        displayed(node) &&
        !ts.isJsxAttribute(node.parent) &&
        !translatedLiterals.has(node)
      )
        add(node, node.text, 'jsx-expression');
      if (
        ts.isPropertyAssignment(node) &&
        dataNames.has(name(node.name)) &&
        (ts.isStringLiteral(node.initializer) ||
          ts.isNoSubstitutionTemplateLiteral(node.initializer))
      )
        add(node.initializer, node.initializer.text, 'message-data');
      if (ts.isCallExpression(node)) {
        const callee = name(node.expression);
        if (/^(t|translate|translateInterface|translateUi\d*)$/.test(callee))
          for (const literal of literalBranches(node.arguments[0]))
            add(literal, literal.text, 'translation-key');
        if (/^(getErrorMessage|setNotice|setError|setMessage)$/.test(callee))
          for (const arg of node.arguments)
            if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))
              add(arg, arg.text, 'runtime-message');
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return { records, dependencies: deps };
}
async function scan(file, seen, records) {
  if (seen.has(file)) return;
  seen.add(file);
  const source = inspectSource(file, await readFile(file, 'utf8'));
  records.push(...source.records);
  for (const dep of source.dependencies) {
    const resolved = await target(dep, file);
    if (resolved) await scan(resolved, seen, records);
  }
}
export async function buildInventory(entry = resolve(web, 'main.tsx')) {
  const seen = new Set(),
    records = [];
  await scan(entry, seen, records);
  return { files: [...seen], records };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { files, records } = await buildInventory();
  const unique = [...new Set(records.map((r) => r.text.trim()))].sort();
  const output = {
    generatedAt: new Date().toISOString(),
    modules: files.length,
    records: records.length,
    uniqueMessages: unique.length,
    counts: Object.fromEntries(
      [...new Set(records.map((r) => r.kind))].map((kind) => [
        kind,
        records.filter((r) => r.kind === kind).length,
      ])
    ),
    messages: unique,
    locations: records,
  };
  const index = process.argv.indexOf('--json');
  if (index >= 0)
    await writeFile(resolve(process.argv[index + 1]), JSON.stringify(output, null, 2) + '\n');
  console.log(JSON.stringify({ ...output, messages: undefined, locations: undefined }, null, 2));
}

// Offline, AST-guided migration. Dry run is the default; --apply is explicit.
// Only source-owned scalar UI messages are changed. IDs, data, user content,
// conditions, markup-rich paragraphs and unrecognized scopes remain untouched.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { buildInventory, jsxText } from './inventory.mjs';
const require = createRequire(import.meta.url),
  ts = require('typescript');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..');
const web = resolve(root, 'apps/web/src');
const webRequire = createRequire(resolve(root, 'apps/web/package.json'));
const { JSDOM } = webRequire('jsdom'),
  textarea = new JSDOM('').window.document.createElement('textarea');
const decode = (text) => {
  textarea.innerHTML = text;
  return textarea.textContent ?? '';
};
const attrs = new Set([
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
const readable = (text) =>
  /[A-Za-z]/.test(text) && !/^https?:\/\//.test(text) && !/^\/[a-z0-9/_:.-]+$/i.test(text);
const inventory = await buildInventory();
const configPath = resolve(root, 'apps/web/tsconfig.json'),
  parsed = ts.getParsedCommandLineOfConfigFile(
    configPath,
    {},
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} }
  );
const program = ts.createProgram({
    rootNames: inventory.files.filter((file) => file.startsWith(web)),
    options: parsed.options,
  }),
  checker = program.getTypeChecker();
const messages = new Map(),
  manual = [],
  changes = [];
const excluded = (file) =>
  /\/lib\/i18n\/|\/providers\/language-provider|\/pages\/play-together|\/components\/together\/|\/components\/groups\/(?:group-social-nav|group-round-activity)/.test(
    file
  );
for (const file of inventory.files) {
  if (!file.startsWith(web) || !file.endsWith('.tsx') || excluded(file)) continue;
  const source = await readFile(file, 'utf8'),
    ast = program.getSourceFile(file);
  if (!ast) continue;
  const identifiers = new Set();
  function names(n) {
    if (ts.isIdentifier(n)) identifiers.add(n.text);
    ts.forEachChild(n, names);
  }
  names(ast);
  const unique = (base) => {
    let value = base,
      n = 2;
    while (identifiers.has(value)) value = base + n++;
    identifiers.add(value);
    return value;
  };
  const alias = unique('translateUi'),
    hook = unique('useInterfaceLanguage'),
    locale = unique('interfaceLocale');
  const edits = [],
    components = new Map(),
    claimed = [];
  const loc = (node) => ({
    file: relative(root, file),
    line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
  });
  const record = (message, node) => {
    const locations = messages.get(message) ?? [];
    locations.push(loc(node));
    messages.set(message, locations);
  };
  function component(node) {
    for (let p = node; p; p = p.parent) {
      if (ts.isFunctionDeclaration(p) && p.name && /^[A-Z]/.test(p.name.text) && p.body) return p;
      if (
        (ts.isArrowFunction(p) || ts.isFunctionExpression(p)) &&
        ts.isVariableDeclaration(p.parent) &&
        ts.isIdentifier(p.parent.name) &&
        /^[A-Z]/.test(p.parent.name.text)
      )
        return p;
    }
    return null;
  }
  function scalar(node) {
    let type = checker.getTypeAtLocation(node);
    const check = (t) =>
      t.isUnion()
        ? t.types.every(check)
        : !!(
            t.flags &
            (ts.TypeFlags.StringLike |
              ts.TypeFlags.NumberLike |
              ts.TypeFlags.Null |
              ts.TypeFlags.Undefined |
              ts.TypeFlags.Never)
          );
    return check(type);
  }
  const raw = (node) => node.getText(ast);
  function call(message, node, values = []) {
    const trimmed = message.trim();
    if (!readable(trimmed)) return null;
    record(trimmed, node);
    const prefix = message.slice(0, message.indexOf(trimmed)),
      suffix = message.slice(message.indexOf(trimmed) + trimmed.length);
    const result =
      alias +
      '(' +
      JSON.stringify(trimmed) +
      (values.length
        ? ', {' + values.map(([name, value]) => name + ': ' + value).join(', ') + '}'
        : '') +
      ')';
    return (
      (prefix ? JSON.stringify(prefix) + ' + ' : '') +
      result +
      (suffix ? ' + ' + JSON.stringify(suffix) : '')
    );
  }
  function slots(parts, node) {
    let message = '',
      values = [],
      literal = false;
    const used = new Map();
    for (const part of parts) {
      if (typeof part === 'string') {
        message += part;
        literal ||= /[A-Za-z]/.test(part);
        continue;
      }
      if (!scalar(part)) return null;
      let name = ts.isIdentifier(part)
        ? part.text
        : ts.isPropertyAccessExpression(part)
          ? part.name.text
          : 'value';
      name = name.replace(/[^A-Za-z0-9_]/g, '');
      if (!/^[A-Za-z]/.test(name)) name = 'value';
      const code = render(part) ?? raw(part);
      let key = name,
        n = 2;
      while (used.has(key) && used.get(key) !== code) key = name + n++;
      if (!used.has(key)) {
        used.set(key, code);
        const nullable = (type) =>
          type.isUnion()
            ? type.types.some(nullable)
            : !!(type.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined));
        values.push([
          key,
          nullable(checker.getTypeAtLocation(part)) ? '((' + code + ") ?? '')" : '(' + code + ')',
        ]);
      }
      message += '{' + key + '}';
    }
    return literal ? call(message, node, values) : null;
  }
  function render(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString'].includes(
        node.expression.name.text
      )
    ) {
      const args = [...node.arguments].map(raw);
      if (!args.length) args.push(locale);
      else if (args[0] === 'undefined') args[0] = locale;
      return raw(node.expression) + '(' + args.join(', ') + ')';
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      return call(node.text, node);
    if (ts.isParenthesizedExpression(node)) {
      const value = render(node.expression);
      return value ? '(' + value + ')' : null;
    }
    if (ts.isTemplateExpression(node)) {
      const parts = [node.head.text];
      for (const span of node.templateSpans) parts.push(span.expression, span.literal.text);
      return slots(parts, node);
    }
    if (ts.isConditionalExpression(node)) {
      const yes = render(node.whenTrue),
        no = render(node.whenFalse);
      return yes || no
        ? '(' +
            raw(node.condition) +
            ' ? ' +
            (yes ?? raw(node.whenTrue)) +
            ' : ' +
            (no ?? raw(node.whenFalse)) +
            ')'
        : null;
    }
    if (ts.isBinaryExpression(node)) {
      if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        const parts = [];
        function split(value) {
          if (
            ts.isBinaryExpression(value) &&
            value.operatorToken.kind === ts.SyntaxKind.PlusToken &&
            checker.getTypeAtLocation(value).flags & ts.TypeFlags.StringLike
          ) {
            split(value.left);
            split(value.right);
          } else if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))
            parts.push(value.text);
          else parts.push(value);
        }
        split(node);
        if (parts.length > 1) return slots(parts, node);
      }
      if (
        [
          ts.SyntaxKind.BarBarToken,
          ts.SyntaxKind.AmpersandAmpersandToken,
          ts.SyntaxKind.QuestionQuestionToken,
        ].includes(node.operatorToken.kind)
      ) {
        const right = render(node.right);
        return right
          ? '(' + raw(node.left) + ' ' + node.operatorToken.getText(ast) + ' ' + right + ')'
          : null;
      }
    }
    return null;
  }
  function add(node, text, scope) {
    const start = node.getStart(ast),
      end = node.end;
    if (edits.some((e) => start < e.end && end > e.start)) return false;
    edits.push({ start, end, text });
    components.set(scope.pos, scope);
    return true;
  }
  function visit(node) {
    if (claimed.some(([start, end]) => node.pos >= start && node.end <= end)) return;
    const scope = component(node);
    if (scope && (ts.isJsxElement(node) || ts.isJsxFragment(node))) {
      const parts = [];
      let supported = true;
      for (const child of node.children) {
        if (ts.isJsxText(child)) parts.push(decode(jsxText(child.text)));
        else if (ts.isJsxExpression(child) && child.expression) {
          if (
            ts.isStringLiteral(child.expression) ||
            ts.isNoSubstitutionTemplateLiteral(child.expression)
          )
            parts.push(child.expression.text);
          else parts.push(child.expression);
        } else if (ts.isJsxExpression(child) && !child.expression) {
        } else supported = false;
      }
      if (supported && node.children.length) {
        const message = slots(parts, node);
        if (message) {
          edits.push({
            start: node.children.pos,
            end: node.children.end,
            text: '{' + message + '}',
          });
          claimed.push([node.children.pos, node.children.end]);
          components.set(scope.pos, scope);
        }
      } else if (node.children.some((c) => ts.isJsxText(c) && readable(jsxText(c.text))))
        manual.push({ ...loc(node), kind: 'rich-content', text: node.getText(ast).slice(0, 180) });
    }
    if (scope && ts.isJsxText(node)) {
      const message = call(decode(jsxText(node.text)), node);
      if (message) {
        edits.push({ start: node.pos, end: node.end, text: '{' + message + '}' });
        components.set(scope.pos, scope);
      }
    }
    if (scope && ts.isJsxAttribute(node) && attrs.has(node.name.getText(ast)) && node.initializer) {
      if (ts.isStringLiteral(node.initializer)) {
        const message = call(decode(node.initializer.text), node);
        if (message) add(node.initializer, '{' + message + '}', scope);
      } else if (ts.isJsxExpression(node.initializer) && node.initializer.expression) {
        const value = render(node.initializer.expression);
        if (value && add(node.initializer.expression, value, scope))
          claimed.push([node.initializer.expression.pos, node.initializer.expression.end]);
      }
    }
    if (scope && ts.isJsxExpression(node) && node.expression && !ts.isJsxAttribute(node.parent)) {
      const message = render(node.expression);
      if (message) {
        add(node.expression, message, scope);
        claimed.push([node.expression.pos, node.expression.end]);
      }
    }
    if (
      scope &&
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString'].includes(
        node.expression.name.text
      )
    ) {
      if (!node.arguments.length) {
        const at = node.end - 1;
        edits.push({ start: at, end: at, text: locale });
        components.set(scope.pos, scope);
      } else if (ts.isIdentifier(node.arguments[0]) && node.arguments[0].text === 'undefined')
        add(node.arguments[0], locale, scope);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (!edits.length) continue;
  const declaration = '\n  const {t: ' + alias + ', locale: ' + locale + '} = ' + hook + '();\n';
  for (const scope of components.values())
    if (ts.isBlock(scope.body))
      edits.push({
        start: scope.body.getStart(ast) + 1,
        end: scope.body.getStart(ast) + 1,
        text: declaration,
      });
    else {
      edits.push({
        start: scope.body.getStart(ast),
        end: scope.body.getStart(ast),
        text: '{' + declaration + 'return (',
      });
      edits.push({ start: scope.body.end, end: scope.body.end, text: ');}' });
    }
  const imports = ast.statements.filter(ts.isImportDeclaration);
  const at = imports.at(-1)?.end ?? 0;
  edits.push({
    start: at,
    end: at,
    text: '\nimport {useLanguage as ' + hook + "} from '@/providers/language-provider';\n",
  });
  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  let updated = source;
  for (const edit of edits)
    updated = updated.slice(0, edit.start) + edit.text + updated.slice(edit.end);
  const syntax = ts.createSourceFile(
    file,
    updated,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  ).parseDiagnostics;
  if (syntax.length) {
    await writeFile('/private/tmp/salem-i18n-transform-error.tsx', updated);
    console.error(
      syntax.map((d) => ({
        start: d.start,
        message: ts.flattenDiagnosticMessageText(d.messageText, ' '),
      }))
    );
    throw Error('Generated syntax error in ' + relative(root, file));
  }
  changes.push({ file: relative(root, file), edits: edits.length, components: components.size });
  if (process.argv.includes('--apply')) await writeFile(file, updated);
}
const keys = [...messages.keys()].sort();
await writeFile('/private/tmp/salem-interface-english.json', JSON.stringify(keys, null, 2) + '\n');
await writeFile(
  '/private/tmp/salem-i18n-codemod-plan.json',
  JSON.stringify(
    {
      applied: process.argv.includes('--apply'),
      changes,
      messages: Object.fromEntries(messages),
      manual,
    },
    null,
    2
  ) + '\n'
);
console.log(
  JSON.stringify(
    {
      applied: process.argv.includes('--apply'),
      files: changes.length,
      messages: keys.length,
      manualRichContent: manual.length,
    },
    null,
    2
  )
);

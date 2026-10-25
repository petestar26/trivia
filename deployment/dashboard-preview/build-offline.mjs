import { readFileSync, writeFileSync, existsSync, symlinkSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';

const qa = path.dirname(fileURLToPath(import.meta.url));
const root = realpathSync(path.resolve(qa, '../../apps/web'));
const sha = (value) => createHash('sha256').update(value).digest('hex');
const recorded = new Map();
function trackedRead(file) {
  const bytes = readFileSync(file);
  const prior = recorded.get(file);
  if (prior && prior !== sha(bytes)) throw new Error(`Input changed during build: ${file}`);
  recorded.set(file, sha(bytes));
  return bytes;
}
function dataUrl(publicPath) {
  const file = path.join(root, 'public', publicPath.replace(/^\//, ''));
  const mime = file.endsWith('.svg') ? 'image/svg+xml' : 'image/webp';
  return `data:${mime};base64,${trackedRead(file).toString('base64')}`;
}
trackedRead(fileURLToPath(import.meta.url));
trackedRead(path.join(root, 'postcss.config.js'));
trackedRead(path.join(root, 'tailwind.config.js'));

const auth = `export const useAuth = () => ({user:null,isAuthenticated:false,isLoading:false});`;
const api = `export const api = {get:async()=>{throw new Error('Design preview has no backend')}}; export const unwrapData = ()=>{throw new Error('No backend')};`;
const entrySource = trackedRead(path.join(qa, 'entry.tsx')).toString('utf8');
const entryPath = path.join(qa, 'entry.offline.tsx');
writeFileSync(entryPath, entrySource);
const qaModules = path.join(qa, 'node_modules');
if (!existsSync(qaModules)) symlinkSync(path.join(root, 'node_modules'), qaModules, 'dir');

const assetNames = ['spin', 'keno', 'dice', 'crash-point', 'thunder-derby', 'virtual-football'];
const assetMap = Object.fromEntries(assetNames.map(name => [name, dataUrl(`/art/ruby-grand/${name}.webp`)]));
const assetReplacements = new Map([
  ['/art/ruby-grand/lounge.webp', dataUrl('/art/ruby-grand/lounge.webp')],
  ['/art/ruby-grand/number-challenge.svg', dataUrl('/art/ruby-grand/number-challenge.svg')],
  ['/images/sky-crash/alpine-dawn.webp', dataUrl('/images/sky-crash/alpine-dawn.webp')],
  ['/images/sky-crash/aircraft.webp', dataUrl('/images/sky-crash/aircraft.webp')],
]);
const uiSources = [
  'src/pages/home.tsx', 'src/components/member/motion-shelf.tsx',
  'src/components/member/game-artwork.tsx', 'src/components/member/use-member-theme.ts',
  'src/components/layout/layout.tsx', 'src/components/layout/sidebar.tsx',
  'src/components/layout/header.tsx', 'src/lib/member-game-catalog.ts',
  'src/styles/index.css', 'src/styles/member.css', 'src/pages/home.css',
];
for (const source of uiSources) trackedRead(path.join(root, source));

const fixturePlugin = {
  name: 'offline-welcome-fixture', enforce: 'pre',
  resolveId(id) {
    if (id === '@/providers/auth-provider' || /\/src\/providers\/auth-provider(?:\.tsx)?$/.test(id)) return '\0offline-auth.js';
    if (id === '@/lib/api' || /\/src\/lib\/api(?:\.ts)?$/.test(id)) return '\0offline-api.js';
    if (id === '@/components/notifications/notification-bell' || /\/src\/components\/notifications\/notification-bell(?:\.tsx)?$/.test(id)) return '\0offline-bell.js';
  },
  load(id) {
    if (id === '\0offline-auth.js') return auth;
    if (id === '\0offline-api.js') return api;
    if (id === '\0offline-bell.js') return `import React from 'react'; export function NotificationBell(){ return React.createElement('button', { className:'qube-icon-button', 'aria-label':'Notifications (local fixture)', disabled:true }, '○'); }`;
  },
  transform(code, id) {
    const inputPath = id.split('?')[0];
    if (inputPath.startsWith(path.join(root, 'src') + '/') && existsSync(inputPath)) trackedRead(inputPath);
    if (id === path.join(root, 'src/pages/welcome.tsx') || id === path.join(root, 'src/components/member/game-artwork.tsx')) {
      let result = code;
      if (id.endsWith('/welcome.tsx')) {
        result = `import { useNavigate as useDesignNavigate } from 'react-router-dom';
function DesignLink({to,state,children,...props}) { const navigate=useDesignNavigate(); return <button {...props} type="button" data-design-link="true" onClick={()=>navigate(to,{state})}>{children}</button>; }
` + result.replace(/<Link\b/g, '<DesignLink').replace(/<\/Link>/g, '</DesignLink>');
      }
      for (const [from, to] of assetReplacements) result = result.split(from).join(to);
      if (id.endsWith('/game-artwork.tsx')) {
        const from = 'src={`/art/ruby-grand/${asset}.webp`}';
        if (!result.includes(from)) throw new Error('Dynamic artwork source shape changed');
        result = `const offlineArtwork = ${JSON.stringify(assetMap)};\n` + result.replace(from, 'src={offlineArtwork[asset]}');
      }
      return { code: result, map: null };
    }
  },
};

process.chdir(root);
const { build } = await import(pathToFileURL(path.join(root, 'node_modules/vite/dist/node/index.js')));
const requireFromWeb = createRequire(path.join(root, 'package.json'));
const reactPackage = requireFromWeb('@vitejs/plugin-react');
const react = reactPackage.default ?? reactPackage;
const result = await build({
  root, configFile: false, publicDir: false,
  plugins: [fixturePlugin, react()],
  resolve: { alias: { '@': path.join(root, 'src') } },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    write: false, copyPublicDir: false, sourcemap: false, cssCodeSplit: false,
    minify: 'esbuild', target: 'es2020',
    lib: { entry: entryPath, name: 'PlayQubeWelcomeDesign', formats: ['iife'], fileName: 'dashboard' },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
const outputs = (Array.isArray(result) ? result : [result]).flatMap(item => item.output);
const scripts = outputs.filter(item => item.type === 'chunk');
const styles = outputs.filter(item => item.type === 'asset' && item.fileName.endsWith('.css'));
if (scripts.length !== 1 || styles.length !== 1 || outputs.length !== 2) throw new Error('Unexpected external build outputs');
if (scripts[0].imports.length || scripts[0].dynamicImports.length) throw new Error('External script dependency');
const networkGuard = `
  const nativeSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value) {
    if (this instanceof HTMLAnchorElement && String(name).toLowerCase() === 'href') {
      nativeSetAttribute.call(this, 'aria-disabled', 'true');
      nativeSetAttribute.call(this, 'role', 'link');
      return;
    }
    return nativeSetAttribute.call(this, name, value);
  };

  window.fetch = () => Promise.reject(new Error('Offline synthetic preview: network disabled'));
  XMLHttpRequest.prototype.open = function(){ throw new Error('Offline synthetic preview: network disabled'); };
  window.WebSocket = class { constructor(){ throw new Error('Offline synthetic preview: network disabled'); } };
  navigator.sendBeacon = () => false;
  document.addEventListener('click', function(event){
    const link = event.target instanceof Element ? event.target.closest('a') : null;
    if (link) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
`;
const escapeScript = value => value.replace(/<\/script/gi, '<\\/script');
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; media-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'"><title>PlayQube · welcome design preview</title><style>${String(styles[0].source).replace(/<\/style/gi, '<\\/style')}</style><script>${escapeScript(networkGuard)}</script></head><body><div id="root"></div><script>${escapeScript(scripts[0].code)}</script></body></html>`;
for (const [file, inputHash] of recorded) if (sha(readFileSync(file)) !== inputHash) throw new Error(`Input changed after build: ${file}`);
const htmlBytes = Buffer.from(html);
const gz = gzipSync(htmlBytes, { level: 9, mtime: 0 });
const b64 = gz.toString('base64');
writeFileSync(path.join(qa, 'dashboard-preview.html'), htmlBytes);
writeFileSync(path.join(qa, 'index.html'), htmlBytes);
writeFileSync(path.join(qa, 'dashboard-preview.html.gz'), gz);
writeFileSync(path.join(qa, 'dashboard-preview.gzip.base64.txt'), b64);
const metadata = {
  syntheticData: true, localOnly: true, productFilesEditedByThisBuilder: false,
  network: 'CSP connect-src none plus fetch/XMLHttpRequest/WebSocket/sendBeacon denial',
  unrelatedNavigation: 'all anchor clicks prevented in document capture phase',
  actualComponents: ['WelcomePage', 'ExplorePage', 'GameArtwork'],
  mockedComponents: ['auth-provider', 'lib/api', 'Sign-in/registration preview gate', 'Preview-only button links'],
  css: 'actual index.css, member.css and home.css processed using source Tailwind/PostCSS configuration',
  sourceFiles: Object.fromEntries([...recorded].map(([file, hash]) => [file, hash])),
  output: {
    html: { file: 'dashboard-preview.html', bytes: htmlBytes.length, sha256: sha(htmlBytes) },
    gzip: { file: 'dashboard-preview.html.gz', bytes: gz.length, sha256: sha(gz) },
    gzipBase64: { file: 'dashboard-preview.gzip.base64.txt', bytes: b64.length, sha256: sha(b64) },
  },
  limits: ['Synthetic data; no live app, auth, backend or staging validation', 'Parent performs browser visual QA separately; this builder does not run a browser'],
};
writeFileSync(path.join(qa, 'offline-preview-metadata.json'), JSON.stringify(metadata, null, 2) + '\n');
console.log(JSON.stringify({ output: metadata.output, trackedSourceFiles: recorded.size }, null, 2));

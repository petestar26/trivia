import { build } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = join(__filename, '..');

async function buildApi() {
  const outDir = join(__dirname, 'dist');
  
  // Clean dist
  if (existsSync(outDir)) {
    rmSync(outDir, { recursive: true });
  }
  mkdirSync(outDir, { recursive: true });

  // Bundle with esbuild
  await build({
    entryPoints: [join(__dirname, 'src/server.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outdir: outDir,
    external: ['@prisma/client'],
    sourcemap: true,
    packages: 'external',
  });

  // Copy package.json for node_modules resolution
  copyFileSync(
    join(__dirname, 'package.json'),
    join(outDir, 'package.json')
  );
  
  console.log('Build completed!');
}

buildApi().catch(() => process.exit(1));
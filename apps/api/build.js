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
    entryPoints: [
      join(__dirname, 'src/server.ts'),
      join(__dirname, 'src/worker.ts'),
      // Read-only ledger upgrade preflight, runnable where tsx is not installed.
      join(__dirname, 'src/scripts/ledger-upgrade-preflight.ts'),
      // Rolled-back ledger invariant scan for the upgrade runbook.
      join(__dirname, 'src/scripts/ledger-invariant-scan.ts'),
      // Read-only predeploy verification of the restricted DATABASE_URL identity.
      join(__dirname, 'src/scripts/ledger-runtime-identity-check.ts'),
      // Owner-run setup of the runtime role's grants and the approval key.
      join(__dirname, 'src/scripts/ledger-runtime-access.ts'),
      // Offline proposed economics preview; no production database access.
      join(__dirname, 'src/scripts/game-economics-preview.ts'),
      // Standalone opt-in practice scheduler; never starts with the API/worker.
      join(__dirname, 'src/scripts/scheduled-practice-worker.ts'),
      // Owner-only controls restricted to the disposable staging rehearsal DB.
      join(__dirname, 'src/scripts/staging-practice-owner.ts'),
      // Explicit owner-run dormant proof import and bounded recovery.
      join(__dirname, 'src/scripts/house-round-recovery.ts'),
      // Offline player archive verification; no database or provider connection.
      join(__dirname, 'src/scripts/publication-receipt-verify.ts'),
    ],
    outbase: join(__dirname, 'src'),
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

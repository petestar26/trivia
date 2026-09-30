import { PrismaClient } from '@prisma/client';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import type * as RecoveryTypes from '../games/economics/house-round-recovery.js';
const DEFAULT_RECOVERY_LIMIT = 10;
const MAX_RECOVERY_LIMIT = 100;

const usage = 'house-round-recovery --round=id [--limit=1..100] [--run] [--prepare-beacon] [--beacon-proof=path]; defaults to read-only status; writes require --run and HOUSE_FINANCIAL_OWNER_DATABASE_URL';

export function parseRecoveryCommand(args: readonly string[]) {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--run' || argument === '--prepare-beacon') {
      if (flags.has(argument)) throw new Error('Invalid recovery arguments');
      flags.add(argument);
      continue;
    }
    const separator = argument.indexOf('=');
    const name = separator < 0 ? argument : argument.slice(0, separator);
    if (!['--round', '--limit', '--beacon-proof'].includes(name) || values.has(name))
      throw new Error('Invalid recovery arguments');
    const value = separator < 0 ? args[++index] : argument.slice(separator + 1);
    if (!value || value.startsWith('--')) throw new Error('Invalid recovery arguments');
    values.set(name, value);
  }
  const roundId = values.get('--round') ?? '';
  const rawLimit = values.get('--limit');
  const limit = rawLimit === undefined ? DEFAULT_RECOVERY_LIMIT : Number(rawLimit);
  if (!/^[A-Za-z0-9_:-]{1,128}$/.test(roundId) ||
    (rawLimit !== undefined && !/^[1-9][0-9]*$/.test(rawLimit)) ||
    !Number.isInteger(limit) || limit < 1 || limit > MAX_RECOVERY_LIMIT) throw new Error('Invalid recovery arguments');
  const run = flags.has('--run');
  const prepareBeacon = flags.has('--prepare-beacon');
  const beaconProofPath = values.get('--beacon-proof');
  if (!run && (prepareBeacon || beaconProofPath !== undefined)) throw new Error('Writes require --run');
  return { roundId, limit, run, prepareBeacon, beaconProofPath };
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  if (args.length === 1 && args[0] === '--help') { console.log(usage); return 0; }
  let command: ReturnType<typeof parseRecoveryCommand>;
  try { command = parseRecoveryCommand(args); }
  catch { console.error(usage); return 2; }
  const ownerUrl = process.env.HOUSE_FINANCIAL_OWNER_DATABASE_URL;
  try {
    if (!ownerUrl || !['postgres:', 'postgresql:'].includes(new URL(ownerUrl).protocol)) throw new Error();
  } catch {
    console.error('Financial recovery lacks its explicit owner database configuration.');
    return 2;
  }
  const owner = new PrismaClient({ datasourceUrl: ownerUrl, log: [] });
  let recovery: typeof RecoveryTypes | undefined;
  try {
    // Help and argument refusal do not load API configuration or connect.
    recovery = await import('../games/economics/house-round-recovery.js');
    const draw = await import('../games/economics/house-round-draw.js');
    if (command.prepareBeacon) await draw.prepareDormantBeaconSpinRandomness(owner, command.roundId);
    if (command.beaconProofPath) {
      if (statSync(command.beaconProofPath).size > 65_536) throw new Error('Beacon proof is oversized');
      const proof: unknown = JSON.parse(readFileSync(command.beaconProofPath, 'utf8'));
      await draw.recordDormantSpinBeacon(owner, command.roundId, proof);
    }
    const result = command.run
      ? await recovery.recoverDormantSpinRound(owner, { roundId: command.roundId, limit: command.limit })
      : await recovery.getDormantSpinRecoveryStatus(owner, command.roundId);
    console.log(JSON.stringify({ mode: command.run ? 'RECOVERY_BATCH' : 'READ_ONLY_STATUS', ...result }));
    return 0;
  } catch (error) {
    // A database exception may include secrets or its connection URL. Output
    // only deliberate recovery metadata, never error.message/stack/cause.
    const stopped = recovery && error instanceof recovery.HouseRoundRecoveryError ? error : null;
    console.error(JSON.stringify({ status: 'BLOCKED', roundId: command.roundId,
      processed: stopped?.processed ?? 0, blockedHoldId: stopped?.blockedHoldId ?? null }));
    return 1;
  } finally { await owner.$disconnect(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch(() => {
    console.error('Financial recovery could not start.');
    process.exitCode = 1;
  });
}

export type GroupWorkerKind = 'PVP' | 'KENO_PRACTICE' | 'DICE_PRACTICE' | 'SOCIAL_LIFECYCLE';
export function enabledGroupWorkers(env: NodeJS.ProcessEnv): GroupWorkerKind[] {
  return ['SOCIAL_LIFECYCLE', ...(['PVP', 'KENO_PRACTICE', 'DICE_PRACTICE'] as const).filter(kind => env[{
    PVP:'GROUP_PVP_GAME_POINTS_ENABLED', KENO_PRACTICE:'SYSTEM_KENO_PRACTICE_ENABLED', DICE_PRACTICE:'SYSTEM_DICE_PRACTICE_ENABLED',
  }[kind]] === 'true')];
}

export function workerFailure(error: unknown) {
  const value = error && typeof error === 'object' ? error as {code?:unknown;message?:unknown;meta?:{code?:unknown}} : {};
  const code = typeof value.code === 'string' && /^(P\d{4}|[0-9A-Z]{5})$/.test(value.code) ? value.code : 'UNKNOWN';
  const databaseCode = typeof value.meta?.code === 'string' && /^[0-9A-Z]{5}$/.test(value.meta.code) ? value.meta.code : undefined;
  const messages: Record<string,string> = {P2002:'Unique constraint conflict',P2003:'Related record is unavailable',P2010:'Database rejected the operation',P2024:'Database connection pool timeout',P2028:'Transaction failed',P2034:'Concurrent transaction conflict'};
  const known = ['PVP funding receipt mismatch', 'Practice balance does not match tickets', 'Dice practice balance does not match tickets'];
  const message = known.find(text => typeof value.message === 'string' && value.message.includes(text)) ?? messages[code] ?? 'Worker operation failed';
  // Never log raw Prisma messages, SQL, URLs, connection strings or stacks.
  return {code, databaseCode, message};
}

export async function runGroupWorkerLoops(options: {
  enabled: GroupWorkerKind[];
  ticks: Record<GroupWorkerKind,(onError:(id:string,error:unknown)=>void)=>Promise<void>>;
  stopped:()=>boolean;
  wait:()=>Promise<void>;
  report:(event:ReturnType<typeof workerFailure>&{event:string;id?:string})=>void;
}) {
  if (!options.enabled.length) throw new Error('No group or system practice worker is enabled');
  await Promise.all(options.enabled.map(async kind => {
    const report = (error:unknown,id?:string) => options.report({event:`${kind}_WORKER_RETRY`,id,...workerFailure(error)});
    while (!options.stopped()) {
      try { await options.ticks[kind]((id,error)=>report(error,id)); }
      catch (error) { report(error); }
      await options.wait();
    }
  }));
}

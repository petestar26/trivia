import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@socialplay/database';
import {
  MONITOR_QUERIES,
  readMonitorSource,
  type MonitorSource,
  type MonitorData,
} from './sources.js';

type Options = {
  read: (source: MonitorSource) => Promise<MonitorData>;
  emit: (event: Record<string, unknown>) => void;
  signals: () => unknown;
  now?: () => number;
  intervalMs?: number;
};

/** Sequential, bounded reads; separate failures preserve coverage of other sources.
 * No scheduling of mail/LLM calls and no write to a wallet or operational table. */
export function scheduleMonitor({
  read,
  emit,
  signals,
  now = Date.now,
  intervalMs = 60_000,
}: Options) {
  const instanceId = randomUUID();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sequence = 0;
  const lastSuccess: Partial<Record<MonitorSource, string>> = {};
  const publish = (payload: Record<string, unknown>) => {
    try {
      emit({
        event: 'SALEM_MONITOR',
        version: 1,
        instanceId,
        sequence,
        observedAt: new Date(now()).toISOString(),
        ...payload,
      });
    } catch {
      /* Observability must not break payment or application processing. */
    }
  };
  const cycle = async () => {
    sequence++;
    const failedSources: MonitorSource[] = [];
    for (const source of Object.keys(MONITOR_QUERIES) as MonitorSource[]) {
      if (stopped) return;
      try {
        const data = await read(source);
        lastSuccess[source] = new Date(now()).toISOString();
        publish({ kind: 'snapshot', source, status: 'ok', data });
      } catch {
        failedSources.push(source);
        // Database errors can include queries, credentials, or stored content.
        publish({
          kind: 'snapshot',
          source,
          status: 'unavailable',
          lastSuccessAt: lastSuccess[source] ?? null,
        });
      }
    }
    if (stopped) return;
    publish({
      kind: 'heartbeat',
      status: failedSources.length ? 'partial' : 'ok',
      failedSources,
      signals: signals(),
    });
    timer = setTimeout(
      () => {
        running = cycle();
      },
      Math.max(60_000, intervalMs)
    );
    timer.unref?.();
  };
  let running = cycle();
  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await running;
  };
}

export function startOperationsMonitor(db: PrismaClient, server: FastifyInstance) {
  return scheduleMonitor({
    read: (source) => readMonitorSource(db, source),
    signals: () => server.salemMonitor?.take(),
    emit: (event) => server.log.info(event, 'SALEM_MONITOR'),
  });
}

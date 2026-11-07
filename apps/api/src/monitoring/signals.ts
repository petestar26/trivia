import type { FastifyInstance } from 'fastify';

export type CallbackSignal =
  | 'disabled'
  | 'wrong_method'
  | 'untrusted_source'
  | 'invalid_signature_or_payload'
  | 'wallet_rejected'
  | 'failed'
  | 'accepted';
type Bucket = {
  requests: number;
  serverErrors: number;
  unauthorized: number;
  forbidden: number;
  throttled: number;
  slow: number;
};
const empty = (): Bucket => ({
  requests: 0,
  serverErrors: 0,
  unauthorized: 0,
  forbidden: 0,
  throttled: 0,
  slow: 0,
});

// Only a fixed classification of the registered route is retained. Never retain
// raw URL, query, body, IP, headers, usernames, or unbounded attacker-controlled keys.
function area(route?: string) {
  if (route?.includes('/provider-test/') || route?.includes('/sg/')) return 'casino';
  if (route?.includes('/sportsbook/')) return 'sports';
  if (route?.includes('/auth/') || route?.includes('/security/')) return 'authentication';
  if (route?.includes('/support/')) return 'support';
  if (
    route &&
    /\/(agents|agent-orders|agent-disputes|agent-config|payment-orders|late-payments|withdrawals|crypto-payments|wallet|ledger-admin)\b/.test(
      route
    )
  )
    return 'payments';
  if (route?.includes('/play-together/')) return 'sharedGames';
  return 'other';
}

export function createMonitorSignals(now = Date.now) {
  let since = now();
  let http: Record<string, Bucket> = {};
  let callbacks: Partial<Record<CallbackSignal, number>> = {};
  return {
    response(route: string | undefined, status: number, elapsedMs: number) {
      const bucket = (http[area(route)] ??= empty());
      bucket.requests++;
      if (status >= 500) bucket.serverErrors++;
      if (status === 401) bucket.unauthorized++;
      if (status === 403) bucket.forbidden++;
      if (status === 429) bucket.throttled++;
      if (elapsedMs >= 3000) bucket.slow++;
    },
    callback(reason: CallbackSignal) {
      callbacks[reason] = (callbacks[reason] ?? 0) + 1;
    },
    take() {
      const until = now();
      const data = {
        since: new Date(since).toISOString(),
        until: new Date(until).toISOString(),
        http,
        callbacks,
      };
      since = until;
      http = {};
      callbacks = {};
      return data;
    },
  };
}

declare module 'fastify' {
  interface FastifyInstance {
    salemMonitor?: ReturnType<typeof createMonitorSignals>;
  }
}

export function registerMonitorSignals(server: FastifyInstance, enabled: boolean) {
  if (!enabled) return;
  server.decorate('salemMonitor', createMonitorSignals());
  server.addHook('onResponse', async (request, reply) => {
    server.salemMonitor?.response(request.routeOptions?.url, reply.statusCode, reply.elapsedTime);
  });
}

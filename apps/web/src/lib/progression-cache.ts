import { QueryClient } from '@tanstack/react-query';

/**
 * Invalidate cache surfaces changed by activity/reward side effects.
 *
 * This helper is intentionally scoped to the five known progression families
 * (achievements, progress, tasks, wallet, wallet-transactions). It does NOT
 * synchronise asynchronous backend completion — achievement processing may
 * still be in flight when this runs.
 *
 * Achievements use a query-level `staleTime: 0` so they self-heal on each
 * later Rewards mount, regardless of whether this helper was also called.
 */
export function invalidateProgressionQueries(queryClient: QueryClient): void {
  queryClient.invalidateQueries({ queryKey: ['achievements'] });
  queryClient.invalidateQueries({ queryKey: ['progress'] });
  queryClient.invalidateQueries({ queryKey: ['tasks'] });
  queryClient.invalidateQueries({ queryKey: ['wallet'] });
  queryClient.invalidateQueries({ queryKey: ['wallet-transactions'] });
}

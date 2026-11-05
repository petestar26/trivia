import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, unwrapData } from './api';
import { boundedRequest } from './bounded-request';

/** Activity is authenticated by the API; the server owns the day and amount.
 * Visible sessions also qualify after midnight without requiring another login. */
export function useAutomaticRewards(userId: string | undefined) {
  const cache = useQueryClient();
  useEffect(() => {
    if (!userId) return;
    const lifetime = new AbortController();
    let running = false;
    const record = async () => {
      if (running || document.visibilityState === 'hidden' || !navigator.onLine) return;
      running = true;
      try {
        const result = unwrapData(
          await boundedRequest(
            (signal) =>
              api.post<{ earned: boolean; credited: number }>(
                '/member-rewards/activity',
                {},
                undefined,
                { signal }
              ),
            lifetime.signal
          )
        );
        if (!lifetime.signal.aborted && (result.earned || result.credited > 0)) {
          await Promise.all([
            cache.invalidateQueries({ queryKey: ['member-rewards', userId] }),
            cache.invalidateQueries({ queryKey: ['wallet'] }),
          ]);
        }
      } catch {
        // The next visible activity retries; never interrupt the member's page.
      } finally {
        running = false;
      }
    };
    void record();
    const timer = window.setInterval(() => void record(), 60_000);
    const resume = () => void record();
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('online', resume);
    return () => {
      lifetime.abort();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('online', resume);
    };
  }, [cache, userId]);
}

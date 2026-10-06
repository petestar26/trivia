import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invalidateProgressionQueries } from './progression-cache';

describe('invalidateProgressionQueries', () => {
  let client: QueryClient;

  afterEach(() => {
    client.clear();
  });

  it('invalidates exactly the five progression query families via prefix matching', () => {
    client = new QueryClient();
    const spy = vi.spyOn(client, 'invalidateQueries');

    // Seed the five intended families plus unrelated keys.
    client.setQueryData(['achievements'], []);
    client.setQueryData(['progress'], { level: 1 });
    client.setQueryData(['tasks'], []);
    client.setQueryData(['wallet'], { coinsBalance: 10 });
    client.setQueryData(['wallet', 'user-1'], { coinsBalance: 20 });
    client.setQueryData(['wallet-transactions'], []);
    client.setQueryData(['groups'], []);
    client.setQueryData(['challenges'], []);
    client.setQueryData(['vip'], { isActive: false });

    invalidateProgressionQueries(client);

    // Exactly five invalidation calls.
    expect(spy).toHaveBeenCalledTimes(5);
    expect(spy).toHaveBeenCalledWith({ queryKey: ['achievements'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['progress'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['tasks'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['wallet'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['wallet-transactions'] });

    // Unrelated families must NOT be touched.
    expect(spy).not.toHaveBeenCalledWith({ queryKey: ['groups'] });
    expect(spy).not.toHaveBeenCalledWith({ queryKey: ['challenges'] });
    expect(spy).not.toHaveBeenCalledWith({ queryKey: ['vip'] });
  });

  it('prefix-matches wallet queries so ["wallet", userId] is also invalidated', () => {
    client = new QueryClient();
    client.setQueryData(['wallet'], { coinsBalance: 10 });
    client.setQueryData(['wallet', 'user-1'], { coinsBalance: 20 });

    const before = client.getQueryState(['wallet', 'user-1']);
    expect(before?.isInvalidated).toBe(false);

    invalidateProgressionQueries(client);

    const after = client.getQueryState(['wallet', 'user-1']);
    expect(after?.isInvalidated).toBe(true);
  });
});
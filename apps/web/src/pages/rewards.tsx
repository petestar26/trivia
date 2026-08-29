import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export function RewardsPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: tasksData, isLoading: tasksLoading, isError: tasksError } = useQuery({
    queryKey: ['tasks'],
    queryFn: async () => (await api.listTasks()).data,
  });

  const { data: achievementsData, isLoading: achLoading } = useQuery({
    queryKey: ['achievements'],
    queryFn: async () => (await api.listAchievements()).data,
  });

  const { data: vipData, isLoading: vipLoading } = useQuery({
    queryKey: ['vip'],
    queryFn: async () => (await api.getVip()).data,
  });

  const { data: progressData, isLoading: progLoading } = useQuery({
    queryKey: ['progress'],
    queryFn: async () => (await api.getProgress()).data,
  });

  const claimMutation = useMutation({
    mutationFn: (taskId: string) => api.claimTaskReward(taskId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      queryClient.invalidateQueries({ queryKey: ['wallet'] });
      toast({ title: 'Reward claimed!' });
    },
    onError: (err) => {
      let msg = 'Failed to claim';
      try { msg = JSON.parse((err as Error).message)?.message ?? msg; } catch { /* noop */ }
      toast({ title: 'Error', description: msg, variant: 'destructive' });
    },
  });

  const loading = tasksLoading || achLoading || vipLoading || progLoading;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-4 border-primary-500 border-t-transparent" />
      </div>
    );
  }

  if (tasksError) {
    return (
      <div className="max-w-3xl mx-auto p-4">
        <Card><CardContent className="py-8 text-center text-red-600 dark:text-red-400">Failed to load rewards.</CardContent></Card>
      </div>
    );
  }

  const tasks = tasksData?.data ?? [];
  const achievements = achievementsData?.data ?? [];
  const vip = vipData;
  const progress = progressData;

  return (
    <div className="max-w-3xl mx-auto p-4 space-y-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Rewards</h1>

      {/* XP / Level */}
      {progress && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Progress</CardTitle></CardHeader>
          <CardContent>
            <div className="flex items-center gap-4">
              <div className="text-3xl font-bold text-primary-600 dark:text-primary-400">Lv {progress.level}</div>
              <div className="flex-1">
                <div className="text-sm text-gray-500 dark:text-gray-400">{progress.xp} XP</div>
                <div className="mt-1 h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                  <div className="h-full bg-primary-500 rounded-full" style={{ width: `${Math.min(100, (progress.xp % 100))}%` }} />
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* VIP */}
      {vip && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">VIP Status</CardTitle></CardHeader>
          <CardContent>
            {vip.isActive ? (
              <div className="flex items-center gap-3">
                <span className="text-2xl">{vip.tier === 'PLATINUM' ? '💎' : vip.tier === 'GOLD' ? '🥇' : '🥈'}</span>
                <div>
                  <p className="font-semibold text-amber-600 dark:text-amber-400">{vip.tier} Member</p>
                  <p className="text-xs text-gray-500">Expires {vip.expiresAt ? new Date(vip.expiresAt).toLocaleDateString() : '—'}</p>
                </div>
              </div>
            ) : (
              <p className="text-sm text-gray-500 dark:text-gray-400">No active VIP membership.</p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Daily Tasks */}
      <Card>
        <CardHeader><CardTitle className="text-base">Daily Tasks</CardTitle></CardHeader>
        <CardContent>
          {tasks.length === 0 ? (
            <p className="text-sm text-gray-500 text-center py-4">No tasks available.</p>
          ) : (
            <div className="space-y-3">
              {tasks.map((task: any) => (
                <div key={task.id} className="flex items-center justify-between gap-3 p-3 rounded-lg border border-gray-200 dark:border-gray-700">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 dark:text-white">{task.title}</p>
                    <p className="text-xs text-gray-500 dark:text-gray-400">{task.description}</p>
                    <div className="mt-1 flex items-center gap-2">
                      <div className="flex-1 h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden max-w-[120px]">
                        <div className="h-full bg-primary-500 rounded-full" style={{ width: `${Math.min(100, (task.progress / task.target) * 100)}%` }} />
                      </div>
                      <span className="text-xs text-gray-500">{task.progress}/{task.target}</span>
                    </div>
                    {(task.coinReward > 0 || task.gamePointReward > 0) && (
                      <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                        Reward: {[task.coinReward > 0 ? `${task.coinReward} coins` : null, task.gamePointReward > 0 ? `${task.gamePointReward} GP` : null].filter(Boolean).join(' + ')}
                      </p>
                    )}
                  </div>
                  {task.status === 'COMPLETED' && (
                    <Button
                      size="sm"
                      onClick={() => claimMutation.mutate(task.id)}
                      disabled={claimMutation.isPending}
                    >
                      Claim
                    </Button>
                  )}
                  {task.status === 'CLAIMED' && (
                    <span className="text-xs text-green-600 dark:text-green-400 font-medium">✓ Claimed</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Achievements */}
      <Card>
        <CardHeader><CardTitle className="text-base">Achievements</CardTitle></CardHeader>
        <CardContent>
          {achievements.length === 0 ? (
            <p className="text-sm text-gray-500 text-center py-4">No achievements unlocked yet.</p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {achievements.map((ach: any) => (
                <div key={ach.key} className="p-3 rounded-lg border border-gray-200 dark:border-gray-700">
                  <p className="text-sm font-medium text-gray-900 dark:text-white">{ach.title}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">{ach.description}</p>
                  <p className="text-xs text-gray-400 mt-1">Unlocked {new Date(ach.unlockedAt).toLocaleDateString()}</p>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

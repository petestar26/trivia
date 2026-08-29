import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export function GroupsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: groupsData, isLoading, isError } = useQuery({
    queryKey: ['groups'],
    queryFn: async () => (await api.listGroups({ limit: 50 })).data,
  });

  const joinMutation = useMutation({
    mutationFn: (groupId: string) => api.joinGroup(groupId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['groups'] });
      toast({ title: 'Joined group' });
    },
    onError: (err) => {
      let msg = 'Failed to join';
      try { msg = JSON.parse((err as Error).message)?.message ?? msg; } catch { /* noop */ }
      toast({ title: 'Error', description: msg, variant: 'destructive' });
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-4 border-primary-500 border-t-transparent" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="max-w-3xl mx-auto p-4">
        <Card><CardContent className="py-8 text-center text-red-600 dark:text-red-400">Failed to load groups.</CardContent></Card>
      </div>
    );
  }

  const groups = groupsData?.data ?? [];

  return (
    <div className="max-w-3xl mx-auto p-4 space-y-4">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Groups</h1>

      {groups.length === 0 ? (
        <div className="py-16 text-center text-gray-500 dark:text-gray-400">No groups found.</div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {groups.map((group: any) => (
            <Card key={group.id} className="hover:shadow-md transition-shadow">
              <CardHeader className="pb-2">
                <CardTitle className="text-base">{group.name}</CardTitle>
                {group.description && <CardDescription className="line-clamp-2">{group.description}</CardDescription>}
              </CardHeader>
              <CardContent>
                <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
                  {group.memberCount} member{group.memberCount !== 1 ? 's' : ''}
                  {group.isPrivate && ' · Private'}
                </p>
                <div className="flex gap-2">
                  {group.isMember ? (
                    <Button size="sm" onClick={() => navigate(`/messages/${group.id}`)}>Open</Button>
                  ) : (
                    !group.isPrivate && (
                      <Button size="sm" onClick={() => joinMutation.mutate(group.id)} disabled={joinMutation.isPending}>
                        {joinMutation.isPending ? 'Joining…' : 'Join'}
                      </Button>
                    )
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

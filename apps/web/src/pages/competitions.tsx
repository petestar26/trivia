/**
 * CompetitionsPage — /competitions
 *
 * Shows the user's groups. Clicking a group navigates to its competition list
 * at /competitions/:groupId (GroupCompetitionsPage).
 *
 * Competitions are always scoped to a group, so the top-level page is a
 * group-picker rather than a flat list.
 */
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

interface GroupSummary {
  id: string;
  name: string;
  description?: string | null;
  isMember: boolean;
  memberRole?: string;
  memberCount: number;
}

export function CompetitionsPage() {
  const navigate = useNavigate();

  const { data: groups = [], isLoading } = useQuery<GroupSummary[]>({
    queryKey: ['groups-for-competitions'],
    queryFn: async () => {
      // GET /groups returns { success, data: GroupSummary[], meta }.
      const res = await api.get<GroupSummary[]>('/groups');
      const all = res.data ?? [];
      // Show only groups the user is an active member of.
      return all.filter((g) => g.isMember);
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-4 border-primary-500 border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto p-4 space-y-4">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Competitions</h1>
      <p className="text-sm text-gray-500 dark:text-gray-400">
        Select a group to view and join its competitions.
      </p>

      {groups.length === 0 ? (
        <div className="py-16 text-center text-gray-500 dark:text-gray-400">
          You are not a member of any groups yet.
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {groups.map((group) => (
            <Card key={group.id} className="hover:shadow-md transition-shadow">
              <CardHeader className="pb-2">
                <CardTitle className="text-base">{group.name}</CardTitle>
                {group.description && (
                  <CardDescription className="line-clamp-2">{group.description}</CardDescription>
                )}
              </CardHeader>
              <CardContent>
                <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
                  {group.memberCount} member{group.memberCount !== 1 ? 's' : ''}
                  {group.memberRole && ` · ${group.memberRole}`}
                </p>
                <Button
                  size="sm"
                  onClick={() => navigate(`/competitions/${group.id}`)}
                >
                  View competitions
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

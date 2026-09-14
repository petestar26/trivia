import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import { invalidateProgressionQueries } from '@/lib/progression-cache';
import { useToast } from '@/hooks/use-toast';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const NAME_MIN = 2;
const NAME_MAX = 100;
const DESCRIPTION_MAX = 500;

/**
 * Shape this page renders from `GET /groups`. Typed (rather than `any`) so the
 * compiler rejects a second `.data` unwrap: `api.listGroups()` returns
 * `ApiResponse<any>`, and reading `.data` off that already yields the array —
 * accessing `.data` again silently produced `undefined` and rendered a
 * permanently empty list.
 */
interface GroupSummary {
  id: string;
  name: string;
  description?: string | null;
  memberCount: number;
  isMember: boolean;
  isPrivate: boolean;
  memberRole?: string | null;
}

// Both list views over `GET /groups` — the flat groups browser here, and the
// membership-filtered picker on the competitions hub — must refresh together
// whenever a group is created, or the new group is invisible on one of them
// until an unrelated refetch happens to occur.
const GROUP_LIST_QUERY_KEYS = [['groups'], ['groups-for-competitions']] as const;

export function GroupsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Resolves directly to the array; the render path uses it as-is.
  const { data: groups = [], isLoading, isError } = useQuery<GroupSummary[]>({
    queryKey: ['groups'],
    queryFn: async () => (await api.listGroups({ limit: 50 })).data ?? [],
  });

  const [showCreateForm, setShowCreateForm] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [formErrorFields, setFormErrorFields] = useState<string[]>([]);

  // Disclosure-toggle stays mounted (see `hidden` below) so a ref reliably
  // survives the open/close cycle for focus management.
  const toggleRef = useRef<HTMLButtonElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (showCreateForm) {
      wasOpenRef.current = true;
      nameInputRef.current?.focus();
    } else if (wasOpenRef.current) {
      wasOpenRef.current = false;
      toggleRef.current?.focus();
    }
  }, [showCreateForm]);

  function resetCreateForm() {
    setName('');
    setDescription('');
    setIsPrivate(false);
    setFormError(null);
    setFormErrorFields([]);
    setShowCreateForm(false);
  }

  /** Associates the shared form-error alert with the field(s) it describes. */
  function fieldErrorProps(fieldId: string): { 'aria-invalid'?: true; 'aria-describedby'?: string } {
    if (!formError || !formErrorFields.includes(fieldId)) return {};
    return { 'aria-invalid': true, 'aria-describedby': 'create-group-error' };
  }

  const createMutation = useMutation({
    mutationFn: (body: { name: string; description?: string; isPrivate: boolean }) => api.createGroup(body),
    onSuccess: () => {
      for (const queryKey of GROUP_LIST_QUERY_KEYS) {
        queryClient.invalidateQueries({ queryKey });
      }
      resetCreateForm();
      toast({ title: 'Group created' });
    },
    onError: (err) => {
      let msg = 'Failed to create group';
      try { msg = JSON.parse((err as Error).message)?.message ?? msg; } catch { /* noop */ }
      setFormError(msg);
      setFormErrorFields([]);
    },
  });

  function handleCreateSubmit(e: FormEvent) {
    e.preventDefault();
    if (createMutation.isPending) return;

    const trimmedName = name.trim();
    const trimmedDescription = description.trim();
    // Mirrors the server's own bounds (POST /groups) so obviously-invalid
    // input never round-trips — the server remains the actual authority.
    if (trimmedName.length < NAME_MIN || trimmedName.length > NAME_MAX) {
      setFormError(`Group name must be between ${NAME_MIN} and ${NAME_MAX} characters.`);
      setFormErrorFields(['new-group-name']);
      return;
    }
    if (trimmedDescription.length > DESCRIPTION_MAX) {
      setFormError(`Description must be ${DESCRIPTION_MAX} characters or fewer.`);
      setFormErrorFields(['new-group-description']);
      return;
    }

    setFormError(null);
    setFormErrorFields([]);
    createMutation.mutate({
      name: trimmedName,
      description: trimmedDescription || undefined,
      isPrivate,
    });
  }

  const createGroupForm = (
    <Card>
      <CardContent className="pt-6">
        <form id="create-group-form" onSubmit={handleCreateSubmit} className="space-y-3" aria-label="Create group">
          <div>
            <label htmlFor="new-group-name" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Name
            </label>
            <Input
              id="new-group-name"
              ref={nameInputRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={NAME_MAX}
              placeholder="Group name"
              disabled={createMutation.isPending}
              {...fieldErrorProps('new-group-name')}
            />
          </div>
          <div>
            <label htmlFor="new-group-description" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Description <span className="text-gray-400 font-normal">(optional)</span>
            </label>
            <textarea
              id="new-group-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={DESCRIPTION_MAX}
              rows={2}
              placeholder="What's this group about?"
              disabled={createMutation.isPending}
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              {...fieldErrorProps('new-group-description')}
            />
          </div>
          <label className="flex items-center space-x-2">
            <input
              type="checkbox"
              checked={isPrivate}
              onChange={(e) => setIsPrivate(e.target.checked)}
              disabled={createMutation.isPending}
              className="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
            />
            <span className="text-sm text-gray-600 dark:text-gray-400">Private group</span>
          </label>

          {formError && (
            <p id="create-group-error" role="alert" className="text-sm text-red-600 dark:text-red-400">
              {formError}
            </p>
          )}

          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={createMutation.isPending}>
              {createMutation.isPending ? 'Creating…' : 'Create group'}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={resetCreateForm} disabled={createMutation.isPending}>
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );

  const joinMutation = useMutation({
    mutationFn: (groupId: string) => api.joinGroup(groupId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['groups'] });
      // Joining a group may fire achievement/progression side effects.
      invalidateProgressionQueries(queryClient);
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

  return (
    <div className="max-w-3xl mx-auto p-4 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Groups</h1>
        {/* Stays mounted (hidden, not unmounted) while the form is open: `hidden`
            drops it from the accessibility tree and from `getByRole` queries just
            like unmounting would, but keeps `toggleRef` pointing at a stable node
            so focus can reliably return to it on Cancel/success. */}
        <Button
          ref={toggleRef}
          hidden={showCreateForm}
          size="sm"
          aria-expanded={showCreateForm}
          aria-controls="create-group-form"
          onClick={() => setShowCreateForm(true)}
        >
          Create group
        </Button>
      </div>

      {showCreateForm && createGroupForm}

      {groups.length === 0 ? (
        <div className="py-16 text-center text-gray-500 dark:text-gray-400 space-y-3">
          <p>No groups found.</p>
          {!showCreateForm && (
            <Button size="sm" onClick={() => setShowCreateForm(true)}>
              Create your first group
            </Button>
          )}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {groups.map((group) => (
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

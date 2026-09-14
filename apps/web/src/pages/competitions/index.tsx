/**
 * GroupCompetitionsPage — /competitions/:groupId
 *
 * Lists all competitions for a specific group.  Membership is enforced
 * server-side; the backend returns 403 if the user is not an active member.
 * Action affordances (badge, button) are driven by the server-derived `phase`
 * (UPCOMING/OPEN/ENDED), never by the persisted status alone.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams, useNavigate } from 'react-router-dom';
import { api, unwrapData, Competition, CompetitionPhase, CreateCompetitionBody } from '@/lib/api';
import { normalizeCompetitionPhase } from '@/lib/competition-lifecycle';
import { useToast } from '@/hooks/use-toast';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/** Minimal shape this form needs from `GET /games` (already filtered to active games server-side). */
interface ActiveGame {
  key: string;
  name: string;
}

const inputClass =
  'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';

/**
 * Parses a non-negative-integer form field. Blank is treated as the caller's
 * problem (required-field check happens separately) — this only judges
 * whether a *supplied* value is safe: finite, a whole number, and >= 0.
 * Mirrors the server's own `validateRewardAmount`/entryAmount checks so
 * obviously-invalid input is rejected before the request, while the server
 * remains the actual authority.
 */
function parseNonNegativeInt(value: string): number | null {
  if (value.trim() === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isSafeInteger(n) || n < 0) return null;
  return n;
}

type CreateFormResult =
  | { ok: false; error: string }
  | { ok: true; payload: Omit<CreateCompetitionBody, 'groupId'> };

const PHASE_LABEL: Record<CompetitionPhase, string> = {
  UPCOMING: 'Upcoming',
  OPEN: 'Open',
  ENDED: 'Ended',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

const PHASE_COLOR: Record<CompetitionPhase, string> = {
  UPCOMING: 'text-yellow-600 dark:text-yellow-400',
  OPEN: 'text-green-600 dark:text-green-400',
  ENDED: 'text-rose-600 dark:text-rose-400',
  COMPLETED: 'text-blue-600 dark:text-blue-400',
  CANCELLED: 'text-gray-400',
};

// setTimeout's 32-bit signed limit is MAX_TIMER_DELAY ms; boundary refresh also
// adds BOUNDARY_GRACE_MS on top of the raw remaining delay. Chained waits use
// MAX_TIMER_SLICE so the final delay (slice + grace) can never exceed
// MAX_TIMER_DELAY — scheduling any larger value would overflow to a 1 ms timer.
// A far-future startsAt/endsAt therefore chains in MAX_TIMER_SLICE slices.
const BOUNDARY_GRACE_MS = 250;
const MAX_TIMER_DELAY = 2_147_483_647;
const MAX_TIMER_SLICE = MAX_TIMER_DELAY - BOUNDARY_GRACE_MS;

export function GroupCompetitionsPage() {
  const { groupId } = useParams<{ groupId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Same endpoint + query key the detail page uses for this same purpose
  // (display-only role check — the backend re-validates on every mutation).
  const { data: groupInfo } = useQuery<{ isMember: boolean; memberRole?: string }>({
    queryKey: ['group', groupId],
    queryFn: async () => {
      const res = await api.get<{ isMember: boolean; memberRole?: string }>(`/groups/${groupId}`);
      return res.data ?? { isMember: false };
    },
    enabled: !!groupId,
  });
  const canCreate = groupInfo?.memberRole === 'OWNER' || groupInfo?.memberRole === 'ADMIN';

  const { data: games = [] } = useQuery<ActiveGame[]>({
    queryKey: ['games'],
    queryFn: async () => unwrapData(await api.get<ActiveGame[]>('/games'), 'Games response'),
    enabled: canCreate,
  });

  const [showCreateForm, setShowCreateForm] = useState(false);
  const [gameKey, setGameKey] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [startsAtLocal, setStartsAtLocal] = useState('');
  const [endsAtLocal, setEndsAtLocal] = useState('');
  const [entryAmount, setEntryAmount] = useState('0');
  const [maxParticipants, setMaxParticipants] = useState('');
  const [rewardGamePoints, setRewardGamePoints] = useState('0');
  const [rewardCoins, setRewardCoins] = useState('0');
  const [formError, setFormError] = useState<string | null>(null);

  function resetCreateForm() {
    setGameKey('');
    setTitle('');
    setDescription('');
    setStartsAtLocal('');
    setEndsAtLocal('');
    setEntryAmount('0');
    setMaxParticipants('');
    setRewardGamePoints('0');
    setRewardCoins('0');
    setFormError(null);
    setShowCreateForm(false);
  }

  function buildCreatePayload(): CreateFormResult {
    if (!gameKey) return { ok: false, error: 'Choose a game.' };
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return { ok: false, error: 'Title is required.' };
    if (!startsAtLocal || !endsAtLocal) return { ok: false, error: 'Start and end time are required.' };

    // datetime-local values are interpreted in the browser's local time zone,
    // exactly matching what the user saw and picked in the field.
    const startsAtDate = new Date(startsAtLocal);
    const endsAtDate = new Date(endsAtLocal);
    if (Number.isNaN(startsAtDate.getTime()) || Number.isNaN(endsAtDate.getTime())) {
      return { ok: false, error: 'Start and end time must be valid.' };
    }
    if (endsAtDate <= startsAtDate) {
      return { ok: false, error: 'End time must be after start time.' };
    }

    const entry = parseNonNegativeInt(entryAmount);
    if (entry === null) return { ok: false, error: 'Entry amount must be a non-negative whole number.' };

    const rGP = parseNonNegativeInt(rewardGamePoints);
    if (rGP === null) return { ok: false, error: 'Game Point reward must be a non-negative whole number.' };

    const rCoins = parseNonNegativeInt(rewardCoins);
    if (rCoins === null) return { ok: false, error: 'Coin reward must be a non-negative whole number.' };

    let maxP: number | undefined;
    if (maxParticipants.trim() !== '') {
      const n = Number(maxParticipants);
      if (!Number.isFinite(n) || !Number.isSafeInteger(n) || n < 2) {
        return { ok: false, error: 'Max participants must be blank or an integer of 2 or more.' };
      }
      maxP = n;
    }

    return {
      ok: true,
      payload: {
        gameKey,
        title: trimmedTitle,
        description: description.trim() || undefined,
        startsAt: startsAtDate.toISOString(),
        endsAt: endsAtDate.toISOString(),
        entryAmount: entry,
        maxParticipants: maxP,
        rewardGamePoints: rGP,
        rewardCoins: rCoins,
      },
    };
  }

  const createMutation = useMutation({
    mutationFn: (body: CreateCompetitionBody) => api.createCompetition(body),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['competitions', groupId] });
      const created = res.data;
      toast({ title: 'Competition created' });
      resetCreateForm();
      if (created?.id) {
        navigate(`/competitions/${groupId}/${created.id}`);
      }
    },
    onError: (err) => {
      let msg = 'Failed to create competition';
      try { msg = JSON.parse((err as Error).message)?.message ?? msg; } catch { /* noop */ }
      setFormError(msg);
    },
  });

  function handleCreateSubmit(e: FormEvent) {
    e.preventDefault();
    if (createMutation.isPending) return;

    const result = buildCreatePayload();
    if (!result.ok) {
      setFormError(result.error);
      return;
    }
    setFormError(null);
    createMutation.mutate({ ...result.payload, groupId: groupId! });
  }

  const { data: competitions = [], isLoading, isError } = useQuery<Competition[]>({
    queryKey: ['competitions', groupId],
    queryFn: async () => {
      const res = await api.listCompetitionsForGroup(groupId!);
      const now = Date.now();
      return (res.data ?? []).map((competition) => normalizeCompetitionPhase(competition, now));
    },
    enabled: !!groupId,
    // Explicit recovery hook: boundary changes become visible on tab return
    // even if the local re-arming chain was torn down while the tab was away.
    refetchOnWindowFocus: 'always',
    refetchOnMount: 'always',
  });

  // ── Boundary refresh ─────────────────────────────────────────────
  // One focused timer chain to the NEAREST upcoming start/end boundary across
  // the visible (non-terminal) competitions; when it fires the list refetches
  // so phase badges flip UPCOMING→OPEN→ENDED without a manual reload. No
  // polling — no network request fires between boundaries. Long horizons are
  // handled by bounded chained waiting: the remaining local delay is recomputed
  // every MAX_TIMER_SLICE ms, so no scheduled delay (slice, or slice +
  // boundary grace) ever exceeds MAX_TIMER_DELAY, and a boundary is never
  // abandoned merely because it is far away. At now === endsAt the OPEN phase
  // is still valid, so a refresh is still scheduled just past the boundary to
  // flip to ENDED.
  useEffect(() => {
    const nextBoundary = competitions.reduce<number | null>((acc, comp) => {
      const start = new Date(comp.startsAt).getTime();
      const end = new Date(comp.endsAt).getTime();
      const now = Date.now();
      // Terminal phases are persisted/server-authoritative and need no timer.
      if (comp.phase === 'COMPLETED' || comp.phase === 'CANCELLED' || comp.phase === 'ENDED') return acc;
      const boundary = now < start ? start : now <= end ? end : null;
      if (boundary === null) return acc;
      return Math.min(acc ?? Infinity, boundary);
    }, null);

    if (nextBoundary === null) return;

    let cancelled = false;
    let timer: number | undefined;

    const arm = () => {
      if (cancelled) return;
      const remaining = Math.max(0, nextBoundary - Date.now());
      if (remaining > MAX_TIMER_SLICE) {
        // Far from the boundary: keep the local chain alive in safe slices.
        // No invalidation here — that only happens at the real boundary.
        timer = window.setTimeout(arm, MAX_TIMER_SLICE);
        return;
      }
      timer = window.setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['competitions', groupId] });
      }, remaining + BOUNDARY_GRACE_MS);
    };

    arm();

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [competitions, groupId, queryClient]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-4 border-primary-500 border-t-transparent" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="max-w-2xl mx-auto p-4">
        <Card>
          <CardContent className="py-8 text-center text-gray-500 dark:text-gray-400">
            Could not load competitions — you may not be an active member of this group.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto p-4 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => navigate('/competitions')}>
            ← Groups
          </Button>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Competitions</h1>
        </div>
        {/* OWNER/ADMIN only — display-only gate; the backend re-validates on submit. */}
        {canCreate && !showCreateForm && (
          <Button size="sm" onClick={() => setShowCreateForm(true)}>
            Create competition
          </Button>
        )}
      </div>

      {canCreate && showCreateForm && (
        <Card>
          <CardContent className="pt-6">
            {/* Native browser number-input constraint validation (min/step) would
                otherwise silently block submission before our own JS validation
                runs, hiding our clearer error messages behind an inconsistent
                native tooltip. Our checks below are authoritative instead. */}
            <form onSubmit={handleCreateSubmit} className="space-y-3" aria-label="Create competition" noValidate>
              <div>
                <label htmlFor="new-comp-game" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Game
                </label>
                <select
                  id="new-comp-game"
                  value={gameKey}
                  onChange={(e) => setGameKey(e.target.value)}
                  disabled={createMutation.isPending}
                  className={inputClass}
                >
                  <option value="">Select a game…</option>
                  {games.map((g) => (
                    <option key={g.key} value={g.key}>{g.name}</option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="new-comp-title" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Title
                </label>
                <Input
                  id="new-comp-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Competition title"
                  disabled={createMutation.isPending}
                />
              </div>

              <div>
                <label htmlFor="new-comp-description" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Description <span className="text-gray-400 font-normal">(optional)</span>
                </label>
                <textarea
                  id="new-comp-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={2}
                  disabled={createMutation.isPending}
                  className={inputClass}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="new-comp-starts" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Starts
                  </label>
                  <Input
                    id="new-comp-starts"
                    type="datetime-local"
                    value={startsAtLocal}
                    onChange={(e) => setStartsAtLocal(e.target.value)}
                    disabled={createMutation.isPending}
                  />
                </div>
                <div>
                  <label htmlFor="new-comp-ends" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Ends
                  </label>
                  <Input
                    id="new-comp-ends"
                    type="datetime-local"
                    value={endsAtLocal}
                    onChange={(e) => setEndsAtLocal(e.target.value)}
                    disabled={createMutation.isPending}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="new-comp-entry" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Entry amount (GP)
                  </label>
                  <Input
                    id="new-comp-entry"
                    type="number"
                    min={0}
                    step={1}
                    value={entryAmount}
                    onChange={(e) => setEntryAmount(e.target.value)}
                    disabled={createMutation.isPending}
                  />
                </div>
                <div>
                  <label htmlFor="new-comp-max" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Max participants <span className="text-gray-400 font-normal">(optional)</span>
                  </label>
                  <Input
                    id="new-comp-max"
                    type="number"
                    min={2}
                    step={1}
                    value={maxParticipants}
                    onChange={(e) => setMaxParticipants(e.target.value)}
                    placeholder="Unlimited"
                    disabled={createMutation.isPending}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="new-comp-reward-gp" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Winner reward (GP)
                  </label>
                  <Input
                    id="new-comp-reward-gp"
                    type="number"
                    min={0}
                    step={1}
                    value={rewardGamePoints}
                    onChange={(e) => setRewardGamePoints(e.target.value)}
                    disabled={createMutation.isPending}
                  />
                </div>
                <div>
                  <label htmlFor="new-comp-reward-coins" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Winner reward (Coins)
                  </label>
                  <Input
                    id="new-comp-reward-coins"
                    type="number"
                    min={0}
                    step={1}
                    value={rewardCoins}
                    onChange={(e) => setRewardCoins(e.target.value)}
                    disabled={createMutation.isPending}
                  />
                </div>
              </div>

              {formError && (
                <p role="alert" className="text-sm text-red-600 dark:text-red-400">{formError}</p>
              )}

              <div className="flex gap-2">
                <Button type="submit" size="sm" disabled={createMutation.isPending}>
                  {createMutation.isPending ? 'Creating…' : 'Create competition'}
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={resetCreateForm} disabled={createMutation.isPending}>
                  Cancel
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {competitions.length === 0 ? (
        <div className="py-16 text-center text-gray-500 dark:text-gray-400">
          No competitions in this group yet.
        </div>
      ) : (
        <div className="grid gap-3">
          {competitions.map((comp) => {
            const gameName = comp.game?.name ?? '—';
            const now = Date.now();
            const started = new Date(comp.startsAt).getTime() <= now;
            const ended = new Date(comp.endsAt).getTime() <= now;
            const phase = comp.phase;
            // List cards never advertise Join/Play: participation is only known
            // on the detail page. The card action is navigation only.
            const actionLabel = phase === 'OPEN' || phase === 'UPCOMING' ? 'View' : 'View results';

            return (
              <Card key={comp.id} className="hover:shadow-md transition-shadow">
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle className="text-base">{comp.title}</CardTitle>
                    <div className="flex items-center gap-2">
                      {comp.isFull && (
                        <span className="text-xs font-semibold whitespace-nowrap text-orange-600 dark:text-orange-400">
                          Full
                        </span>
                      )}
                      <span className={`text-xs font-semibold whitespace-nowrap ${PHASE_COLOR[phase] ?? ''}`}>
                        {PHASE_LABEL[phase] ?? phase}
                      </span>
                    </div>
                  </div>
                  {comp.description && (
                    <CardDescription className="line-clamp-2">{comp.description}</CardDescription>
                  )}
                </CardHeader>

                <CardContent className="space-y-2">
                  <div className="flex flex-wrap gap-3 text-sm text-gray-600 dark:text-gray-400">
                    <span>Game: <strong>{gameName}</strong></span>
                    <span>Entry: <strong>{comp.entryAmount > 0 ? `${comp.entryAmount} GP` : 'Free'}</strong></span>
                    {comp.maxParticipants && (
                      <span>Max: <strong>{comp.maxParticipants} players</strong></span>
                    )}
                  </div>

                  {(comp.rewardGamePoints > 0 || comp.rewardCoins > 0) && (
                    <p className="text-xs text-amber-600 dark:text-amber-400">
                      Winner:{' '}
                      {[
                        comp.rewardGamePoints > 0 ? `${comp.rewardGamePoints} GP` : null,
                        comp.rewardCoins > 0 ? `${comp.rewardCoins} Coins` : null,
                      ]
                        .filter(Boolean)
                        .join(' + ')}
                    </p>
                  )}

                  <div className="flex flex-wrap gap-2 text-xs text-gray-500 dark:text-gray-400">
                    <span>
                      {started ? 'Started' : 'Starts'}: {new Date(comp.startsAt).toLocaleDateString()}
                    </span>
                    <span>
                      {ended ? 'Ended' : 'Ends'}: {new Date(comp.endsAt).toLocaleDateString()}
                    </span>
                  </div>

                  <Button
                    size="sm"
                    onClick={() => navigate(`/competitions/${groupId}/${comp.id}`)}
                  >
                    {actionLabel}
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

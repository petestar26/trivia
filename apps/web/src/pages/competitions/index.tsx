/**
 * GroupCompetitionsPage — /competitions/:groupId
 *
 * Lists all competitions for a specific group.  Membership is enforced
 * server-side; the backend returns 403 if the user is not an active member.
 * Action affordances (badge, button) are driven by the server-derived `phase`
 * (UPCOMING/OPEN/ENDED), never by the persisted status alone.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
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

// Client-side ceilings that mirror server-side limits, so an obviously
// oversized value is rejected with a clear message instead of round-tripping
// into a Postgres Int32 overflow (500) or the server's own reward cap (400).
// The server remains the actual authority either way.
const MAX_ENTRY_AMOUNT = 2_147_483_647; // Postgres Int32 ceiling — GroupCompetition.entryAmount
const MAX_PARTICIPANTS_CAP = 2_147_483_647; // Postgres Int32 ceiling — GroupCompetition.maxParticipants
const MAX_REWARD_AMOUNT = 1_000_000; // Mirrors MAX_COMPETITION_REWARD in competition-service.ts

interface BoundedIntResult {
  valid: boolean;
  tooLarge: boolean;
  value: number | null;
}

/**
 * Parses a non-negative-integer form field, bounded by `max`. Blank is
 * treated as the caller's problem (required-field checks happen separately)
 * — this only judges whether a *supplied* value is safe: finite, a whole
 * number, >= 0, and no larger than `max`. `tooLarge` is reported separately
 * from generic invalidity so the caller can show a distinct, actionable
 * message rather than lumping "not a number" and "too big" together.
 */
function parseBoundedNonNegativeInt(value: string, max: number): BoundedIntResult {
  if (value.trim() === '') return { valid: false, tooLarge: false, value: null };
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isSafeInteger(n) || n < 0) {
    return { valid: false, tooLarge: false, value: null };
  }
  if (n > max) return { valid: false, tooLarge: true, value: null };
  return { valid: true, tooLarge: false, value: n };
}

type CreateFormResult =
  | { ok: false; error: string; fields: string[] }
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

  const {
    data: games = [],
    isLoading: gamesLoading,
    isFetching: gamesFetching,
    isError: gamesFailed,
    refetch: refetchGames,
  } = useQuery<ActiveGame[]>({
    queryKey: ['games'],
    queryFn: async () => unwrapData(await api.get<ActiveGame[]>('/games'), 'Games response'),
    enabled: canCreate,
  });
  const gamesUnavailable = !gamesLoading && (gamesFailed || games.length === 0);

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
  const [formErrorFields, setFormErrorFields] = useState<string[]>([]);

  // Disclosure-toggle stays mounted (see `hidden` below) so a ref reliably
  // survives the open/close cycle for focus management, rather than chasing
  // a freshly-mounted node each time.
  const toggleRef = useRef<HTMLButtonElement>(null);
  const gameSelectRef = useRef<HTMLSelectElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const wasOpenRef = useRef(false);
  // Set by the Retry click handler; consumed once the resulting refetch
  // settles (see the effect below) so Retry's own focus outcome doesn't
  // fight with the open/close effect above it.
  const retryPendingRef = useRef(false);

  useEffect(() => {
    if (showCreateForm) {
      wasOpenRef.current = true;
      // Mirrors the select's own `disabled` condition: focusing a disabled
      // control is a silent no-op in real browsers, so land on Title (always
      // enabled at this point) whenever the select isn't actually usable yet.
      if (!gamesLoading && !gamesUnavailable) {
        gameSelectRef.current?.focus();
      } else {
        titleRef.current?.focus();
      }
    } else if (wasOpenRef.current) {
      wasOpenRef.current = false;
      toggleRef.current?.focus();
    }
    // Deliberately keyed only on open/close, not on every games-state change
    // — see the dedicated Retry-settlement effect below for that transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showCreateForm]);

  // Moves focus once a user-initiated Retry settles. `isFetching` (not
  // `isLoading`) is required here: refetching an already-errored query
  // keeps `status: 'error'` (so `isLoading` stays false) while
  // `fetchStatus: 'fetching'` is true for the retry's duration.
  useEffect(() => {
    if (!showCreateForm || !retryPendingRef.current || gamesFetching) return;
    retryPendingRef.current = false;
    if (!gamesUnavailable) {
      gameSelectRef.current?.focus();
    } else if (!gamesFailed) {
      // Retry succeeded but the catalog is still empty — nothing new to
      // focus into; land on Title rather than leaving focus wherever the
      // (now-removed) error text and Retry button used to be.
      titleRef.current?.focus();
    }
    // Otherwise retry failed again: the Retry button is the same DOM node
    // across that re-render (same position in the same conditional block),
    // so it already naturally kept focus from the user's own click.
  }, [gamesFetching, gamesFailed, gamesUnavailable, showCreateForm]);

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
    setFormErrorFields([]);
    setShowCreateForm(false);
  }

  /** Associates the shared form-error alert with the field(s) it describes. */
  function fieldErrorProps(fieldId: string): { 'aria-invalid'?: true; 'aria-describedby'?: string } {
    if (!formError || !formErrorFields.includes(fieldId)) return {};
    return { 'aria-invalid': true, 'aria-describedby': 'create-competition-error' };
  }

  function buildCreatePayload(): CreateFormResult {
    if (!gameKey) return { ok: false, error: 'Choose a game.', fields: ['new-comp-game'] };
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return { ok: false, error: 'Title is required.', fields: ['new-comp-title'] };
    if (!startsAtLocal || !endsAtLocal) {
      return { ok: false, error: 'Start and end time are required.', fields: ['new-comp-starts', 'new-comp-ends'] };
    }

    // datetime-local values are interpreted in the browser's local time zone,
    // exactly matching what the user saw and picked in the field.
    const startsAtDate = new Date(startsAtLocal);
    const endsAtDate = new Date(endsAtLocal);
    if (Number.isNaN(startsAtDate.getTime()) || Number.isNaN(endsAtDate.getTime())) {
      return { ok: false, error: 'Start and end time must be valid.', fields: ['new-comp-starts', 'new-comp-ends'] };
    }
    if (endsAtDate <= startsAtDate) {
      return { ok: false, error: 'End time must be after start time.', fields: ['new-comp-starts', 'new-comp-ends'] };
    }

    const entryResult = parseBoundedNonNegativeInt(entryAmount, MAX_ENTRY_AMOUNT);
    if (!entryResult.valid) {
      return {
        ok: false,
        fields: ['new-comp-entry'],
        error: entryResult.tooLarge
          ? `Entry amount must be ${MAX_ENTRY_AMOUNT.toLocaleString('en-US')} or less.`
          : 'Entry amount must be a non-negative whole number.',
      };
    }

    const rGPResult = parseBoundedNonNegativeInt(rewardGamePoints, MAX_REWARD_AMOUNT);
    if (!rGPResult.valid) {
      return {
        ok: false,
        fields: ['new-comp-reward-gp'],
        error: rGPResult.tooLarge
          ? `Game Point reward must be ${MAX_REWARD_AMOUNT.toLocaleString('en-US')} or less.`
          : 'Game Point reward must be a non-negative whole number.',
      };
    }

    const rCoinsResult = parseBoundedNonNegativeInt(rewardCoins, MAX_REWARD_AMOUNT);
    if (!rCoinsResult.valid) {
      return {
        ok: false,
        fields: ['new-comp-reward-coins'],
        error: rCoinsResult.tooLarge
          ? `Coin reward must be ${MAX_REWARD_AMOUNT.toLocaleString('en-US')} or less.`
          : 'Coin reward must be a non-negative whole number.',
      };
    }

    let maxP: number | undefined;
    if (maxParticipants.trim() !== '') {
      // The field is `type="text" inputMode="numeric"` (not `type="number"`)
      // specifically so malformed input like "2e" or "-" arrives here as the
      // literal typed string rather than being silently coerced to "" by
      // native number-input `badInput` sanitization, which would otherwise
      // read as blank and silently become "unlimited" below.
      const n = Number(maxParticipants);
      if (!Number.isFinite(n) || !Number.isSafeInteger(n) || n < 2) {
        return {
          ok: false,
          error: 'Max participants must be blank or an integer of 2 or more.',
          fields: ['new-comp-max'],
        };
      }
      if (n > MAX_PARTICIPANTS_CAP) {
        return {
          ok: false,
          error: `Max participants must be ${MAX_PARTICIPANTS_CAP.toLocaleString('en-US')} or fewer.`,
          fields: ['new-comp-max'],
        };
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
        entryAmount: entryResult.value!,
        maxParticipants: maxP,
        rewardGamePoints: rGPResult.value!,
        rewardCoins: rCoinsResult.value!,
      },
    };
  }

  const createMutation = useMutation({
    mutationFn: (body: CreateCompetitionBody) => api.createCompetition(body),
    onSuccess: (res) => {
      // The competition (and, if funded, its prize escrow debit) is already
      // committed server-side at this point regardless of what the response
      // body looks like below, so the list and wallet caches are refreshed
      // unconditionally.
      queryClient.invalidateQueries({ queryKey: ['competitions', groupId] });
      queryClient.invalidateQueries({ queryKey: ['wallet'] });
      queryClient.invalidateQueries({ queryKey: ['wallet-transactions'] });

      const created = res.data;
      if (!created?.id) {
        // A 2xx response without an id — including a non-JSON 2xx body,
        // which ApiClient.request() silently parses to `{}` — means we
        // cannot confirm the competition was actually created or find it.
        // Never claim success here: close/reset the form rather than
        // leaving the entered values sitting ready to resubmit, which would
        // risk creating (and escrow-funding) a duplicate. The warning goes
        // through the toast system — the form and its inline alert are
        // gone by the time this fires — rather than a normal success toast.
        resetCreateForm();
        toast({
          title: 'Competition status unknown',
          description: "We couldn't confirm the competition was created. Check the competition list before trying again.",
          variant: 'destructive',
        });
        return;
      }
      toast({ title: 'Competition created' });
      resetCreateForm();
      navigate(`/competitions/${groupId}/${created.id}`);
    },
    onError: (err) => {
      let msg = 'Failed to create competition';
      try { msg = JSON.parse((err as Error).message)?.message ?? msg; } catch { /* noop */ }
      setFormError(msg);
      setFormErrorFields([]);
    },
  });

  function handleCreateSubmit(e: FormEvent) {
    e.preventDefault();
    if (createMutation.isPending) return;

    const result = buildCreatePayload();
    if (!result.ok) {
      setFormError(result.error);
      setFormErrorFields(result.fields);
      return;
    }
    setFormError(null);
    setFormErrorFields([]);
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
        {/* OWNER/ADMIN only — display-only gate; the backend re-validates on submit.
            Stays mounted (hidden, not unmounted) while the form is open: the
            `hidden` attribute drops it from the accessibility tree and from
            `getByRole` queries just like unmounting would, but keeps
            `toggleRef` pointing at a stable node so focus can reliably return
            to it on Cancel/success. The `hidden` attribute alone is not
            enough here — Button's own base class includes `inline-flex`,
            and Tailwind's `[hidden]{display:none}` base rule sits earlier in
            the stylesheet than the `.inline-flex{display:inline-flex}`
            utility, so `inline-flex` would win the cascade and the button
            would stay visible and focusable. Passing `className="hidden"`
            lets `cn()` (clsx + tailwind-merge) drop the conflicting
            `inline-flex` utility instead of just losing a specificity fight. */}
        {canCreate && (
          <Button
            ref={toggleRef}
            hidden={showCreateForm}
            className={showCreateForm ? 'hidden' : undefined}
            size="sm"
            aria-expanded={showCreateForm}
            aria-controls="create-competition-form"
            onClick={() => setShowCreateForm(true)}
          >
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
            <form
              id="create-competition-form"
              onSubmit={handleCreateSubmit}
              className="space-y-3"
              aria-label="Create competition"
              noValidate
            >
              <div>
                <label htmlFor="new-comp-game" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Game
                </label>
                <select
                  id="new-comp-game"
                  ref={gameSelectRef}
                  value={gameKey}
                  onChange={(e) => setGameKey(e.target.value)}
                  disabled={createMutation.isPending || gamesLoading || gamesUnavailable}
                  className={inputClass}
                  {...fieldErrorProps('new-comp-game')}
                >
                  <option value="">Select a game…</option>
                  {games.map((g) => (
                    <option key={g.key} value={g.key}>{g.name}</option>
                  ))}
                </select>
                {gamesLoading && (
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Loading games…</p>
                )}
                {!gamesLoading && gamesFailed && (
                  <div className="flex items-center gap-2 mt-1">
                    <p role="alert" className="text-xs text-red-600 dark:text-red-400">
                      Could not load games.
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        retryPendingRef.current = true;
                        refetchGames();
                      }}
                    >
                      Retry
                    </Button>
                  </div>
                )}
                {!gamesLoading && !gamesFailed && games.length === 0 && (
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">No active games are available.</p>
                )}
              </div>

              <div>
                <label htmlFor="new-comp-title" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Title
                </label>
                <Input
                  id="new-comp-title"
                  ref={titleRef}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Competition title"
                  disabled={createMutation.isPending}
                  {...fieldErrorProps('new-comp-title')}
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
                    {...fieldErrorProps('new-comp-starts')}
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
                    {...fieldErrorProps('new-comp-ends')}
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
                    {...fieldErrorProps('new-comp-entry')}
                  />
                </div>
                <div>
                  <label htmlFor="new-comp-max" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Max participants <span className="text-gray-400 font-normal">(optional)</span>
                  </label>
                  {/* type="text" + inputMode="numeric" (not type="number") so a
                      malformed value like "2e" or "-" arrives in onChange as the
                      literal typed string instead of being silently sanitized to
                      "" by native number-input badInput handling — which would
                      otherwise read as blank and become "unlimited" below. */}
                  <Input
                    id="new-comp-max"
                    type="text"
                    inputMode="numeric"
                    autoComplete="off"
                    value={maxParticipants}
                    onChange={(e) => setMaxParticipants(e.target.value)}
                    placeholder="Unlimited"
                    disabled={createMutation.isPending}
                    {...fieldErrorProps('new-comp-max')}
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
                    {...fieldErrorProps('new-comp-reward-gp')}
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
                    {...fieldErrorProps('new-comp-reward-coins')}
                  />
                </div>
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Rewards are deducted from your balance as soon as the competition is created, whether or not anyone joins.
              </p>

              {formError && (
                <p id="create-competition-error" role="alert" className="text-sm text-red-600 dark:text-red-400">
                  {formError}
                </p>
              )}

              <div className="flex gap-2">
                {/* Only gated on a *confirmed* empty/failed games result, not on
                    `gamesLoading` itself — while loading, "Choose a game." from
                    the normal required-field check already blocks submission,
                    without a transient disable flicker while the catalog fetch
                    is still in flight. */}
                <Button type="submit" size="sm" disabled={createMutation.isPending || gamesUnavailable}>
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

import { recordActivity as recordStreak, getStreak } from '../tasks/streak-service';
import { recordTaskEvent } from '../tasks/task-service';
import { unlockAchievement } from './achievement-service';
import { getProgress } from '../progress/progress-service';

export type ActivityEventType =
  | 'LOGIN'
  | 'MESSAGE'
  | 'VOICE_MESSAGE'
  | 'GIFT_SENT'
  | 'GIFT_RECEIVED'
  | 'GROUP_JOIN';

export interface ActivityEvent {
  type: ActivityEventType;
}

const EVENT_TASK_MAP: Partial<Record<ActivityEventType, string[]>> = {
  LOGIN: ['daily_login', 'stay_active'],
  MESSAGE: ['send_message', 'stay_active'],
  VOICE_MESSAGE: ['send_voice_message', 'stay_active'],
  GIFT_SENT: ['send_gift', 'stay_active'],
  GIFT_RECEIVED: ['receive_gift', 'stay_active'],
  GROUP_JOIN: ['stay_active'],
};

const EVENT_ACHIEVEMENT_MAP: Partial<Record<ActivityEventType, string>> = {
  MESSAGE: 'first_message',
  VOICE_MESSAGE: 'first_voice_message',
  GIFT_SENT: 'first_gift_sent',
  GIFT_RECEIVED: 'first_gift_received',
  GROUP_JOIN: 'first_group',
};

/**
 * Single server-side activity intake.
 *
 * MUST be called AFTER the originating action's transaction commits (never
 * inside a financial transaction), because achievements/tasks grant XP and
 * GamePoints via their own transactions. Every side effect is derived from the
 * server-verified event type; the client cannot claim a task or force an
 * achievement.
 */
export async function recordActivity(
  userId: string,
  event: ActivityEvent
): Promise<void> {
  // Streak (duplicate same-day activity is naturally ignored).
  await recordStreak(userId);

  // Task progress keyed by the event type.
  const taskKeys = EVENT_TASK_MAP[event.type] ?? [];
  for (const key of taskKeys) {
    try {
      await recordTaskEvent(userId, key);
    } catch {
      // Task progress is non-critical; never fail the caller.
    }
  }

  // First-time achievements.
  const achievementKey = EVENT_ACHIEVEMENT_MAP[event.type];
  if (achievementKey) {
    try {
      await unlockAchievement(userId, achievementKey);
    } catch {
      // Non-critical.
    }
  }
}

/** Unlock streak milestones based on current streak value (once each). */
export async function maybeUnlockStreakMilestones(userId: string): Promise<void> {
  const s = await getStreak(userId);
  if (s.currentStreak >= 3) {
    try {
      await unlockAchievement(userId, 'streak_3');
    } catch {
      // Non-critical.
    }
  }
}

/** Unlock level milestones when the user levels up. */
export async function maybeUnlockLevelMilestones(userId: string): Promise<void> {
  const p = await getProgress(userId);
  if (p.level >= 2) {
    try {
      await unlockAchievement(userId, 'level_2');
    } catch {
      // Non-critical.
    }
  }
}

/**
 * Fire-and-forget wrapper for post-commit activity recording. Errors are
 * swallowed so that rewards/tasks never break the originating request or the
 * originating financial transaction.
 */
export function safeRecordActivity(
  userId: string,
  event: ActivityEvent
): Promise<void> {
  return recordActivity(userId, event).catch(() => {
    // Activity/rewards are best-effort and non-critical to the primary action.
  });
}

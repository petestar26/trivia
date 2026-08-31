import { prisma } from '@socialplay/database';
import { ApiError } from '../middleware';
import { utcDayKey } from '../utils/dates';
import { applyXp } from '../progress/progress-service';

export type TaskType = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'ONE_TIME';
export type TaskStatus = 'IN_PROGRESS' | 'COMPLETED' | 'CLAIMED';

export interface TaskDef {
  key: string;
  type: TaskType;
  title: string;
  description: string;
  target: number;
  xpReward: number;
  coinReward: number;
  gamePointReward: number;
}

/**
 * Server-defined task catalog. Clients cannot create or define tasks. Task
 * progress is incremented by server-verified activity only.
 */
export const TASK_DEFS: TaskDef[] = [
  { key: 'daily_login', type: 'DAILY', title: 'Daily Login', description: 'Log in today', target: 1, xpReward: 10, coinReward: 0, gamePointReward: 5 },
  { key: 'send_message', type: 'DAILY', title: 'Send Messages', description: 'Send a message in a group', target: 3, xpReward: 20, coinReward: 0, gamePointReward: 10 },
  { key: 'send_gift', type: 'DAILY', title: 'Send Gifts', description: 'Send a gift to someone', target: 2, xpReward: 30, coinReward: 0, gamePointReward: 15 },
  { key: 'receive_gift', type: 'DAILY', title: 'Receive Gifts', description: 'Receive a gift today', target: 1, xpReward: 20, coinReward: 0, gamePointReward: 10 },
  { key: 'send_voice_message', type: 'DAILY', title: 'Send Voice Message', description: 'Send a voice message', target: 1, xpReward: 15, coinReward: 0, gamePointReward: 5 },
  { key: 'stay_active', type: 'DAILY', title: 'Stay Active', description: 'Complete any activity today', target: 1, xpReward: 5, coinReward: 0, gamePointReward: 2 },
];

/** Ensure TaskDefinition rows exist (idempotent by unique key). */
export async function ensureTasks(): Promise<void> {
  for (const def of TASK_DEFS) {
    await prisma.taskDefinition.upsert({
      where: { key: def.key },
      update: {
        type: def.type,
        title: def.title,
        description: def.description,
        target: def.target,
        xpReward: def.xpReward,
        coinReward: def.coinReward,
        gamePointReward: def.gamePointReward,
        isActive: true,
      },
      create: {
        key: def.key,
        type: def.type,
        title: def.title,
        description: def.description,
        target: def.target,
        xpReward: def.xpReward,
        coinReward: def.coinReward,
        gamePointReward: def.gamePointReward,
      },
    });
  }
}

/**
 * Server-verified task event. Increments progress for the matching task for
 * the current canonical (UTC) day. When the target is reached the task is
 * marked COMPLETED and its XP reward is granted once per (task, period) via
 * the unique `UserXpEvent` constraint. Coin/GamePoint rewards are separate and
 * claimed through `claimTaskReward`.
 */
export async function recordTaskEvent(
  userId: string,
  taskKey: string,
  increment: number = 1,
  when: Date = new Date()
): Promise<void> {
  if (!Number.isInteger(increment) || increment <= 0) {
    throw ApiError.badRequest('Increment must be a positive integer');
  }

  await ensureTasks();
  const def = await prisma.taskDefinition.findUnique({ where: { key: taskKey } });
  if (!def || !def.isActive) return;

  const periodKey = def.type === 'DAILY' ? utcDayKey(when) : null;
  const xpRefId = periodKey ? `${def.id}:${periodKey}` : def.id;

  await prisma.$transaction(async (tx) => {
    // Read the current row first so we do not increment progress on a task
    // that has already reached a terminal state. The upsert below is still
    // used for the atomic create-or-update, but the status check must happen
    // before any write to prevent completed/claimed tasks from accumulating
    // progress across duplicate events.
    const existing = await tx.userTask.findUnique({
      where: { userId_taskId_periodKey: { userId, taskId: def.id, periodKey } },
    });

    if (existing && (existing.status === 'COMPLETED' || existing.status === 'CLAIMED')) {
      return;
    }

    // Use atomic increment to avoid lost-update races under concurrent
    // activity (previously read-then-write absolute value clobbered
    // concurrent increments).
    const task = await tx.userTask.upsert({
      where: { userId_taskId_periodKey: { userId, taskId: def.id, periodKey } },
      update: { progress: { increment: increment } },
      create: { userId, taskId: def.id, periodKey, progress: increment },
    });

    // If a concurrent transaction completed/claimed the task between our
    // findUnique and the upsert, ensure progress never exceeds the target and
    // do not re-run completion side effects.
    if (task.status === 'COMPLETED' || task.status === 'CLAIMED') {
      if (task.progress > def.target) {
        await tx.userTask.update({
          where: { id: task.id },
          data: { progress: def.target },
        });
      }
      return;
    }

    const cappedProgress = Math.min(task.progress, def.target);
    const completed = cappedProgress >= def.target;

    if (task.progress !== cappedProgress) {
      await tx.userTask.update({
        where: { id: task.id },
        data: { progress: cappedProgress },
      });
    }

    if (completed) {
      await tx.userTask.update({
        where: { id: task.id },
        data: { status: 'COMPLETED', completedAt: new Date() },
      });

      if (def.xpReward > 0) {
        await applyXp(tx, userId, {
          amount: def.xpReward,
          reason: `Task completed: ${def.title}`,
          referenceType: 'TASK',
          referenceId: xpRefId,
        });
      }
    }
  });
}

/**
 * Claim the Coin/GamePoint reward for a completed task. Guarded by
 * `RewardClaim` unique constraint so the monetary reward is granted exactly
 * once.
 */
export async function claimTaskReward(userId: string, taskDefId: string) {
  // The client receives `id = TaskDefinition.id` from listTasks (not the
  // UserTask primary key). Resolve the UserTask via the composite unique key.
  const def = await prisma.taskDefinition.findUnique({ where: { id: taskDefId } });
  if (!def) throw ApiError.notFound('Task not found');

  const periodKey = def.type === 'DAILY' ? utcDayKey() : null;

  const task = await prisma.userTask.findUnique({
    where: { userId_taskId_periodKey: { userId, taskId: def.id, periodKey } },
    include: { task: true },
  });

  if (!task || task.userId !== userId) {
    throw ApiError.notFound('Task not found');
  }
  if (task.status === 'IN_PROGRESS') {
    throw ApiError.badRequest('Task is not completed yet');
  }

  // If already claimed, delegate to the RewardClaim unique guard so a second
  // attempt returns `alreadyClaimed` rather than erroring.
  const periodSuffix = task.periodKey ? `:${task.periodKey}` : '';
  return import('../rewards/reward-service').then(async ({ grantReward }) => {
    const result = await grantReward(userId, {
      sourceType: 'TASK',
      sourceId: `${task.taskId}${periodSuffix}`,
      xpReward: 0,
      coinReward: task.task.coinReward,
      gamePointReward: task.task.gamePointReward,
    });

    if (result.granted) {
      await prisma.userTask.update({
        where: { id: task.id },
        data: { status: 'CLAIMED', claimedAt: new Date() },
      });
    }

    return result;
  });
}

export async function listTasks(userId: string) {
  await ensureTasks();
  const defs = await prisma.taskDefinition.findMany({
    where: { isActive: true },
    orderBy: { key: 'asc' },
  });

  const periodKey = utcDayKey();

  const tasks = await Promise.all(
    defs.map(async (def) => {
      const userTask = await prisma.userTask.findUnique({
        where: {
          userId_taskId_periodKey: {
            userId,
            taskId: def.id,
            periodKey: def.type === 'DAILY' ? periodKey : null,
          },
        },
      });

      return {
        id: def.id,
        key: def.key,
        type: def.type,
        title: def.title,
        description: def.description,
        target: def.target,
        xpReward: def.xpReward,
        coinReward: def.coinReward,
        gamePointReward: def.gamePointReward,
        progress: userTask?.progress ?? 0,
        status: userTask?.status ?? 'IN_PROGRESS',
      };
    })
  );

  return tasks;
}

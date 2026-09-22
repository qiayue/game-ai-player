import type { Env } from './env.js';
import type { Track } from '@gap/shared';
import { refreshSnapshot } from './leaderboard.js';
import { fetchModels } from './ai/openrouter.js';
import * as repo from './repo.js';
import { invalidateModelCache } from './routes/models.js';

/**
 * 排行榜快照重建。
 *
 * 不遍历所有游戏 × 赛道 × 时间窗（那是 66 个组合），
 * 只重建被标记为「脏」的那几个 —— 标记由终局写入时打上。
 */
export async function rebuildDirtySnapshots(env: Env, limit = 40): Promise<number> {
  const list = await env.KV.list({ prefix: 'dirty:lb:', limit });
  let n = 0;
  for (const key of list.keys) {
    const [, , gameId, track, ...rest] = key.name.split(':');
    const windowKey = rest.join(':');
    if (!gameId || !track || !windowKey) {
      await env.KV.delete(key.name);
      continue;
    }
    try {
      await refreshSnapshot(env, gameId, track as Track, windowKey);
      await env.KV.delete(key.name);
      n++;
    } catch (err) {
      console.error('refresh snapshot failed', key.name, err);
    }
  }
  return n;
}

/** 每天从 OpenRouter 同步一次模型列表。新模型上线不需要改代码。 */
export async function syncOpenRouterModels(env: Env): Promise<number> {
  if (!env.OPENROUTER_API_KEY) return 0;
  const models = await fetchModels(env);
  const n = await repo.syncModels(env, models);
  await invalidateModelCache(env);
  return n;
}

export async function handleScheduled(event: ScheduledController, env: Env): Promise<void> {
  if (event.cron === '17 3 * * *') {
    try {
      const n = await syncOpenRouterModels(env);
      console.log(`synced ${n} models from OpenRouter`);
    } catch (err) {
      console.error('model sync failed', err);
    }
    return;
  }
  const n = await rebuildDirtySnapshots(env);
  if (n) console.log(`rebuilt ${n} leaderboard snapshots`);
}

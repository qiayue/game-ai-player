import { Hono } from 'hono';
import type { Env, Vars } from '../env.js';
import { notFound, IMMUTABLE, param } from '../util/http.js';
import * as storage from '../storage.js';

export const replays = new Hono<{ Bindings: Env; Variables: Vars }>();

/** 回放包：seed + 走法序列。已结束的对局不会再变，所以可以永久缓存。 */
replays.get('/:matchId', async (c) => {
  const pkg = await storage.getReplay(c.env, param(c, 'matchId'));
  if (!pkg) throw notFound('没有这局回放');
  return c.json(pkg, { headers: IMMUTABLE });
});

/** 某一步 AI 的完整 prompt / 回复 / 推理 / 用量，回放页按需拉取 */
replays.get('/:matchId/ai/:ply', async (c) => {
  const ply = Number(param(c, 'ply'));
  if (!Number.isInteger(ply) || ply < 0) throw notFound('步数不合法');
  const rec = await storage.getAiStep(c.env, param(c, 'matchId'), ply);
  if (!rec) throw notFound('这一步没有 AI 记录');
  return c.json(rec, { headers: IMMUTABLE });
});

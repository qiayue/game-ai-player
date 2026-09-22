import { Hono } from 'hono';
import type { Env, Vars } from '../env.js';
import type { Track } from '@gap/shared';
import { getGame } from '@gap/games';
import { getLeaderboard } from '../leaderboard.js';
import { badRequest, notFound, cacheHeaders, param } from '../util/http.js';
import * as repo from '../repo.js';

export const leaderboards = new Hono<{ Bindings: Env; Variables: Vars }>();

/** 只接受预先建好索引的固定组合，避免被构造成全表扫描 */
export function parseWindow(raw: string | undefined): string {
  const w = raw ?? 'all';
  if (w === 'all') return 'all';
  if (/^daily:\d{4}-\d{2}-\d{2}$/.test(w)) return w;
  if (/^weekly:\d{4}-W\d{2}$/.test(w)) return w;
  if (w === 'daily') return `daily:${new Date().toISOString().slice(0, 10)}`;
  if (w === 'weekly') {
    const d = new Date();
    const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const dayNum = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
    return `weekly:${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
  }
  throw badRequest('不支持的时间窗');
}

export function parseTrack(raw: string | undefined): Track {
  if (raw === 'ai') return 'ai';
  if (raw === 'human' || raw === undefined) return 'human';
  throw badRequest('track 只能是 human 或 ai');
}

leaderboards.get('/:gameId', async (c) => {
  const gameId = param(c, 'gameId');
  try {
    getGame(gameId);
  } catch {
    throw notFound('没有这个游戏');
  }
  const track = parseTrack(c.req.query('track'));
  const windowKey = parseWindow(c.req.query('window'));
  const data = await getLeaderboard(c.env, gameId, track, windowKey);
  const limit = Math.min(Number(c.req.query('limit') ?? '100'), 100);
  return c.json({ ...data, rows: data.rows.slice(0, limit) }, { headers: cacheHeaders(60) });
});

leaderboards.get('/:gameId/me', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ best: null, rank: null });
  const gameId = param(c, 'gameId');
  const track = parseTrack(c.req.query('track'));
  const windowKey = parseWindow(c.req.query('window'));
  const best = await repo.getPersonalBest(c.env, gameId, track, windowKey, user.id);
  const rank = best ? await repo.rankWithin(c.env, gameId, track, windowKey, best.bestScore) : null;
  return c.json({ best, rank }, { headers: { 'Cache-Control': 'private, no-store' } });
});

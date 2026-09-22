import type { Env } from './env.js';
import type { LeaderboardResponse, LeaderboardRow, Track } from '@gap/shared';
import * as repo from './repo.js';
import { getGame } from '@gap/games';

/** 一局成绩会同时进「总榜 / 日榜 / 周榜」三个窗口 */
export function windowKeys(ts: number): string[] {
  const d = new Date(ts);
  const day = d.toISOString().slice(0, 10);
  const week = isoWeek(d);
  return ['all', `daily:${day}`, `weekly:${week}`];
}

function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

const DEFAULT_RATING = 1500;
const K = 24;

/** 标准 Elo。双人游戏用它排名，单人游戏用分数。 */
export function eloUpdate(a: number, b: number, scoreA: number): [number, number] {
  const ea = 1 / (1 + 10 ** ((b - a) / 400));
  const eb = 1 - ea;
  return [a + K * (scoreA - ea), b + K * (1 - scoreA - eb)];
}

export interface FinishedSeat {
  playerId: string;
  seat: number;
  score: number;
  result: 'win' | 'loss' | 'draw' | null;
}

/**
 * 终局后更新排行榜。
 * 单人游戏：best_score = 分数，同分比用时。
 * 双人游戏：先算 Elo，再把四舍五入后的 rating 写进 best_score，这样排序索引可以共用。
 */
export async function applyMatchToLeaderboards(
  env: Env,
  opts: { gameId: string; track: Track; matchId: string; endedAt: number; durationMs: number; seats: FinishedSeat[] },
): Promise<void> {
  const def = getGame(opts.gameId);
  const db = repo.dbFor(env, opts.gameId);
  const windows = windowKeys(opts.endedAt);
  const stmts: D1PreparedStatement[] = [];

  if (def.players === 2 && opts.seats.length === 2) {
    const [s0, s1] = opts.seats;
    for (const windowKey of windows) {
      const ratings = await repo.getRatings(env, opts.gameId, opts.track, windowKey, [s0.playerId, s1.playerId]);
      const r0 = ratings.get(s0.playerId) ?? DEFAULT_RATING;
      const r1 = ratings.get(s1.playerId) ?? DEFAULT_RATING;
      const scoreA = s0.result === 'win' ? 1 : s0.result === 'draw' ? 0.5 : 0;
      const [n0, n1] = eloUpdate(r0, r1, scoreA);
      stmts.push(
        repo.leaderboardUpsertStmt(db, {
          gameId: opts.gameId, track: opts.track, windowKey, playerId: s0.playerId,
          score: Math.round(n0), matchId: opts.matchId, tiebreakMs: null, result: s0.result, rating: n0,
        }),
        repo.leaderboardUpsertStmt(db, {
          gameId: opts.gameId, track: opts.track, windowKey, playerId: s1.playerId,
          score: Math.round(n1), matchId: opts.matchId, tiebreakMs: null, result: s1.result, rating: n1,
        }),
      );
    }
  } else {
    for (const windowKey of windows) {
      for (const seat of opts.seats) {
        stmts.push(
          repo.leaderboardUpsertStmt(db, {
            gameId: opts.gameId, track: opts.track, windowKey, playerId: seat.playerId,
            score: seat.score, matchId: opts.matchId, tiebreakMs: opts.durationMs, result: null, rating: null,
          }),
        );
      }
    }
  }

  if (stmts.length) await db.batch(stmts);
  // 榜变了：失效 KV 缓存，并打上「脏」标记让 Cron 去重建快照，
  // 这样重建只覆盖真正有活动的榜，而不是遍历所有游戏 × 赛道 × 时间窗
  await Promise.all(
    windows.flatMap((w) => [
      env.KV.delete(cacheKey(opts.gameId, opts.track, w)),
      env.KV.put(dirtyKey(opts.gameId, opts.track, w), '1', { expirationTtl: 86400 }),
    ]),
  );
}

const cacheKey = (gameId: string, track: Track, windowKey: string) => `lb:${gameId}:${track}:${windowKey}`;
export const dirtyKey = (gameId: string, track: Track, windowKey: string) =>
  `dirty:lb:${gameId}:${track}:${windowKey}`;

/** 把 Top 100 序列化成一行 JSON 存进 D1 快照表和 KV，前台读的是这份 */
export async function refreshSnapshot(
  env: Env, gameId: string, track: Track, windowKey: string,
): Promise<LeaderboardResponse> {
  const rows = await repo.queryLeaderboard(env, gameId, track, windowKey, 100);
  const payload: LeaderboardResponse = { gameId, track, window: windowKey, updatedAt: Date.now(), rows };
  const text = JSON.stringify(payload);
  await repo.writeSnapshot(env, gameId, track, windowKey, text);
  await env.KV.put(cacheKey(gameId, track, windowKey), text, { expirationTtl: 300 });
  await env.KV.delete(dirtyKey(gameId, track, windowKey));
  return payload;
}

/**
 * 读排行榜：KV → D1 快照表 → 现算。
 * 正常路径是一次 KV 读，不落任何 SQL 排序。
 */
export async function getLeaderboard(
  env: Env, gameId: string, track: Track, windowKey: string,
): Promise<LeaderboardResponse> {
  const cached = await env.KV.get(cacheKey(gameId, track, windowKey));
  if (cached) return JSON.parse(cached) as LeaderboardResponse;

  // 缓存没命中时才多读一次「脏」标记：有新成绩进来过就必须重建，
  // 否则会把刚被更新过的榜当成还新鲜的快照读回来
  const dirty = await env.KV.get(dirtyKey(gameId, track, windowKey));
  if (!dirty) {
    const snap = await repo.readSnapshot(env, gameId, track, windowKey);
    if (snap && Date.now() - snap.updatedAt < 10 * 60_000) {
      await env.KV.put(cacheKey(gameId, track, windowKey), snap.payload, { expirationTtl: 300 });
      return JSON.parse(snap.payload) as LeaderboardResponse;
    }
  }
  return refreshSnapshot(env, gameId, track, windowKey);
}

export function topRows(resp: LeaderboardResponse, n: number): LeaderboardRow[] {
  return resp.rows.slice(0, n);
}

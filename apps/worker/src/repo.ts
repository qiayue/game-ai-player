/**
 * D1 访问层。
 *
 * 所有 SQL 都集中在这里，路由层不直接碰 D1。这样将来按 game_id 水平分库时，
 * 只要改 dbFor() 一处即可（见 docs/04-d1-performance.md 问题 8）。
 *
 * 规则：
 *  - 一个请求里的多条语句用 db.batch() 合成一次往返
 *  - 列表一律 keyset 分页，不用 OFFSET
 *  - 不做实时 COUNT(*)，计数走 stats 表
 */
import type { Env } from './env.js';
import type { LeaderboardRow, PublicUser, Track } from '@gap/shared';

/** 分库开关的唯一入口。目前所有游戏共用一个库。 */
export function dbFor(env: Env, _gameId?: string): D1Database {
  return env.DB;
}

// ---------------------------------------------------------------- players

export interface PlayerRow {
  id: string;
  kind: 'human' | 'ai';
  handle: string;
  display_name: string;
  avatar_url: string | null;
  model_key: string | null;
  is_admin: number;
  created_at: number;
}

function toPublic(row: PlayerRow): PublicUser {
  return {
    id: row.id,
    handle: row.handle,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    isAdmin: row.is_admin === 1,
  };
}

export async function getPlayerByGoogleSub(env: Env, sub: string): Promise<PublicUser | null> {
  const row = await dbFor(env)
    .prepare('SELECT * FROM players WHERE google_sub = ?')
    .bind(sub)
    .first<PlayerRow>();
  return row ? toPublic(row) : null;
}

export async function getPlayerById(env: Env, id: string): Promise<PlayerRow | null> {
  return dbFor(env).prepare('SELECT * FROM players WHERE id = ?').bind(id).first<PlayerRow>();
}

export async function getPlayerByHandle(env: Env, handle: string): Promise<PlayerRow | null> {
  return dbFor(env).prepare('SELECT * FROM players WHERE handle = ?').bind(handle).first<PlayerRow>();
}

export async function getPlayersByIds(env: Env, ids: string[]): Promise<Map<string, PlayerRow>> {
  const unique = [...new Set(ids)].filter(Boolean);
  if (!unique.length) return new Map();
  const marks = unique.map(() => '?').join(',');
  const res = await dbFor(env)
    .prepare(`SELECT * FROM players WHERE id IN (${marks})`)
    .bind(...unique)
    .all<PlayerRow>();
  return new Map((res.results ?? []).map((r) => [r.id, r]));
}

export async function uniqueHandle(env: Env, base: string): Promise<string> {
  const taken = await dbFor(env)
    .prepare("SELECT handle FROM players WHERE handle = ? OR handle LIKE ? || '-%'")
    .bind(base, base)
    .all<{ handle: string }>();
  const set = new Set((taken.results ?? []).map((r) => r.handle));
  if (!set.has(base)) return base;
  for (let i = 2; i < 1000; i++) if (!set.has(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${Date.now().toString(36)}`;
}

export async function createHumanPlayer(
  env: Env,
  p: { id: string; handle: string; displayName: string; avatarUrl: string | null; googleSub: string; isAdmin: boolean },
): Promise<void> {
  await dbFor(env)
    .prepare(
      `INSERT INTO players (id, kind, handle, display_name, avatar_url, google_sub, is_admin, created_at)
       VALUES (?, 'human', ?, ?, ?, ?, ?, ?)`,
    )
    .bind(p.id, p.handle, p.displayName, p.avatarUrl, p.googleSub, p.isAdmin ? 1 : 0, Date.now())
    .run();
}

export async function setAdmin(env: Env, playerId: string, isAdmin: boolean): Promise<void> {
  await dbFor(env).prepare('UPDATE players SET is_admin = ? WHERE id = ?').bind(isAdmin ? 1 : 0, playerId).run();
}

export async function updateProfile(
  env: Env, playerId: string, patch: { displayName?: string; handle?: string },
): Promise<void> {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (patch.displayName !== undefined) { sets.push('display_name = ?'); args.push(patch.displayName); }
  if (patch.handle !== undefined) { sets.push('handle = ?'); args.push(patch.handle); }
  if (!sets.length) return;
  args.push(playerId);
  await dbFor(env).prepare(`UPDATE players SET ${sets.join(', ')} WHERE id = ?`).bind(...args).run();
}

/** AI 模型对应的虚拟玩家，第一次用到时创建 */
export async function ensureAiPlayer(env: Env, modelKey: string, displayName: string): Promise<PlayerRow> {
  const existing = await dbFor(env)
    .prepare('SELECT * FROM players WHERE model_key = ?')
    .bind(modelKey)
    .first<PlayerRow>();
  if (existing) return existing;

  const { ulid, slugify } = await import('./util/ids.js');
  const id = ulid();
  const handle = await uniqueHandle(env, slugify(modelKey.replace('/', '-'), `ai-${id.slice(-6).toLowerCase()}`));
  await dbFor(env)
    .prepare(
      `INSERT INTO players (id, kind, handle, display_name, model_key, is_admin, created_at)
       VALUES (?, 'ai', ?, ?, ?, 0, ?)`,
    )
    .bind(id, handle, displayName, modelKey, Date.now())
    .run();
  return {
    id, kind: 'ai', handle, display_name: displayName, avatar_url: null,
    model_key: modelKey, is_admin: 0, created_at: Date.now(),
  };
}

// ---------------------------------------------------------------- matches

export interface MatchRow {
  id: string;
  game_id: string;
  mode: string;
  track: Track;
  seed: string;
  ruleset_ver: number;
  status: string;
  ended_reason: string | null;
  score: number | null;
  result: string | null;
  moves_count: number;
  duration_ms: number | null;
  final_hash: string | null;
  ai_run_id: string | null;
  indexable: number;
  started_at: number;
  ended_at: number;
}

export interface MatchPlayerRow {
  match_id: string;
  seat: number;
  player_id: string;
  is_ai: number;
  model_key: string | null;
  score: number | null;
  result: string | null;
  ai_calls: number;
  ai_illegal_moves: number;
  ai_input_tokens: number;
  ai_output_tokens: number;
  ai_cost_usd: number;
  ai_latency_ms_sum: number;
}

export interface MatchBundle {
  match: MatchRow;
  players: MatchPlayerRow[];
}

/** 终局落库：一局只有 1 行 matches + 1~2 行 match_players + 计数，全在一次 batch 里 */
export async function insertMatch(env: Env, bundle: MatchBundle): Promise<boolean> {
  const db = dbFor(env, bundle.match.game_id);
  const m = bundle.match;
  const stmts: D1PreparedStatement[] = [
    db.prepare(
      `INSERT OR IGNORE INTO matches
         (id, game_id, mode, track, seed, ruleset_ver, status, ended_reason, score, result,
          moves_count, duration_ms, final_hash, ai_run_id, indexable, started_at, ended_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      m.id, m.game_id, m.mode, m.track, m.seed, m.ruleset_ver, m.status, m.ended_reason, m.score, m.result,
      m.moves_count, m.duration_ms, m.final_hash, m.ai_run_id, m.indexable, m.started_at, m.ended_at,
    ),
  ];
  for (const p of bundle.players) {
    stmts.push(
      db.prepare(
        `INSERT OR IGNORE INTO match_players
           (match_id, seat, player_id, is_ai, model_key, score, result,
            ai_calls, ai_illegal_moves, ai_input_tokens, ai_output_tokens, ai_cost_usd, ai_latency_ms_sum)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(
        p.match_id, p.seat, p.player_id, p.is_ai, p.model_key, p.score, p.result,
        p.ai_calls, p.ai_illegal_moves, p.ai_input_tokens, p.ai_output_tokens, p.ai_cost_usd, p.ai_latency_ms_sum,
      ),
    );
  }
  stmts.push(
    db.prepare(
      `INSERT INTO stats (key, value) VALUES (?, 1)
       ON CONFLICT(key) DO UPDATE SET value = value + 1`,
    ).bind(`matches:${m.game_id}:${m.track}`),
    db.prepare(
      `INSERT INTO stats (key, value) VALUES ('matches:total', 1)
       ON CONFLICT(key) DO UPDATE SET value = value + 1`,
    ),
  );
  const results = await db.batch(stmts);
  // 第一条是 INSERT OR IGNORE：没插进去说明这个 matchId 已经结算过
  return (results[0]?.meta?.changes ?? 0) > 0;
}

export async function getMatch(env: Env, matchId: string): Promise<MatchBundle | null> {
  const db = dbFor(env);
  const [mRes, pRes] = await db.batch<MatchRow | MatchPlayerRow>([
    db.prepare('SELECT * FROM matches WHERE id = ?').bind(matchId),
    db.prepare('SELECT * FROM match_players WHERE match_id = ? ORDER BY seat').bind(matchId),
  ]);
  const match = (mRes.results?.[0] as MatchRow) ?? null;
  if (!match) return null;
  return { match, players: (pRes.results ?? []) as MatchPlayerRow[] };
}

export async function listRecentMatches(
  env: Env, opts: { gameId: string; track?: Track; cursor?: string; limit?: number },
): Promise<MatchRow[]> {
  const limit = Math.min(opts.limit ?? 20, 100);
  const where = ["game_id = ?", "status = 'finished'"];
  const args: unknown[] = [opts.gameId];
  if (opts.track) { where.push('track = ?'); args.push(opts.track); }
  if (opts.cursor) { where.push('id < ?'); args.push(opts.cursor); }
  args.push(limit);
  const res = await dbFor(env, opts.gameId)
    .prepare(`SELECT * FROM matches WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`)
    .bind(...args)
    .all<MatchRow>();
  return res.results ?? [];
}

export async function listPlayerMatches(
  env: Env, playerId: string, cursor?: string, limit = 20,
): Promise<MatchRow[]> {
  const args: unknown[] = [playerId];
  let cond = '';
  if (cursor) { cond = 'AND mp.match_id < ?'; args.push(cursor); }
  args.push(Math.min(limit, 100));
  const res = await dbFor(env)
    .prepare(
      `SELECT m.* FROM match_players mp
       JOIN matches m ON m.id = mp.match_id
       WHERE mp.player_id = ? ${cond}
       ORDER BY mp.match_id DESC LIMIT ?`,
    )
    .bind(...args)
    .all<MatchRow>();
  return res.results ?? [];
}

export async function flagMatch(env: Env, matchId: string, status: string): Promise<void> {
  await dbFor(env).prepare('UPDATE matches SET status = ?, indexable = 0 WHERE id = ?').bind(status, matchId).run();
}

export async function listIndexableMatches(env: Env, cursor?: string, limit = 500): Promise<MatchRow[]> {
  const args: unknown[] = [];
  let cond = '';
  if (cursor) { cond = 'AND id < ?'; args.push(cursor); }
  args.push(limit);
  const res = await dbFor(env)
    .prepare(`SELECT * FROM matches WHERE indexable = 1 ${cond} ORDER BY id DESC LIMIT ?`)
    .bind(...args)
    .all<MatchRow>();
  return res.results ?? [];
}

// ---------------------------------------------------------------- leaderboard

export interface LeaderboardUpsert {
  gameId: string;
  track: Track;
  windowKey: string;
  playerId: string;
  score: number;
  matchId: string;
  tiebreakMs: number | null;
  result?: 'win' | 'loss' | 'draw' | null;
  rating?: number | null;
}

/**
 * 个人最好成绩 upsert：O(1) 写入，不触发任何扫描。
 * 同分时用时更短的成绩胜出。
 */
export function leaderboardUpsertStmt(db: D1Database, u: LeaderboardUpsert): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO leaderboard
         (game_id, track, window_key, player_id, best_score, best_match, tiebreak_ms,
          plays, wins, draws, losses, rating, updated_at)
       VALUES (?,?,?,?,?,?,?,1,?,?,?,?,?)
       ON CONFLICT(game_id, track, window_key, player_id) DO UPDATE SET
         plays       = plays + 1,
         wins        = wins   + excluded.wins,
         draws       = draws  + excluded.draws,
         losses      = losses + excluded.losses,
         best_match  = CASE WHEN excluded.best_score > best_score
                              OR (excluded.best_score = best_score
                                  AND COALESCE(excluded.tiebreak_ms, 1e18) < COALESCE(tiebreak_ms, 1e18))
                            THEN excluded.best_match ELSE best_match END,
         tiebreak_ms = CASE WHEN excluded.best_score > best_score
                              OR (excluded.best_score = best_score
                                  AND COALESCE(excluded.tiebreak_ms, 1e18) < COALESCE(tiebreak_ms, 1e18))
                            THEN excluded.tiebreak_ms ELSE tiebreak_ms END,
         best_score  = MAX(best_score, excluded.best_score),
         rating      = COALESCE(excluded.rating, rating),
         updated_at  = excluded.updated_at`,
    )
    .bind(
      u.gameId, u.track, u.windowKey, u.playerId, u.score, u.matchId, u.tiebreakMs,
      u.result === 'win' ? 1 : 0, u.result === 'draw' ? 1 : 0, u.result === 'loss' ? 1 : 0,
      u.rating ?? null, Date.now(),
    );
}

export async function getRatings(
  env: Env, gameId: string, track: Track, windowKey: string, playerIds: string[],
): Promise<Map<string, number>> {
  if (!playerIds.length) return new Map();
  const marks = playerIds.map(() => '?').join(',');
  const res = await dbFor(env, gameId)
    .prepare(
      `SELECT player_id, rating FROM leaderboard
       WHERE game_id = ? AND track = ? AND window_key = ? AND player_id IN (${marks})`,
    )
    .bind(gameId, track, windowKey, ...playerIds)
    .all<{ player_id: string; rating: number | null }>();
  return new Map((res.results ?? []).filter((r) => r.rating != null).map((r) => [r.player_id, r.rating as number]));
}

export async function queryLeaderboard(
  env: Env, gameId: string, track: Track, windowKey: string, limit = 100,
): Promise<LeaderboardRow[]> {
  const res = await dbFor(env, gameId)
    .prepare(
      `SELECT l.player_id, l.best_score, l.best_match, l.tiebreak_ms, l.plays, l.rating,
              p.handle, p.display_name, p.avatar_url, p.model_key
       FROM leaderboard l JOIN players p ON p.id = l.player_id
       WHERE l.game_id = ? AND l.track = ? AND l.window_key = ?
       ORDER BY l.best_score DESC, COALESCE(l.tiebreak_ms, 1e18) ASC
       LIMIT ?`,
    )
    .bind(gameId, track, windowKey, limit)
    .all<{
      player_id: string; best_score: number; best_match: string; tiebreak_ms: number | null;
      plays: number; rating: number | null; handle: string; display_name: string;
      avatar_url: string | null; model_key: string | null;
    }>();
  return (res.results ?? []).map((r, i) => ({
    rank: i + 1,
    playerId: r.player_id,
    handle: r.handle,
    displayName: r.display_name,
    avatarUrl: r.avatar_url,
    modelKey: r.model_key,
    bestScore: r.best_score,
    bestMatch: r.best_match,
    tiebreakMs: r.tiebreak_ms,
    plays: r.plays,
    rating: r.rating,
  }));
}

export async function getPersonalBest(
  env: Env, gameId: string, track: Track, windowKey: string, playerId: string,
): Promise<{ bestScore: number; bestMatch: string; plays: number } | null> {
  const row = await dbFor(env, gameId)
    .prepare(
      `SELECT best_score, best_match, plays FROM leaderboard
       WHERE game_id = ? AND track = ? AND window_key = ? AND player_id = ?`,
    )
    .bind(gameId, track, windowKey, playerId)
    .first<{ best_score: number; best_match: string; plays: number }>();
  return row ? { bestScore: row.best_score, bestMatch: row.best_match, plays: row.plays } : null;
}

/** 榜内精确名次；不在榜内返回 null（不做 COUNT(*) 全表扫） */
export async function rankWithin(
  env: Env, gameId: string, track: Track, windowKey: string, score: number, limit = 100,
): Promise<number | null> {
  const res = await dbFor(env, gameId)
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT best_score FROM leaderboard
         WHERE game_id = ? AND track = ? AND window_key = ? AND best_score > ?
         ORDER BY best_score DESC LIMIT ?
       )`,
    )
    .bind(gameId, track, windowKey, score, limit)
    .first<{ n: number }>();
  const above = res?.n ?? 0;
  return above >= limit ? null : above + 1;
}

export async function readSnapshot(
  env: Env, gameId: string, track: Track, windowKey: string,
): Promise<{ payload: string; updatedAt: number } | null> {
  const row = await dbFor(env, gameId)
    .prepare('SELECT payload, updated_at FROM leaderboard_snapshot WHERE game_id = ? AND track = ? AND window_key = ?')
    .bind(gameId, track, windowKey)
    .first<{ payload: string; updated_at: number }>();
  return row ? { payload: row.payload, updatedAt: row.updated_at } : null;
}

export async function writeSnapshot(
  env: Env, gameId: string, track: Track, windowKey: string, payload: string,
): Promise<void> {
  await dbFor(env, gameId)
    .prepare(
      `INSERT INTO leaderboard_snapshot (game_id, track, window_key, payload, updated_at)
       VALUES (?,?,?,?,?)
       ON CONFLICT(game_id, track, window_key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
    )
    .bind(gameId, track, windowKey, payload, Date.now())
    .run();
}

// ---------------------------------------------------------------- models

export interface ModelRow {
  key: string;
  display_name: string;
  vendor: string;
  context_length: number | null;
  price_in: number | null;
  price_out: number | null;
  supports_schema: number;
  supports_reasoning: number;
  enabled: number;
  max_game_plies: number | null;
  pinned_provider: string | null;
  sort_order: number;
  synced_at: number;
}

export async function listModels(env: Env, onlyEnabled = true): Promise<ModelRow[]> {
  const sql = onlyEnabled
    ? 'SELECT * FROM ai_models WHERE enabled = 1 ORDER BY sort_order, key'
    : 'SELECT * FROM ai_models ORDER BY sort_order, key';
  const res = await dbFor(env).prepare(sql).all<ModelRow>();
  return res.results ?? [];
}

export async function getModel(env: Env, key: string): Promise<ModelRow | null> {
  return dbFor(env).prepare('SELECT * FROM ai_models WHERE key = ?').bind(key).first<ModelRow>();
}

/** Cron 同步：只覆盖从 OpenRouter 拿到的客观字段，保留运营开关 */
export async function syncModels(
  env: Env,
  models: { key: string; displayName: string; vendor: string; contextLength: number | null;
            priceIn: number | null; priceOut: number | null; supportsSchema: boolean; supportsReasoning: boolean }[],
): Promise<number> {
  const db = dbFor(env);
  const now = Date.now();
  const stmts = models.map((m) =>
    db.prepare(
      `INSERT INTO ai_models
         (key, display_name, vendor, context_length, price_in, price_out,
          supports_schema, supports_reasoning, enabled, sort_order, synced_at)
       VALUES (?,?,?,?,?,?,?,?,0,100,?)
       ON CONFLICT(key) DO UPDATE SET
         display_name = excluded.display_name,
         vendor = excluded.vendor,
         context_length = excluded.context_length,
         price_in = excluded.price_in,
         price_out = excluded.price_out,
         supports_schema = excluded.supports_schema,
         supports_reasoning = excluded.supports_reasoning,
         synced_at = excluded.synced_at`,
    ).bind(
      m.key, m.displayName, m.vendor, m.contextLength, m.priceIn, m.priceOut,
      m.supportsSchema ? 1 : 0, m.supportsReasoning ? 1 : 0, now,
    ),
  );
  // D1 的 batch 有大小上限，分批提交
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
  return stmts.length;
}

export async function updateModelFlags(
  env: Env, key: string, patch: { enabled?: boolean; maxGamePlies?: number | null; pinnedProvider?: string | null; sortOrder?: number },
): Promise<void> {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (patch.enabled !== undefined) { sets.push('enabled = ?'); args.push(patch.enabled ? 1 : 0); }
  if (patch.maxGamePlies !== undefined) { sets.push('max_game_plies = ?'); args.push(patch.maxGamePlies); }
  if (patch.pinnedProvider !== undefined) { sets.push('pinned_provider = ?'); args.push(patch.pinnedProvider); }
  if (patch.sortOrder !== undefined) { sets.push('sort_order = ?'); args.push(patch.sortOrder); }
  if (!sets.length) return;
  args.push(key);
  await dbFor(env).prepare(`UPDATE ai_models SET ${sets.join(', ')} WHERE key = ?`).bind(...args).run();
}

// ---------------------------------------------------------------- ai runs

export interface AiRunRow {
  id: string;
  player_id: string;
  game_id: string;
  model_key: string;
  opponent_key: string | null;
  status: string;
  plies: number;
  cost_usd: number;
  match_id: string | null;
  error: string | null;
  created_at: number;
  ended_at: number | null;
}

export async function insertAiRun(env: Env, run: Omit<AiRunRow, 'ended_at'>): Promise<void> {
  await dbFor(env)
    .prepare(
      `INSERT INTO ai_runs (id, player_id, game_id, model_key, opponent_key, status, plies, cost_usd, match_id, error, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      run.id, run.player_id, run.game_id, run.model_key, run.opponent_key,
      run.status, run.plies, run.cost_usd, run.match_id, run.error, run.created_at,
    )
    .run();
}

export async function updateAiRun(
  env: Env, id: string,
  patch: { status?: string; plies?: number; costUsd?: number; matchId?: string | null; error?: string | null; endedAt?: number },
): Promise<void> {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (patch.status !== undefined) { sets.push('status = ?'); args.push(patch.status); }
  if (patch.plies !== undefined) { sets.push('plies = ?'); args.push(patch.plies); }
  if (patch.costUsd !== undefined) { sets.push('cost_usd = ?'); args.push(patch.costUsd); }
  if (patch.matchId !== undefined) { sets.push('match_id = ?'); args.push(patch.matchId); }
  if (patch.error !== undefined) { sets.push('error = ?'); args.push(patch.error); }
  if (patch.endedAt !== undefined) { sets.push('ended_at = ?'); args.push(patch.endedAt); }
  if (!sets.length) return;
  args.push(id);
  await dbFor(env).prepare(`UPDATE ai_runs SET ${sets.join(', ')} WHERE id = ?`).bind(...args).run();
}

export async function getAiRun(env: Env, id: string): Promise<AiRunRow | null> {
  return dbFor(env).prepare('SELECT * FROM ai_runs WHERE id = ?').bind(id).first<AiRunRow>();
}

export async function listAiRuns(env: Env, playerId: string, cursor?: string, limit = 20): Promise<AiRunRow[]> {
  const args: unknown[] = [playerId];
  let cond = '';
  if (cursor) { cond = 'AND id < ?'; args.push(cursor); }
  args.push(Math.min(limit, 100));
  const res = await dbFor(env)
    .prepare(`SELECT * FROM ai_runs WHERE player_id = ? ${cond} ORDER BY id DESC LIMIT ?`)
    .bind(...args)
    .all<AiRunRow>();
  return res.results ?? [];
}

// ---------------------------------------------------------------- stats

export async function readStats(env: Env, keys: string[]): Promise<Map<string, number>> {
  if (!keys.length) return new Map();
  const marks = keys.map(() => '?').join(',');
  const res = await dbFor(env)
    .prepare(`SELECT key, value FROM stats WHERE key IN (${marks})`)
    .bind(...keys)
    .all<{ key: string; value: number }>();
  return new Map((res.results ?? []).map((r) => [r.key, r.value]));
}

/**
 * 批量落库：把多局的写入合成尽量少的往返，削平 D1 的写入峰值。
 * 返回值与入参一一对应，true 表示这一局是新插入的（false 说明 Queue 重投了）。
 */
export async function insertMatchesBulk(env: Env, bundles: MatchBundle[]): Promise<boolean[]> {
  if (!bundles.length) return [];
  const db = dbFor(env, bundles[0].match.game_id);
  const stmts: D1PreparedStatement[] = [];
  const matchStmtIndex: number[] = [];

  for (const b of bundles) {
    const m = b.match;
    matchStmtIndex.push(stmts.length);
    stmts.push(
      db.prepare(
        `INSERT OR IGNORE INTO matches
           (id, game_id, mode, track, seed, ruleset_ver, status, ended_reason, score, result,
            moves_count, duration_ms, final_hash, ai_run_id, indexable, started_at, ended_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(
        m.id, m.game_id, m.mode, m.track, m.seed, m.ruleset_ver, m.status, m.ended_reason, m.score, m.result,
        m.moves_count, m.duration_ms, m.final_hash, m.ai_run_id, m.indexable, m.started_at, m.ended_at,
      ),
    );
    for (const p of b.players) {
      stmts.push(
        db.prepare(
          `INSERT OR IGNORE INTO match_players
             (match_id, seat, player_id, is_ai, model_key, score, result,
              ai_calls, ai_illegal_moves, ai_input_tokens, ai_output_tokens, ai_cost_usd, ai_latency_ms_sum)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).bind(
          p.match_id, p.seat, p.player_id, p.is_ai, p.model_key, p.score, p.result,
          p.ai_calls, p.ai_illegal_moves, p.ai_input_tokens, p.ai_output_tokens, p.ai_cost_usd, p.ai_latency_ms_sum,
        ),
      );
    }
    stmts.push(
      db.prepare(
        `INSERT INTO stats (key, value) VALUES (?, 1) ON CONFLICT(key) DO UPDATE SET value = value + 1`,
      ).bind(`matches:${m.game_id}:${m.track}`),
    );
  }

  const results = await db.batch(stmts);
  return matchStmtIndex.map((i) => (results[i]?.meta?.changes ?? 0) > 0);
}

export interface AiMatchListRow extends MatchRow {
  model_key: string | null;
  display_name: string | null;
  handle: string | null;
}

/** AI 录像列表：一次 join 拿到模型名，避免逐行再查一次 */
export async function listAiMatches(
  env: Env, gameId: string, cursor?: string, limit = 30,
): Promise<AiMatchListRow[]> {
  const args: unknown[] = [gameId];
  let cond = '';
  if (cursor) { cond = 'AND m.id < ?'; args.push(cursor); }
  args.push(Math.min(limit, 100));
  const res = await dbFor(env, gameId)
    .prepare(
      `SELECT m.*, mp.model_key, p.display_name, p.handle
       FROM matches m
       LEFT JOIN match_players mp ON mp.match_id = m.id AND mp.seat = 0
       LEFT JOIN players p ON p.id = mp.player_id
       WHERE m.game_id = ? AND m.track = 'ai' AND m.status = 'finished' ${cond}
       ORDER BY m.id DESC LIMIT ?`,
    )
    .bind(...args)
    .all<AiMatchListRow>();
  return res.results ?? [];
}

export interface ModelStatRow {
  model_key: string;
  games: number;
  wins: number;
  calls: number;
  illegal: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  score_sum: number;
}

/**
 * 模型横评的聚合。
 *
 * 这是全站唯一一个会扫描 match_players 的查询，所以它**只在 Cron 里跑**
 * 并把结果缓存进 KV，永远不在用户请求的热路径上执行。
 */
export async function modelStats(env: Env): Promise<ModelStatRow[]> {
  const res = await dbFor(env)
    .prepare(
      `SELECT mp.model_key,
              COUNT(*)                          AS games,
              SUM(CASE WHEN mp.result='win' THEN 1 ELSE 0 END) AS wins,
              SUM(mp.ai_calls)                  AS calls,
              SUM(mp.ai_illegal_moves)          AS illegal,
              SUM(mp.ai_input_tokens)           AS input_tokens,
              SUM(mp.ai_output_tokens)          AS output_tokens,
              SUM(mp.ai_cost_usd)               AS cost_usd,
              SUM(COALESCE(mp.score,0))         AS score_sum
       FROM match_players mp
       JOIN matches m ON m.id = mp.match_id AND m.status = 'finished'
       WHERE mp.model_key IS NOT NULL
       GROUP BY mp.model_key
       ORDER BY games DESC`,
    )
    .all<ModelStatRow>();
  return res.results ?? [];
}

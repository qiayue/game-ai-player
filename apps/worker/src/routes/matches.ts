import { Hono } from 'hono';
import type { Env, Vars } from '../env.js';
import type { FinishMatchRequest, FinishMatchResponse, StartMatchResponse, StepRequest, StepResponse } from '@gap/shared';
import { getGame, validate, hashState, type Move } from '@gap/games';
import { signJwt, verifyJwt } from '../util/jwt.js';
import { ulid, randomSeed } from '../util/ids.js';
import { badRequest, notFound, ApiError, checkOrigin, param } from '../util/http.js';
import * as repo from '../repo.js';
import * as storage from '../storage.js';
import { applyMatchToLeaderboards } from '../leaderboard.js';

export const matches = new Hono<{ Bindings: Env; Variables: Vars }>();

const TICKET_TTL = 60 * 60 * 12;
/** 人类每步最少要用掉的毫秒数，低于这个视为脚本代打 */
const MIN_MS_PER_MOVE = 35;

interface Ticket {
  mid: string;
  g: string;
  seed: string;
  st: number;
}

/**
 * 开一局。
 *
 * 注意这里**不写数据库**：对局票据是一个签名的 JWT，终局时凭它落库。
 * 半途放弃的对局因此在 D1 里不留任何痕迹。
 */
matches.post('/', async (c) => {
  checkOrigin(c, c.env.SITE_URL);
  const body = await c.req.json<{ gameId?: string }>().catch(() => ({} as { gameId?: string }));
  if (!body.gameId) throw badRequest('缺少 gameId');
  let def;
  try {
    def = getGame(body.gameId);
  } catch {
    throw notFound(`没有这个游戏：${body.gameId}`);
  }

  const matchId = ulid();
  const seed = randomSeed();
  const startedAt = Date.now();
  const ticket = await signJwt({ mid: matchId, g: def.id, seed, st: startedAt }, c.env.SESSION_SECRET, TICKET_TTL);
  const state = def.init(seed);

  const res: StartMatchResponse & { ticket: string } = {
    matchId,
    seed: def.hiddenInfo ? '' : seed, // 隐藏信息游戏不把 seed 给客户端，否则能反推出雷区
    startedAt,
    stepwise: def.hiddenInfo,
    state: def.view(state, 0),
    legalMoves: def.legalMoves(state) as Move[],
    ticket,
  };
  return c.json(res);
});

/**
 * 信息不完全的游戏（扫雷、记忆翻牌）逐步提交。
 * 服务端每次从 seed 重放，因此完全无状态：不需要 DO，也不写库。
 */
matches.post('/:id/step', async (c) => {
  checkOrigin(c, c.env.SITE_URL);
  const { ticket, moves } = await c.req.json<StepRequest & { ticket?: string }>();
  const t = await readTicket(c.env, ticket, param(c, 'id'));
  const def = getGame(t.g);
  if (!def.hiddenInfo) throw badRequest('这个游戏应当在终局时一次性提交');
  if (!Array.isArray(moves)) throw badRequest('moves 必须是数组');
  if (moves.length > def.maxPlies) throw badRequest('步数超出上限');

  const result = validate(def, t.seed, moves as Move[]);
  if (!result.ok) throw new ApiError(400, 'invalid_replay', `第 ${result.failedAt + 1} 步不合法：${result.error}`);

  const res: StepResponse = {
    state: def.view(result.state, 0),
    legalMoves: def.legalMoves(result.state) as Move[],
    terminal: def.isTerminal(result.state),
  };
  return c.json(res);
});

/** 终局提交：服务端用同一份内核重放校验，再落库 */
matches.post('/:id/finish', async (c) => {
  checkOrigin(c, c.env.SITE_URL);
  const body = await c.req.json<FinishMatchRequest & { ticket?: string }>();
  const t = await readTicket(c.env, body.ticket, param(c, 'id'));
  return c.json(await finishOne(c.env, c.get('user')?.id ?? null, t, body));
});

/** 登录后一次性认领匿名期间打完的对局 */
matches.post('/claim', async (c) => {
  checkOrigin(c, c.env.SITE_URL);
  const user = c.get('user');
  if (!user) throw badRequest('请先登录');
  const body = await c.req.json<{ pending: (FinishMatchRequest & { ticket: string })[] }>();
  const pending = (body.pending ?? []).slice(0, 20);
  const claimed: FinishMatchResponse[] = [];
  for (const item of pending) {
    try {
      const t = await readTicket(c.env, item.ticket, null);
      claimed.push(await finishOne(c.env, user.id, t, item));
    } catch {
      // 票据过期或重复认领，跳过即可
    }
  }
  return c.json({ claimed });
});

async function readTicket(env: Env, ticket: string | undefined, matchId: string | null): Promise<Ticket> {
  if (!ticket) throw badRequest('缺少对局票据');
  const t = await verifyJwt<Ticket>(ticket, env.SESSION_SECRET);
  if (!t) throw badRequest('对局票据无效或已过期');
  if (matchId && t.mid !== matchId) throw badRequest('对局票据与对局不匹配');
  return t;
}

async function finishOne(
  env: Env, playerId: string | null, t: Ticket, body: FinishMatchRequest,
): Promise<FinishMatchResponse> {
  const def = getGame(t.g);
  const moves = (body.moves ?? []) as Move[];
  if (!Array.isArray(moves)) throw badRequest('moves 必须是数组');
  if (moves.length > def.maxPlies) throw badRequest('步数超出上限');

  const result = validate(def, t.seed, moves);
  if (!result.ok) throw new ApiError(400, 'invalid_replay', `第 ${result.failedAt + 1} 步不合法：${result.error}`);

  const endedAt = Date.now();
  const durationMs = Math.max(0, Math.min(body.durationMs ?? endedAt - t.st, endedAt - t.st + 5000));
  const score = def.scoreOf(result.state, 0);
  const finalHash = hashState(result.state);

  // 完全信息的游戏客户端能自己算哈希，对不上说明客户端被改过或版本不一致
  if (!def.hiddenInfo && body.finalHash && body.finalHash !== finalHash) {
    throw new ApiError(409, 'hash_mismatch', '客户端与服务端的终局状态不一致，可能是版本不同，请刷新页面');
  }

  const flagged = suspicious(def, moves.length, durationMs, body.stepMs ?? []);

  // 未登录：先把成绩算出来给用户看，但不落库。前端存好票据，登录后调 /claim 补上。
  if (!playerId) {
    return {
      matchId: t.mid, score, status: result.state.status, moves: moves.length,
      rank: null, personalBest: false, replayUrl: `/replay/${t.mid}`, flagged,
    };
  }

  const records: storage.MoveRecord[] = [];
  {
    let s = def.init(t.seed);
    for (let i = 0; i < moves.length; i++) {
      const seat = def.players === 1 ? 0 : s.turn;
      s = def.reduce(s, moves[i], t.seed);
      records.push({ ply: i, seat, move: moves[i], ms: body.stepMs?.[i] ?? 0, hash: hashState(s) });
    }
  }
  await storage.putMoves(env, t.mid, records);
  await storage.putReplay(env, {
    matchId: t.mid, gameId: def.id, track: 'human', seed: t.seed, score,
    status: result.state.status, endedReason: def.isTerminal(result.state) ? 'terminal' : 'abandoned',
    movesCount: moves.length, durationMs, startedAt: t.st, endedAt,
    players: [{ seat: 0, playerId, handle: '', displayName: '', isAi: false, modelKey: null, result: null, score }],
    moves, stepMs: body.stepMs ?? [],
  });

  const inserted = await repo.insertMatch(env, {
    match: {
      id: t.mid, game_id: def.id, mode: def.players === 1 ? 'single' : 'versus', track: 'human',
      seed: t.seed, ruleset_ver: def.rulesetVersion, status: flagged ? 'flagged' : 'finished',
      ended_reason: def.isTerminal(result.state) ? 'terminal' : 'abandoned',
      score, result: null, moves_count: moves.length, duration_ms: durationMs,
      final_hash: finalHash, ai_run_id: null, indexable: 0, started_at: t.st, ended_at: endedAt,
    },
    players: [{
      match_id: t.mid, seat: 0, player_id: playerId, is_ai: 0, model_key: null, score, result: null,
      ai_calls: 0, ai_illegal_moves: 0, ai_input_tokens: 0, ai_output_tokens: 0, ai_cost_usd: 0, ai_latency_ms_sum: 0,
    }],
  });

  if (!inserted) {
    // 重复提交同一个 matchId：幂等返回，不重复计分
    return {
      matchId: t.mid, score, status: result.state.status, moves: moves.length,
      rank: null, personalBest: false, replayUrl: `/replay/${t.mid}`, flagged,
    };
  }

  // 双人游戏由一个人自己两边下（同屏轮流）只能算练习，不产生有意义的评分，
  // 所以记录对局和回放但不进排行榜。双人游戏的排名来自 AI 对打或将来的真人对战。
  const rated = !flagged && def.players === 1;

  let rank: number | null = null;
  let personalBest = false;
  if (rated) {
    const before = await repo.getPersonalBest(env, def.id, 'human', 'all', playerId);
    personalBest = !before || score > before.bestScore;
    await applyMatchToLeaderboards(env, {
      gameId: def.id, track: 'human', matchId: t.mid, endedAt, durationMs,
      seats: [{ playerId, seat: 0, score, result: null }],
    });
    rank = await repo.rankWithin(env, def.id, 'human', 'all', score);
  }

  return {
    matchId: t.mid, score, status: result.state.status, moves: moves.length,
    rank, personalBest, replayUrl: `/replay/${t.mid}`, flagged,
  };
}

/**
 * 轻量反作弊。目标不是绝对防住，而是让作弊的成本高于收益：
 * 伪造成绩必须真的算出一条合法的高分走法序列，而且还要装得像人在操作。
 */
export function suspicious(
  def: ReturnType<typeof getGame>, moveCount: number, durationMs: number, stepMs: number[],
): boolean {
  if (moveCount < 10) return false;
  const minPerMove = def.ui.autoTickMs ? def.ui.autoTickMs * 0.8 : MIN_MS_PER_MOVE;
  if (durationMs < moveCount * minPerMove) return true;

  const samples = stepMs.filter((n) => Number.isFinite(n) && n >= 0);
  // 自动推进的游戏（贪吃蛇）本来就是匀速的，节奏检测对它没有意义
  if (!def.ui.autoTickMs && samples.length >= 30) {
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length;
    const cv = mean > 0 ? Math.sqrt(variance) / mean : 0;
    // 人类的操作间隔天然抖动很大；变异系数过小说明是定时器在点
    if (cv < 0.12) return true;
  }
  return false;
}

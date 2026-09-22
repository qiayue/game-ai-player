import { Hono } from 'hono';
import type { Env, Vars } from '../env.js';
import type { AiRunStatus, CreateAiRunRequest } from '@gap/shared';
import { getGame } from '@gap/games';
import { requireUser } from '../auth.js';
import { ulid, randomSeed } from '../util/ids.js';
import { ApiError, badRequest, notFound, forbidden, checkOrigin, param } from '../util/http.js';
import * as repo from '../repo.js';
import * as storage from '../storage.js';
import { estimateCost, ESTIMATED_PLIES } from '../ai/estimate.js';

export const airuns = new Hono<{ Bindings: Env; Variables: Vars }>();

/** 手动触发一次 AI 录制。立即返回 runId，实际对局在 Durable Object 里后台跑。 */
airuns.post('/', async (c) => {
  checkOrigin(c, c.env.SITE_URL);
  const user = requireUser(c);
  const body = await c.req.json<CreateAiRunRequest>().catch(() => ({}) as CreateAiRunRequest);
  if (!body.gameId || !body.modelKey) throw badRequest('缺少 gameId 或 modelKey');

  let def;
  try {
    def = getGame(body.gameId);
  } catch {
    throw notFound(`没有这个游戏：${body.gameId}`);
  }

  const model = await repo.getModel(c.env, body.modelKey);
  if (!model || !model.enabled) throw badRequest('这个模型当前不可用');

  const opponent = body.opponentKey ? await repo.getModel(c.env, body.opponentKey) : null;
  if (body.opponentKey && (!opponent || !opponent.enabled)) throw badRequest('对手模型当前不可用');
  if (def.players === 1 && body.opponentKey) throw badRequest('单人游戏不需要对手模型');

  // 贵模型只放开短局
  const plyCap = Math.min(
    def.maxPlies,
    model.max_game_plies ?? def.maxPlies,
    opponent?.max_game_plies ?? def.maxPlies,
  );
  if (ESTIMATED_PLIES[def.id] > plyCap * 1.5 && !user.isAdmin) {
    throw forbidden(`${model.display_name} 目前只开放给步数较少的游戏`);
  }

  // 配额与全站预算
  const dailyLimit = Number(c.env.USER_DAILY_RUNS || '10');
  const used = await storage.readCounter(c.env, storage.userRunsKey(user.id));
  if (!user.isAdmin && used >= dailyLimit) {
    throw new ApiError(429, 'quota_exceeded', `今天的 AI 对局次数已经用完（${dailyLimit} 次），明天再来`);
  }
  const budget = Number(c.env.DAILY_BUDGET_USD || '5');
  const spent = await storage.todayCostUsd(c.env);
  if (!user.isAdmin && spent >= budget) {
    throw new ApiError(429, 'budget_exceeded', '今天全站的 AI 预算已经用完了，明天再来');
  }

  const estimate = estimateCost(def, model, opponent);
  const maxCostUsd = Math.max(0.02, Math.min(estimate * 3, budget - spent));

  const runId = ulid();
  const matchId = ulid();
  const seed = randomSeed();

  const aiPlayer = await repo.ensureAiPlayer(c.env, model.key, model.display_name);
  const seats = [{
    modelKey: model.key,
    displayName: model.display_name,
    playerId: aiPlayer.id,
    maxTokens: def.aiMaxTokens,
    supportsSchema: model.supports_schema === 1,
    pinnedProvider: model.pinned_provider,
  }];
  if (def.players === 2) {
    const opp = opponent ?? model;
    const oppPlayer = opponent ? await repo.ensureAiPlayer(c.env, opp.key, opp.display_name) : aiPlayer;
    seats.push({
      modelKey: opp.key,
      displayName: opp.display_name,
      playerId: oppPlayer.id,
      maxTokens: def.aiMaxTokens,
      supportsSchema: opp.supports_schema === 1,
      pinnedProvider: opp.pinned_provider,
    });
  }

  await repo.insertAiRun(c.env, {
    id: runId, player_id: user.id, game_id: def.id, model_key: model.key,
    opponent_key: opponent?.key ?? null, status: 'running', plies: 0, cost_usd: 0,
    match_id: null, error: null, created_at: Date.now(),
  });
  await storage.bumpCounter(c.env, storage.userRunsKey(user.id));

  const stub = c.env.AI_RUN.get(c.env.AI_RUN.idFromName(runId));
  await stub.fetch('https://do/start', {
    method: 'POST',
    body: JSON.stringify({ runId, matchId, gameId: def.id, seed, ownerId: user.id, seats, maxPlies: plyCap, maxCostUsd }),
  });

  return c.json({ runId, matchId, estimateUsd: estimate, maxCostUsd });
});

/** 进度轮询。打的是 Durable Object 内存，不碰 D1。 */
airuns.get('/:id', async (c) => {
  const runId = param(c, 'id');
  const stub = c.env.AI_RUN.get(c.env.AI_RUN.idFromName(runId));
  const res = await stub.fetch('https://do/status');
  const status = (await res.json()) as AiRunStatus;
  if (!status.runId) {
    const row = await repo.getAiRun(c.env, runId);
    if (!row) throw notFound('没有这个录制任务');
    return c.json({
      runId: row.id, status: row.status as AiRunStatus['status'], gameId: row.game_id, modelKey: row.model_key,
      ply: row.plies, score: 0, costUsd: row.cost_usd, state: null, lastMoveText: null,
      lastThought: null, illegalMoves: 0, matchId: row.match_id, error: row.error,
      updatedAt: row.ended_at ?? row.created_at,
    } satisfies AiRunStatus);
  }
  return c.json(status, { headers: { 'Cache-Control': 'no-store' } });
});

airuns.post('/:id/abort', async (c) => {
  checkOrigin(c, c.env.SITE_URL);
  const user = requireUser(c);
  const runId = param(c, 'id');
  const row = await repo.getAiRun(c.env, runId);
  if (!row) throw notFound('没有这个录制任务');
  if (row.player_id !== user.id && !user.isAdmin) throw forbidden('只能中止自己发起的录制');

  const stub = c.env.AI_RUN.get(c.env.AI_RUN.idFromName(runId));
  await stub.fetch('https://do/abort', { method: 'POST' });
  return c.json({ ok: true });
});

airuns.get('/', async (c) => {
  const user = requireUser(c);
  const cursor = c.req.query('cursor') ?? undefined;
  const rows = await repo.listAiRuns(c.env, user.id, cursor);
  return c.json({
    runs: rows.map((r) => ({
      runId: r.id, gameId: r.game_id, modelKey: r.model_key, status: r.status,
      plies: r.plies, costUsd: r.cost_usd, matchId: r.match_id, createdAt: r.created_at,
    })),
    nextCursor: rows.length ? rows[rows.length - 1].id : null,
  });
});

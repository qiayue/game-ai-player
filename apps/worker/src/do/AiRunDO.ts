/**
 * 一次 AI 录制任务 = 一个 Durable Object 实例。
 *
 * 为什么用 DO + alarm 自驱循环而不是 Workflows：一局 2048 有 800+ 步，
 * 每步一次模型调用。DO 自己控制循环没有步数上限，状态在本地读写，
 * 进程被回收也能从断点续跑。
 *
 * 每次 alarm 只跑一步就返回，把长任务切成很多个短请求，
 * 规避单次调用的时长限制。
 */
import type { Env } from '../env.js';
import type { AiRunStatus, AiStepRecord, ReplayPackage } from '@gap/shared';
import { getGame, hashState, type GameState, type Move } from '@gap/games';
import { buildPrompt, buildRetryPrompt, splitResponse, MOVE_SCHEMA } from '../ai/prompt.js';
import { chat, OpenRouterError } from '../ai/openrouter.js';
import * as storage from '../storage.js';

const MAX_ILLEGAL_ATTEMPTS = 3;
const MAX_CONSECUTIVE_FAILURES = 3;
const STALL_MS = 5 * 60_000;
const MOVES_PER_CHUNK = 200;

interface SeatConfig {
  modelKey: string;
  displayName: string;
  playerId: string;
  maxTokens: number;
  supportsSchema: boolean;
  pinnedProvider: string | null;
}

interface SeatStats {
  calls: number;
  illegal: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMsSum: number;
}

interface RunRecord {
  runId: string;
  matchId: string;
  gameId: string;
  seed: string;
  ownerId: string;
  seats: SeatConfig[];
  stats: SeatStats[];
  status: AiRunStatus['status'];
  startedAt: number;
  endedAt: number | null;
  plies: number;
  costUsd: number;
  maxPlies: number;
  maxCostUsd: number;
  lastThought: string | null;
  lastMoveText: string | null;
  lastProgressAt: number;
  consecutiveFailures: number;
  endedReason: string | null;
  error: string | null;
}

const emptyStats = (): SeatStats => ({ calls: 0, illegal: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMsSum: 0 });

export class AiRunDO implements DurableObject {
  constructor(private readonly ctx: DurableObjectState, private readonly env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case '/start':
          return Response.json(await this.start((await request.json()) as StartPayload));
        case '/status':
          return Response.json(await this.status());
        case '/abort':
          return Response.json(await this.abort());
        default:
          return new Response('not found', { status: 404 });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return Response.json({ error: { code: 'do_error', message } }, { status: 500 });
    }
  }

  // ------------------------------------------------------------ lifecycle

  async start(payload: StartPayload): Promise<{ ok: true; runId: string }> {
    const existing = await this.ctx.storage.get<RunRecord>('run');
    if (existing) return { ok: true, runId: existing.runId };

    const def = getGame(payload.gameId);
    const run: RunRecord = {
      runId: payload.runId,
      matchId: payload.matchId,
      gameId: payload.gameId,
      seed: payload.seed,
      ownerId: payload.ownerId,
      seats: payload.seats,
      stats: payload.seats.map(emptyStats),
      status: 'running',
      startedAt: Date.now(),
      endedAt: null,
      plies: 0,
      costUsd: 0,
      maxPlies: Math.min(def.maxPlies, payload.maxPlies ?? def.maxPlies),
      maxCostUsd: payload.maxCostUsd,
      lastThought: null,
      lastMoveText: null,
      lastProgressAt: Date.now(),
      consecutiveFailures: 0,
      endedReason: null,
      error: null,
    };
    const state = def.init(payload.seed);
    await this.ctx.storage.put({ run, state, movesChunks: 0 });
    await this.ctx.storage.setAlarm(Date.now());
    return { ok: true, runId: run.runId };
  }

  async status(): Promise<AiRunStatus> {
    const run = await this.ctx.storage.get<RunRecord>('run');
    if (!run) {
      return {
        runId: '', status: 'queued', gameId: '', modelKey: '', ply: 0, score: 0, costUsd: 0,
        state: null, lastMoveText: null, lastThought: null, illegalMoves: 0,
        matchId: null, error: null, updatedAt: Date.now(),
      };
    }
    const state = await this.ctx.storage.get<GameState>('state');
    const def = getGame(run.gameId);
    return {
      runId: run.runId,
      status: run.status,
      gameId: run.gameId,
      modelKey: run.seats[0].modelKey,
      ply: run.plies,
      score: state?.score ?? 0,
      costUsd: run.costUsd,
      state: state ? def.view(state, state.turn) : null,
      lastMoveText: run.lastMoveText,
      lastThought: run.lastThought,
      illegalMoves: run.stats.reduce((n, s) => n + s.illegal, 0),
      matchId: run.status === 'finished' ? run.matchId : null,
      error: run.error,
      updatedAt: run.lastProgressAt,
    };
  }

  async abort(): Promise<{ ok: true }> {
    const run = await this.ctx.storage.get<RunRecord>('run');
    if (run && run.status === 'running') {
      run.status = 'aborted';
      run.endedReason = 'aborted';
      await this.ctx.storage.put('run', run);
      await this.ctx.storage.deleteAlarm();
      await this.finalize(run);
    }
    return { ok: true };
  }

  // ------------------------------------------------------------ alarm loop

  async alarm(): Promise<void> {
    const run = await this.ctx.storage.get<RunRecord>('run');
    if (!run || run.status !== 'running') return;

    if (Date.now() - run.lastProgressAt > STALL_MS) {
      run.status = 'stalled';
      run.error = '超过 5 分钟没有进展，任务已终止';
      run.endedReason = 'stalled';
      await this.ctx.storage.put('run', run);
      await this.finalize(run);
      return;
    }

    const state = (await this.ctx.storage.get<GameState>('state'))!;
    const def = getGame(run.gameId);

    // 每次 alarm 只推进一步，避免单次调用过长
    const outcome = await this.playOneStep(run, state, def);

    if (outcome.kind === 'failed') {
      run.consecutiveFailures++;
      run.error = outcome.error;
      if (run.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        run.status = 'failed';
        run.endedReason = 'model_error';
        await this.ctx.storage.put('run', run);
        await this.finalize(run);
        return;
      }
      await this.ctx.storage.put('run', run);
      // 指数退避后重试：2s, 4s, 8s
      await this.ctx.storage.setAlarm(Date.now() + 2000 * 2 ** (run.consecutiveFailures - 1));
      return;
    }

    run.consecutiveFailures = 0;
    run.error = null;
    run.lastProgressAt = Date.now();
    await this.ctx.storage.put({ run, state: outcome.state });

    if (outcome.terminal) {
      run.status = 'finished';
      run.endedReason = outcome.endedReason;
      await this.ctx.storage.put('run', run);
      await this.finalize(run, outcome.state);
      return;
    }
    await this.ctx.storage.setAlarm(Date.now() + 100);
  }

  private async playOneStep(
    run: RunRecord, state: GameState, def: ReturnType<typeof getGame>,
  ): Promise<StepOutcome> {
    const seat = def.players === 1 ? 0 : state.turn;
    const cfg = run.seats[Math.min(seat, run.seats.length - 1)];
    const stats = run.stats[Math.min(seat, run.stats.length - 1)];

    const attempts: { response: string; error: string }[] = [];
    let lastError = '';

    for (let attempt = 1; attempt <= MAX_ILLEGAL_ATTEMPTS; attempt++) {
      const built = attempt === 1
        ? buildPrompt(def, state, seat)
        : buildRetryPrompt(def, state, seat, attempt, lastError);

      let result;
      try {
        result = await chat(this.env, {
          model: cfg.modelKey,
          system: built.system,
          user: built.user,
          maxTokens: cfg.maxTokens,
          temperature: 0,
          provider: cfg.pinnedProvider,
          jsonSchema: cfg.supportsSchema ? MOVE_SCHEMA : undefined,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // 调用层面的失败（限流、网络）不算非法走法，交给 alarm 重试
        if (err instanceof OpenRouterError && !err.retryable) {
          return { kind: 'failed', error: message };
        }
        return { kind: 'failed', error: message };
      }

      stats.calls++;
      stats.inputTokens += result.inputTokens;
      stats.outputTokens += result.outputTokens;
      stats.costUsd += result.costUsd;
      stats.latencyMsSum += result.latencyMs;
      run.costUsd += result.costUsd;

      const { thought, moveText } = splitResponse(result.text);
      const move = def.parseMove(moveText, def.view(state, seat)) as Move | null;

      if (move !== null) {
        try {
          const next = def.reduce(state, move, run.seed);
          await this.recordStep(run, {
            ply: state.plies, seat, modelKey: cfg.modelKey, move, moveText: def.moveToText(move),
            prompt: `${built.system}\n\n---\n\n${built.user}`, response: result.text, thought,
            attempts, inputTokens: result.inputTokens, outputTokens: result.outputTokens,
            costUsd: result.costUsd, latencyMs: result.latencyMs,
          }, hashState(next));

          run.plies = next.plies;
          run.lastThought = thought;
          run.lastMoveText = def.moveToText(move);

          const overPly = next.plies >= run.maxPlies;
          const overCost = run.costUsd >= run.maxCostUsd;
          const terminal = def.isTerminal(next) || overPly || overCost;
          return {
            kind: 'moved', state: next, terminal,
            endedReason: def.isTerminal(next) ? 'terminal' : overCost ? 'cost_limit' : overPly ? 'ply_limit' : null,
          };
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
        }
      } else {
        lastError = `could not read a move out of "${moveText.slice(0, 80)}"`;
      }

      stats.illegal++;
      attempts.push({ response: result.text.slice(0, 2000), error: lastError });
    }

    // 三次都不合法：单人游戏就此收工，双人游戏判负
    await this.recordStep(run, {
      ply: state.plies, seat, modelKey: cfg.modelKey, move: null, moveText: null,
      prompt: buildPrompt(def, state, seat).user, response: attempts[attempts.length - 1]?.response ?? '',
      thought: null, attempts, inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0,
    }, hashState(state));
    run.lastMoveText = null;
    run.lastThought = `连续 ${MAX_ILLEGAL_ATTEMPTS} 次给出非法走法：${lastError}`;
    return { kind: 'moved', state, terminal: true, endedReason: 'illegal_move' };
  }

  // ------------------------------------------------------------ 持久化

  private async recordStep(run: RunRecord, rec: AiStepRecord, hash: string): Promise<void> {
    // AI 的 prompt / 回复体积大，直接进 R2，不占 DO storage 也不进 D1
    await storage.putAiStep(this.env, run.matchId, rec);
    // 非法走法只留在 AI 明细里，不进走法序列，否则回放对不上
    if (rec.move === null) return;

    const chunks = (await this.ctx.storage.get<number>('movesChunks')) ?? 0;
    const key = `moves:${Math.max(0, chunks - 1)}`;
    const cur = (await this.ctx.storage.get<storage.MoveRecord[]>(key)) ?? [];
    const entry: storage.MoveRecord = {
      ply: rec.ply, seat: rec.seat, move: rec.move as Move, ms: rec.latencyMs, hash,
    };
    if (chunks === 0 || cur.length >= MOVES_PER_CHUNK) {
      await this.ctx.storage.put({ [`moves:${chunks}`]: [entry], movesChunks: chunks + 1 });
    } else {
      cur.push(entry);
      await this.ctx.storage.put(key, cur);
    }
  }

  private async allMoves(): Promise<storage.MoveRecord[]> {
    const chunks = (await this.ctx.storage.get<number>('movesChunks')) ?? 0;
    const out: storage.MoveRecord[] = [];
    for (let i = 0; i < chunks; i++) {
      const part = await this.ctx.storage.get<storage.MoveRecord[]>(`moves:${i}`);
      if (part) out.push(...part);
    }
    return out;
  }

  /** 终局：写 R2，再把 D1 落库交给 Queue 批量合并 */
  private async finalize(run: RunRecord, finalState?: GameState): Promise<void> {
    if (await this.ctx.storage.get<boolean>('finalized')) return;
    await this.ctx.storage.put('finalized', true);

    const def = getGame(run.gameId);
    const state = finalState ?? (await this.ctx.storage.get<GameState>('state'))!;
    const moves = await this.allMoves();
    const endedAt = Date.now();
    run.endedAt = endedAt;

    await storage.putMoves(this.env, run.matchId, moves);

    const seats = run.seats.map((cfg, i) => ({
      seat: i,
      playerId: cfg.playerId,
      handle: '',
      displayName: cfg.displayName,
      isAi: true,
      modelKey: cfg.modelKey,
      result: resultFor(def, state, i),
      score: def.scoreOf(state, i),
      aiCalls: run.stats[i].calls,
      aiIllegalMoves: run.stats[i].illegal,
      aiCostUsd: run.stats[i].costUsd,
      aiLatencyMsSum: run.stats[i].latencyMsSum,
    }));

    const pkg: ReplayPackage = {
      matchId: run.matchId,
      gameId: run.gameId,
      track: 'ai',
      seed: run.seed,
      score: def.players === 1 ? state.score : 0,
      status: state.status,
      endedReason: run.endedReason,
      movesCount: moves.length,
      durationMs: endedAt - run.startedAt,
      startedAt: run.startedAt,
      endedAt,
      players: seats,
      moves: moves.map((m) => m.move),
      stepMs: moves.map((m) => m.ms),
    };
    await storage.putReplay(this.env, pkg);
    await storage.addCost(this.env, run.costUsd);

    await this.env.FINISH_QUEUE.send({
      kind: 'ai-run-finished',
      runId: run.runId,
      matchId: run.matchId,
      gameId: run.gameId,
      seed: run.seed,
      status: run.status,
      endedReason: run.endedReason,
      error: run.error,
      costUsd: run.costUsd,
      movesCount: moves.length,
      durationMs: endedAt - run.startedAt,
      startedAt: run.startedAt,
      endedAt,
      finalHash: hashState(state),
      score: def.players === 1 ? state.score : 0,
      seats: seats.map((s) => ({
        seat: s.seat, playerId: s.playerId, modelKey: s.modelKey, score: s.score, result: s.result,
        aiCalls: s.aiCalls, aiIllegalMoves: s.aiIllegalMoves,
        aiInputTokens: run.stats[s.seat].inputTokens, aiOutputTokens: run.stats[s.seat].outputTokens,
        aiCostUsd: s.aiCostUsd, aiLatencyMsSum: s.aiLatencyMsSum,
      })),
    });

    await this.ctx.storage.put('run', run);
  }
}

function resultFor(def: ReturnType<typeof getGame>, state: GameState, seat: number): 'win' | 'loss' | 'draw' | null {
  if (def.players === 1) return null;
  const s = def.scoreOf(state, seat);
  return s === 1 ? 'win' : s === 0.5 ? 'draw' : 'loss';
}

type StepOutcome =
  | { kind: 'moved'; state: GameState; terminal: boolean; endedReason: string | null }
  | { kind: 'failed'; error: string };

export interface StartPayload {
  runId: string;
  matchId: string;
  gameId: string;
  seed: string;
  ownerId: string;
  seats: SeatConfig[];
  maxPlies?: number;
  maxCostUsd: number;
}

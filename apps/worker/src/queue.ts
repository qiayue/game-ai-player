/**
 * 终局写入的批量合并。
 *
 * AI 录制跑完后，DO 先把结果写进 R2（用户立刻能看到结算和回放），
 * 再投一条消息到这里，由 consumer 把多局的 D1 写入合成一次 batch。
 * 用户体验和数据库压力因此解耦。
 */
import type { Env } from './env.js';
import type { Track } from '@gap/shared';
import * as repo from './repo.js';
import { applyMatchToLeaderboards, type FinishedSeat } from './leaderboard.js';

export interface AiRunFinishedMessage {
  kind: 'ai-run-finished';
  runId: string;
  matchId: string;
  gameId: string;
  seed: string;
  status: string;
  endedReason: string | null;
  error: string | null;
  costUsd: number;
  movesCount: number;
  durationMs: number;
  startedAt: number;
  endedAt: number;
  finalHash: string;
  score: number;
  seats: {
    seat: number;
    playerId: string;
    modelKey: string;
    score: number;
    result: 'win' | 'loss' | 'draw' | null;
    aiCalls: number;
    aiIllegalMoves: number;
    aiInputTokens: number;
    aiOutputTokens: number;
    aiCostUsd: number;
    aiLatencyMsSum: number;
  }[];
}

type Message = AiRunFinishedMessage;

/** 录制成功且跑到了真正的终局，才值得放出来给搜索引擎收录 */
function indexable(msg: AiRunFinishedMessage): boolean {
  return msg.status === 'finished' && msg.endedReason === 'terminal' && msg.movesCount >= 5;
}

export async function handleQueue(batch: MessageBatch<Message>, env: Env): Promise<void> {
  const runs = batch.messages.filter((m) => m.body?.kind === 'ai-run-finished');
  if (!runs.length) {
    for (const m of batch.messages) m.ack();
    return;
  }

  const bundles: repo.MatchBundle[] = runs.map(({ body: msg }) => ({
    match: {
      id: msg.matchId,
      game_id: msg.gameId,
      mode: msg.seats.length > 1 ? 'versus' : 'single',
      track: 'ai' as Track,
      seed: msg.seed,
      ruleset_ver: 1,
      status: msg.status === 'finished' ? 'finished' : 'invalid',
      ended_reason: msg.endedReason,
      score: msg.score,
      result: msg.seats[0]?.result ?? null,
      moves_count: msg.movesCount,
      duration_ms: msg.durationMs,
      final_hash: msg.finalHash,
      ai_run_id: msg.runId,
      indexable: indexable(msg) ? 1 : 0,
      started_at: msg.startedAt,
      ended_at: msg.endedAt,
    },
    players: msg.seats.map((s) => ({
      match_id: msg.matchId,
      seat: s.seat,
      player_id: s.playerId,
      is_ai: 1,
      model_key: s.modelKey,
      score: s.score,
      result: s.result,
      ai_calls: s.aiCalls,
      ai_illegal_moves: s.aiIllegalMoves,
      ai_input_tokens: s.aiInputTokens,
      ai_output_tokens: s.aiOutputTokens,
      ai_cost_usd: s.aiCostUsd,
      ai_latency_ms_sum: s.aiLatencyMsSum,
    })),
  }));

  let inserted: boolean[];
  try {
    inserted = await repo.insertMatchesBulk(env, bundles);
  } catch (err) {
    console.error('bulk insert failed', err);
    for (const m of runs) m.retry();
    return;
  }

  for (let i = 0; i < runs.length; i++) {
    const msg = runs[i].body;
    try {
      await repo.updateAiRun(env, msg.runId, {
        status: msg.status,
        plies: msg.movesCount,
        costUsd: msg.costUsd,
        matchId: msg.status === 'finished' ? msg.matchId : null,
        error: msg.error,
        endedAt: msg.endedAt,
      });

      // 只有真正新插入的对局才计入排行榜，Queue 重投不会重复计分
      if (inserted[i] && msg.status === 'finished') {
        const seats: FinishedSeat[] = msg.seats.map((s) => ({
          playerId: s.playerId, seat: s.seat, score: s.score, result: s.result,
        }));
        await applyMatchToLeaderboards(env, {
          gameId: msg.gameId, track: 'ai', matchId: msg.matchId,
          endedAt: msg.endedAt, durationMs: msg.durationMs, seats,
        });
      }
      runs[i].ack();
    } catch (err) {
      console.error('post-insert step failed', msg.runId, err);
      runs[i].retry();
    }
  }
}

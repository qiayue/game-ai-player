import type { GameState, Move } from '@gap/games';

export type Track = 'human' | 'ai';
export type LeaderboardWindow = 'all' | 'daily' | 'weekly';

export interface PublicUser {
  id: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  isAdmin: boolean;
}

export interface StartMatchRequest {
  gameId: string;
}

export interface StartMatchResponse {
  matchId: string;
  seed: string;
  startedAt: number;
  /** 信息不完全的游戏必须逐步提交（见 /api/matches/:id/step） */
  stepwise: boolean;
  state: GameState;
  legalMoves: Move[];
}

export interface FinishMatchRequest {
  moves: Move[];
  /** 每一步的耗时（毫秒），用于反作弊的节奏检测 */
  stepMs: number[];
  durationMs: number;
  finalHash?: string;
}

export interface FinishMatchResponse {
  matchId: string;
  score: number;
  status: string;
  moves: number;
  /** 榜内名次；未上榜为 null */
  rank: number | null;
  personalBest: boolean;
  replayUrl: string;
  flagged: boolean;
}

export interface StepRequest {
  /** 到目前为止的全部走法，服务端从 seed 重放，因此无需服务端保存中间态 */
  moves: Move[];
}

export interface StepResponse {
  state: GameState;
  legalMoves: Move[];
  terminal: boolean;
}

export interface ModelInfo {
  key: string;
  displayName: string;
  vendor: string;
  priceIn: number | null;
  priceOut: number | null;
  supportsSchema: boolean;
  maxGamePlies: number | null;
}

export interface ModelListResponse {
  /** 内容指纹，前端据此判断本地缓存是否还新鲜 */
  version: string;
  updatedAt: number;
  models: ModelInfo[];
}

export interface CreateAiRunRequest {
  gameId: string;
  modelKey: string;
  /** 双人游戏的对手模型；留空表示自我对弈 */
  opponentKey?: string;
}

export interface AiRunStatus {
  runId: string;
  status: 'queued' | 'running' | 'finished' | 'failed' | 'aborted' | 'stalled';
  gameId: string;
  modelKey: string;
  ply: number;
  score: number;
  costUsd: number;
  state: GameState | null;
  lastMoveText: string | null;
  lastThought: string | null;
  illegalMoves: number;
  matchId: string | null;
  error: string | null;
  updatedAt: number;
}

export interface ReplayMeta {
  matchId: string;
  gameId: string;
  track: Track;
  seed: string;
  score: number;
  status: string;
  endedReason: string | null;
  movesCount: number;
  durationMs: number;
  startedAt: number;
  endedAt: number;
  players: {
    seat: number;
    playerId: string;
    handle: string;
    displayName: string;
    isAi: boolean;
    modelKey: string | null;
    result: string | null;
    score: number | null;
    aiCalls?: number;
    aiIllegalMoves?: number;
    aiCostUsd?: number;
    aiLatencyMsSum?: number;
  }[];
}

export interface ReplayPackage extends ReplayMeta {
  moves: Move[];
  stepMs: number[];
}

export interface AiStepRecord {
  ply: number;
  seat: number;
  modelKey: string;
  move: Move | null;
  moveText: string | null;
  prompt: string;
  response: string;
  thought: string | null;
  attempts: { response: string; error: string }[];
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
}

export interface LeaderboardRow {
  rank: number;
  playerId: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  modelKey: string | null;
  bestScore: number;
  bestMatch: string;
  tiebreakMs: number | null;
  plays: number;
  rating: number | null;
}

export interface LeaderboardResponse {
  gameId: string;
  track: Track;
  window: string;
  updatedAt: number;
  rows: LeaderboardRow[];
}

export const API_ERRORS = {
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  BAD_REQUEST: 'bad_request',
  QUOTA_EXCEEDED: 'quota_exceeded',
  BUDGET_EXCEEDED: 'budget_exceeded',
  INVALID_REPLAY: 'invalid_replay',
  RATE_LIMITED: 'rate_limited',
} as const;

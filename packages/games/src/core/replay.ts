import type { AnyGameDefinition, GameState, Move } from './types.js';
import { hashState } from './hash.js';

/** 逐步重放，返回每一帧（含初始帧），回放播放器用 */
export function frames(def: AnyGameDefinition, seed: string, moves: Move[]): GameState[] {
  let s = def.init(seed);
  const out = [s];
  for (const m of moves) {
    s = def.reduce(s, m, seed);
    out.push(s);
  }
  return out;
}

/** 重放到终点，非法走法会抛错 */
export function replay(def: AnyGameDefinition, seed: string, moves: Move[]): GameState {
  let s = def.init(seed);
  for (const m of moves) s = def.reduce(s, m, seed);
  return s;
}

export interface ValidationResult {
  ok: boolean;
  state: GameState;
  /** 出错的步序号（0 起），ok 时为 -1 */
  failedAt: number;
  error?: string;
  finalHash: string;
}

/** 服务端校验：重放整局并报告第一处非法走法 */
export function validate(def: AnyGameDefinition, seed: string, moves: Move[]): ValidationResult {
  let s = def.init(seed);
  for (let i = 0; i < moves.length; i++) {
    try {
      s = def.reduce(s, moves[i], seed);
    } catch (err) {
      return {
        ok: false, state: s, failedAt: i,
        error: err instanceof Error ? err.message : String(err),
        finalHash: hashState(s),
      };
    }
    if (s.plies > def.maxPlies) {
      return { ok: false, state: s, failedAt: i, error: 'ply limit exceeded', finalHash: hashState(s) };
    }
  }
  return { ok: true, state: s, failedAt: -1, finalHash: hashState(s) };
}

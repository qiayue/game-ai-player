import type { AnyGameDefinition } from '@gap/games';
import type { ModelRow } from '../repo.js';
import { buildPrompt } from './prompt.js';

/** 各游戏一局的典型步数，用于开跑前给用户看成本预估 */
export const ESTIMATED_PLIES: Record<string, number> = {
  tictactoe: 8,
  connect4: 24,
  othello: 60,
  gomoku: 40,
  fifteen: 180,
  sokoban: 60,
  memory: 26,
  minesweeper: 40,
  sudoku: 50,
  snake: 120,
  '2048': 400,
};

/** 一个 token 大约 3.5 个字符，够用的粗估 */
const CHARS_PER_TOKEN = 3.5;

export function estimateTokens(def: AnyGameDefinition): { input: number; output: number } {
  const state = def.init('estimate');
  const { system, user } = buildPrompt(def, state, 0);
  return {
    input: Math.ceil((system.length + user.length) / CHARS_PER_TOKEN),
    output: Math.ceil(def.aiMaxTokens * 0.5),
  };
}

/** 跑完一整局大约要花多少美元 */
export function estimateCost(def: AnyGameDefinition, model: ModelRow, opponent?: ModelRow | null): number {
  const { input, output } = estimateTokens(def);
  const plies = ESTIMATED_PLIES[def.id] ?? 60;
  const costOf = (m: ModelRow, n: number) =>
    ((m.price_in ?? 0) / 1_000_000) * input * n + ((m.price_out ?? 0) / 1_000_000) * output * n;

  if (def.players === 2) {
    const half = plies / 2;
    return costOf(model, half) + costOf(opponent ?? model, half);
  }
  return costOf(model, plies);
}

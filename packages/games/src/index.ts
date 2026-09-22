export * from './core/types.js';
export * from './core/rng.js';
export * from './core/hash.js';
export * from './core/grid.js';
export * from './core/lines.js';
export * from './core/replay.js';

import type { AnyGameDefinition } from './core/types.js';
import { g2048 } from './games/g2048.js';
import { tictactoe } from './games/tictactoe.js';
import { connect4 } from './games/connect4.js';
import { gomoku } from './games/gomoku.js';
import { othello } from './games/othello.js';
import { snake } from './games/snake.js';
import { minesweeper } from './games/minesweeper.js';
import { sudoku } from './games/sudoku.js';
import { fifteen } from './games/fifteen.js';
import { sokoban } from './games/sokoban.js';
import { memory } from './games/memory.js';

export { g2048, tictactoe, connect4, gomoku, othello, snake, minesweeper, sudoku, fifteen, sokoban, memory };

/** 首页与导航的展示顺序 */
export const GAME_LIST: AnyGameDefinition[] = [
  g2048, tictactoe, connect4, gomoku, othello, snake, minesweeper, sudoku, fifteen, sokoban, memory,
];

export const GAMES: Record<string, AnyGameDefinition> = Object.fromEntries(
  GAME_LIST.map((g) => [g.id, g]),
);

export const GAME_IDS = GAME_LIST.map((g) => g.id);

export function getGame(id: string): AnyGameDefinition {
  const g = GAMES[id];
  if (!g) throw new Error(`unknown game: ${id}`);
  return g;
}

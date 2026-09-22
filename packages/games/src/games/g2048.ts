import { IllegalMoveError, type GameDefinition, type GameState } from '../core/types.js';
import { Rng } from '../core/rng.js';
import { renderGrid, DIR_NAMES } from '../core/grid.js';

const N = 4;

function slideLine(line: number[]): { out: number[]; gained: number } {
  const vals = line.filter((v) => v !== 0);
  const out: number[] = [];
  let gained = 0;
  for (let i = 0; i < vals.length; i++) {
    if (i + 1 < vals.length && vals[i] === vals[i + 1]) {
      const merged = vals[i] * 2;
      out.push(merged);
      gained += merged;
      i++; // 每个方块一次移动里最多合并一次
    } else {
      out.push(vals[i]);
    }
  }
  while (out.length < line.length) out.push(0);
  return { out, gained };
}

/** 取出某个方向上的第 k 条线（按移动方向从前往后排列） */
function lineIndices(dir: number, k: number): number[] {
  const ids: number[] = [];
  for (let i = 0; i < N; i++) {
    switch (dir) {
      case 0: ids.push(i * N + k); break;            // UP：列 k 从上往下
      case 1: ids.push(k * N + (N - 1 - i)); break;  // RIGHT：行 k 从右往左
      case 2: ids.push((N - 1 - i) * N + k); break;  // DOWN：列 k 从下往上
      default: ids.push(k * N + i);                  // LEFT：行 k 从左往右
    }
  }
  return ids;
}

function applyDir(board: number[], dir: number): { board: number[]; gained: number; changed: boolean } {
  const next = board.slice();
  let gained = 0;
  let changed = false;
  for (let k = 0; k < N; k++) {
    const ids = lineIndices(dir, k);
    const line = ids.map((i) => board[i]);
    const res = slideLine(line);
    gained += res.gained;
    for (let i = 0; i < N; i++) {
      if (next[ids[i]] !== res.out[i]) changed = true;
      next[ids[i]] = res.out[i];
    }
  }
  return { board: next, gained, changed };
}

function spawn(board: number[], rng: Rng): void {
  const empty: number[] = [];
  for (let i = 0; i < board.length; i++) if (board[i] === 0) empty.push(i);
  if (!empty.length) return;
  const at = empty[rng.int(empty.length)];
  board[at] = rng.next() < 0.9 ? 2 : 4;
}

function maxTile(board: number[]): number {
  let m = 0;
  for (const v of board) if (v > m) m = v;
  return m;
}

export const g2048: GameDefinition<number> = {
  id: '2048',
  name: '2048',
  nameEn: '2048',
  tagline: '滑动合并相同数字，目标是拼出 2048',
  players: 1,
  hiddenInfo: false,
  rulesetVersion: 1,
  maxPlies: 3000,
  aiMaxTokens: 400,

  init(seed) {
    const board = new Array(N * N).fill(0);
    const rng = new Rng(seed, 0);
    spawn(board, rng);
    spawn(board, rng);
    return {
      board, rows: N, cols: N, turn: 0, status: 'playing',
      score: 0, plies: 0, rngCursor: rng.cursor,
      extra: { maxTile: maxTile(board) },
    };
  },

  legalMoves(s) {
    const out: number[] = [];
    for (let d = 0; d < 4; d++) if (applyDir(s.board, d).changed) out.push(d);
    return out;
  },

  reduce(s, move, seed) {
    if (s.status !== 'playing') throw new IllegalMoveError('game already over');
    if (!Number.isInteger(move) || move < 0 || move > 3) throw new IllegalMoveError(`bad direction: ${move}`);
    const res = applyDir(s.board, move);
    if (!res.changed) throw new IllegalMoveError(`${DIR_NAMES[move]} does not change the board`);

    const rng = new Rng(seed, s.rngCursor);
    spawn(res.board, rng);

    const next: GameState = {
      ...s,
      board: res.board,
      score: s.score + res.gained,
      plies: s.plies + 1,
      rngCursor: rng.cursor,
      extra: { maxTile: maxTile(res.board) },
    };
    let stuck = true;
    for (let d = 0; d < 4 && stuck; d++) if (applyDir(next.board, d).changed) stuck = false;
    if (stuck) next.status = 'lost';
    return next;
  },

  isTerminal: (s) => s.status !== 'playing',
  scoreOf: (s) => s.score,
  view: (s) => s,

  render(s) {
    return renderGrid(s.board, N, N, (v) => (v === 0 ? '.' : String(v)), { width: 4 });
  },

  rules() {
    return [
      'You are playing 2048 on a 4x4 grid.',
      '- Each move slides ALL tiles as far as possible in one direction.',
      '- Two tiles with the same number merge into one tile of double the value.',
      '- A tile can merge at most once per move.',
      '- After every move, a new tile appears in a random empty cell (2 with 90% chance, 4 with 10%).',
      '- A direction is only legal if it changes the board.',
      '- The game ends when no direction changes the board. Maximize your score.',
    ].join('\n');
  },

  moveToText: (m) => DIR_NAMES[m],

  parseMove(text) {
    const t = text.trim().toUpperCase();
    const map: Record<string, number> = {
      UP: 0, U: 0, W: 0, NORTH: 0, '0': 0,
      RIGHT: 1, R: 1, D: 1, EAST: 1, '1': 1,
      DOWN: 2, S: 2, SOUTH: 2, '2': 2,
      LEFT: 3, L: 3, A: 3, WEST: 3, '3': 3,
    };
    if (t in map) return map[t];
    for (const key of ['UP', 'DOWN', 'LEFT', 'RIGHT']) {
      if (t.includes(key)) return DIR_NAMES.indexOf(key as (typeof DIR_NAMES)[number]);
    }
    return null;
  },

  ui: {
    cellClass: (v) => (v === 0 ? 'tile tile-0' : `tile tile-${v > 2048 ? 'super' : v}`),
    cellLabel: (v) => (v === 0 ? '' : String(v)),
    keys: {
      ArrowUp: 0, ArrowRight: 1, ArrowDown: 2, ArrowLeft: 3,
      w: 0, d: 1, s: 2, a: 3, W: 0, D: 1, S: 2, A: 3,
    },
    swipe: true,
    cellSize: 76,
  },
};

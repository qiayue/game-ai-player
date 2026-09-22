import { IllegalMoveError, stripHidden, type GameDefinition, type GameState } from '../core/types.js';
import { Rng } from '../core/rng.js';
import { renderGrid, coordText, parseCoord } from '../core/grid.js';

const N = 9;
const MINES = 10;
/** 格子取值：0-8 已翻开的邻雷数，9 踩爆的雷，10 未翻开，11 已插旗，12 终局显示的雷 */
const HIDDEN = 10;
const FLAG = 11;
const SHOWN_MINE = 12;

export interface MineMove extends Record<string, number> {
  idx: number;
  /** 0 翻开，1 插旗/取消插旗 */
  action: number;
}

function neighbors(idx: number): number[] {
  const r = Math.floor(idx / N);
  const c = idx % N;
  const out: number[] = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const rr = r + dr;
      const cc = c + dc;
      if (rr >= 0 && rr < N && cc >= 0 && cc < N) out.push(rr * N + cc);
    }
  }
  return out;
}

/** 首次翻开时才布雷，保证第一下永远安全（且周围一圈也安全） */
function placeMines(safe: number, rng: Rng): number[] {
  const forbidden = new Set([safe, ...neighbors(safe)]);
  const pool: number[] = [];
  for (let i = 0; i < N * N; i++) if (!forbidden.has(i)) pool.push(i);
  rng.shuffle(pool);
  const mines = new Array(N * N).fill(0);
  for (let i = 0; i < MINES && i < pool.length; i++) mines[pool[i]] = 1;
  return mines;
}

function countAround(mines: number[], idx: number): number {
  let n = 0;
  for (const j of neighbors(idx)) n += mines[j];
  return n;
}

/** 从 idx 开始洪水翻开（不动已插旗的格子），返回新翻开的格子数 */
function reveal(board: number[], mines: number[], idx: number): number {
  const stack = [idx];
  let opened = 0;
  while (stack.length) {
    const cur = stack.pop()!;
    if (board[cur] !== HIDDEN) continue;
    const n = countAround(mines, cur);
    board[cur] = n;
    opened++;
    if (n === 0) for (const j of neighbors(cur)) if (board[j] === HIDDEN) stack.push(j);
  }
  return opened;
}

function safeCellsLeft(board: number[], mines: number[]): number {
  let left = 0;
  for (let i = 0; i < N * N; i++) if (!mines[i] && (board[i] === HIDDEN || board[i] === FLAG)) left++;
  return left;
}

export const minesweeper: GameDefinition<MineMove> = {
  id: 'minesweeper',
  name: '扫雷',
  nameEn: 'Minesweeper',
  tagline: `${N}x${N} 棋盘 ${MINES} 颗雷，靠数字推理避开地雷`,
  players: 1,
  hiddenInfo: true,
  rulesetVersion: 1,
  maxPlies: 300,
  aiMaxTokens: 700,

  init() {
    return {
      board: new Array(N * N).fill(HIDDEN),
      rows: N, cols: N, turn: 0, status: 'playing',
      score: 0, plies: 0, rngCursor: 0,
      extra: { _mines: [], placed: 0, flags: 0, mines: MINES },
    };
  },

  legalMoves(s) {
    if (s.status !== 'playing') return [];
    const out: MineMove[] = [];
    for (let i = 0; i < N * N; i++) {
      if (s.board[i] === HIDDEN) {
        out.push({ idx: i, action: 0 });
        out.push({ idx: i, action: 1 });
      } else if (s.board[i] === FLAG) {
        out.push({ idx: i, action: 1 });
      }
    }
    return out;
  },

  reduce(s, move, seed) {
    if (s.status !== 'playing') throw new IllegalMoveError('game already over');
    const { idx, action } = move;
    if (!Number.isInteger(idx) || idx < 0 || idx >= N * N) throw new IllegalMoveError(`cell out of range: ${idx}`);
    const cell = s.board[idx];
    if (cell !== HIDDEN && cell !== FLAG) {
      throw new IllegalMoveError(`${coordText(Math.floor(idx / N), idx % N)} is already revealed`);
    }

    const board = s.board.slice();
    const extra = { ...s.extra };
    let mines = (s.extra._mines as number[]).slice();
    const next: GameState = { ...s, board, extra, plies: s.plies + 1 };

    if (action === 1) {
      board[idx] = cell === FLAG ? HIDDEN : FLAG;
      extra.flags = (s.extra.flags as number) + (cell === FLAG ? -1 : 1);
      extra._mines = mines;
      return next;
    }

    if (cell === FLAG) throw new IllegalMoveError(`${coordText(Math.floor(idx / N), idx % N)} is flagged; unflag it first`);

    if (!s.extra.placed) {
      const rng = new Rng(seed, s.rngCursor);
      mines = placeMines(idx, rng);
      next.rngCursor = rng.cursor;
      extra.placed = 1;
    }

    if (mines[idx]) {
      for (let i = 0; i < N * N; i++) if (mines[i]) board[i] = i === idx ? 9 : SHOWN_MINE;
      next.status = 'lost';
      extra._mines = mines;
      return next;
    }

    reveal(board, mines, idx);
    let opened = 0;
    for (let i = 0; i < N * N; i++) if (board[i] >= 0 && board[i] <= 8) opened++;
    next.score = opened;
    extra.flags = board.filter((v) => v === FLAG).length;
    extra._mines = mines;
    if (safeCellsLeft(board, mines) === 0) {
      next.status = 'won';
      for (let i = 0; i < N * N; i++) if (mines[i]) board[i] = FLAG;
      extra.flags = MINES;
    }
    return next;
  },

  isTerminal: (s) => s.status !== 'playing',
  scoreOf: (s) => s.score,
  view: (s) => stripHidden(s),

  render(s) {
    const grid = renderGrid(
      s.board, N, N,
      (v) => (v === HIDDEN ? '?' : v === FLAG ? 'F' : v === 9 ? 'X' : v === SHOWN_MINE ? '*' : v === 0 ? '.' : String(v)),
      { ruler: true, width: 1 },
    );
    return `${grid}\n? = unrevealed, F = your flag, . = 0 adjacent mines, 1-8 = adjacent mine count\nMines total: ${MINES}, flags placed: ${s.extra.flags}`;
  },

  rules() {
    return [
      `You are playing Minesweeper on a ${N}x${N} board with ${MINES} hidden mines.`,
      '- Columns are letters A-I, rows are numbers 1-9, e.g. C4.',
      '- Revealing a cell shows how many of its 8 neighbours contain mines. A "." means zero,',
      '  and its neighbours are opened automatically.',
      '- Revealing a mine ends the game immediately.',
      '- Your first reveal is always safe.',
      '- You may flag a cell you believe is a mine; flagging is optional and does not score.',
      '- You win by revealing every cell that is not a mine. Score = number of revealed cells.',
      '- Answer with REVEAL <cell> or FLAG <cell>, e.g. "REVEAL C4".',
    ].join('\n');
  },

  moveToText: (m) => `${m.action === 1 ? 'FLAG' : 'REVEAL'} ${coordText(Math.floor(m.idx / N), m.idx % N)}`,

  parseMove(text) {
    const action = /flag|mark/i.test(text) ? 1 : 0;
    const coordMatch = /([A-Ia-i])\s*(\d)/.exec(text);
    if (coordMatch) {
      const idx = parseCoord(`${coordMatch[1]}${coordMatch[2]}`, N, N);
      if (idx !== null) return { idx, action };
    }
    const rc = /(?:row\s*)?(\d+)\s*[,，]\s*(?:col(?:umn)?\s*)?(\d+)/i.exec(text);
    if (rc) {
      const r = parseInt(rc[1], 10) - 1;
      const c = parseInt(rc[2], 10) - 1;
      if (r >= 0 && r < N && c >= 0 && c < N) return { idx: r * N + c, action };
    }
    return null;
  },

  ui: {
    cellClass(v) {
      if (v === HIDDEN) return 'ms ms-hidden';
      if (v === FLAG) return 'ms ms-flag';
      if (v === 9) return 'ms ms-boom';
      if (v === SHOWN_MINE) return 'ms ms-mine';
      return `ms ms-open ms-n${v}`;
    },
    cellLabel(v) {
      if (v === HIDDEN) return '';
      if (v === FLAG) return '🚩';
      if (v === 9) return '💥';
      if (v === SHOWN_MINE) return '💣';
      return v === 0 ? '' : String(v);
    },
    clickCell: (idx, s) => (s.board[idx] === HIDDEN ? { idx, action: 0 } : null),
    altClickCell: (idx, s) => (s.board[idx] === HIDDEN || s.board[idx] === FLAG ? { idx, action: 1 } : null),
    cellSize: 40,
  },
};

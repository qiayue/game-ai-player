import { IllegalMoveError, type GameDefinition, type GameState } from '../core/types.js';
import { Rng } from '../core/rng.js';
import { renderGrid, coordText, parseCoord } from '../core/grid.js';

const N = 9;
const CLUES = 36; // 目标提示数，越少越难

export interface SudokuMove extends Record<string, number> {
  idx: number;
  /** 1-9 填入，0 擦除 */
  val: number;
}

const boxOf = (idx: number) => Math.floor(idx / 27) * 3 + Math.floor((idx % 9) / 3);

/** 某格可填的数字位掩码（bit 1..9） */
function candidates(board: number[], idx: number): number {
  const r = Math.floor(idx / N);
  const c = idx % N;
  const b = boxOf(idx);
  let used = 0;
  for (let i = 0; i < N * N; i++) {
    const v = board[i];
    if (!v) continue;
    if (Math.floor(i / N) === r || i % N === c || boxOf(i) === b) used |= 1 << v;
  }
  return ~used & 0x3fe;
}

function bitsToValues(mask: number): number[] {
  const out: number[] = [];
  for (let v = 1; v <= 9; v++) if (mask & (1 << v)) out.push(v);
  return out;
}

/** 数解的个数，最多数到 limit 个就提前返回 */
function countSolutions(board: number[], limit: number): number {
  const work = board.slice();
  let found = 0;
  const step = (): boolean => {
    let best = -1;
    let bestMask = 0;
    let bestCount = 10;
    for (let i = 0; i < N * N; i++) {
      if (work[i]) continue;
      const mask = candidates(work, i);
      const n = bitsToValues(mask).length;
      if (n === 0) return false;
      if (n < bestCount) {
        bestCount = n;
        best = i;
        bestMask = mask;
        if (n === 1) break;
      }
    }
    if (best < 0) {
      found++;
      return found >= limit;
    }
    for (const v of bitsToValues(bestMask)) {
      work[best] = v;
      if (step()) {
        work[best] = 0;
        return true;
      }
      work[best] = 0;
    }
    return false;
  };
  step();
  return found;
}

/** 用标准构造 + 随机保序变换生成一个完整解 */
function fullGrid(rng: Rng): number[] {
  const base = new Array(N * N);
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      base[r * N + c] = ((3 * (r % 3) + Math.floor(r / 3) + c) % 9) + 1;
    }
  }
  const digits = rng.shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const rowOrder: number[] = [];
  for (const band of rng.shuffle([0, 1, 2])) for (const r of rng.shuffle([0, 1, 2])) rowOrder.push(band * 3 + r);
  const colOrder: number[] = [];
  for (const stack of rng.shuffle([0, 1, 2])) for (const c of rng.shuffle([0, 1, 2])) colOrder.push(stack * 3 + c);
  const transpose = rng.next() < 0.5;

  const out = new Array(N * N);
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const v = digits[base[rowOrder[r] * N + colOrder[c]] - 1];
      out[transpose ? c * N + r : r * N + c] = v;
    }
  }
  return out;
}

function generate(seed: string): { board: number[]; given: number[]; rngCursor: number } {
  const rng = new Rng(seed, 0);
  const solution = fullGrid(rng);
  const board = solution.slice();
  const order = rng.shuffle(Array.from({ length: N * N }, (_, i) => i));
  let filled = N * N;
  for (const idx of order) {
    if (filled <= CLUES) break;
    const keep = board[idx];
    board[idx] = 0;
    if (countSolutions(board, 2) === 1) filled--;
    else board[idx] = keep;
  }
  return { board, given: board.map((v) => (v ? 1 : 0)), rngCursor: rng.cursor };
}

function filledCount(board: number[]): number {
  let n = 0;
  for (const v of board) if (v) n++;
  return n;
}

export const sudoku: GameDefinition<SudokuMove> = {
  id: 'sudoku',
  name: '数独',
  nameEn: 'Sudoku',
  tagline: '9x9 宫格，每行每列每宫填入 1-9 不重复',
  players: 1,
  hiddenInfo: false,
  rulesetVersion: 1,
  maxPlies: 400,
  aiMaxTokens: 700,

  init(seed) {
    const { board, given, rngCursor } = generate(seed);
    return {
      board, rows: N, cols: N, turn: 0, status: 'playing',
      score: filledCount(board), plies: 0, rngCursor,
      extra: { given },
    };
  },

  legalMoves(s) {
    if (s.status !== 'playing') return [];
    const given = s.extra.given as number[];
    const out: SudokuMove[] = [];
    for (let i = 0; i < N * N; i++) {
      if (given[i]) continue;
      if (s.board[i]) {
        out.push({ idx: i, val: 0 });
      } else {
        for (const v of bitsToValues(candidates(s.board, i))) out.push({ idx: i, val: v });
      }
    }
    return out;
  },

  legalSummary(s) {
    const given = s.extra.given as number[];
    const parts: string[] = [];
    for (let i = 0; i < N * N; i++) {
      if (given[i] || s.board[i]) continue;
      const vals = bitsToValues(candidates(s.board, i));
      parts.push(`${coordText(Math.floor(i / N), i % N)}={${vals.join(',')}}`);
    }
    if (!parts.length) return 'no empty cells left';
    return `Empty cells and the values that do not conflict:\n${parts.join(' ')}`;
  },

  reduce(s, move, _seed) {
    if (s.status !== 'playing') throw new IllegalMoveError('game already over');
    const { idx, val } = move;
    if (!Number.isInteger(idx) || idx < 0 || idx >= N * N) throw new IllegalMoveError(`cell out of range: ${idx}`);
    if (!Number.isInteger(val) || val < 0 || val > 9) throw new IllegalMoveError(`value out of range: ${val}`);
    const given = s.extra.given as number[];
    const at = coordText(Math.floor(idx / N), idx % N);
    if (given[idx]) throw new IllegalMoveError(`${at} is a given clue and cannot be changed`);

    const board = s.board.slice();
    if (val === 0) {
      if (!board[idx]) throw new IllegalMoveError(`${at} is already empty`);
      board[idx] = 0;
    } else {
      if (board[idx]) throw new IllegalMoveError(`${at} already contains ${board[idx]}; erase it first`);
      if (!(candidates(s.board, idx) & (1 << val))) {
        throw new IllegalMoveError(`${val} conflicts with the row, column or box of ${at}`);
      }
      board[idx] = val;
    }

    const next: GameState = {
      ...s, board,
      plies: s.plies + 1,
      score: filledCount(board),
      extra: { ...s.extra },
    };
    if (next.score === N * N) next.status = 'won';
    return next;
  },

  isTerminal: (s) => s.status !== 'playing',
  scoreOf: (s) => s.score,
  view: (s) => s,

  render(s) {
    const lines = renderGrid(s.board, N, N, (v) => (v === 0 ? '.' : String(v)), { ruler: true, width: 1 }).split('\n');
    const header = lines[0];
    const out = [header];
    for (let r = 0; r < N; r++) {
      out.push(lines[r + 1]);
      if (r % 3 === 2 && r !== N - 1) out.push('  ' + '-'.repeat(header.length - 2));
    }
    return out.join('\n');
  },

  rules() {
    return [
      'You are solving a 9x9 Sudoku.',
      '- Columns are letters A-I, rows are numbers 1-9, e.g. D7.',
      '- Fill every empty cell with a digit 1-9 so that each row, each column and each 3x3 box',
      '  contains every digit exactly once.',
      '- "." marks an empty cell. Clues that were given at the start cannot be changed.',
      '- A placement that conflicts with the same row, column or box is rejected as illegal.',
      '- You may erase one of your own digits with "ERASE <cell>" if you painted yourself into a corner.',
      '- Answer with "<cell>=<digit>", e.g. "D7=4".',
    ].join('\n');
  },

  moveToText: (m) =>
    m.val === 0
      ? `ERASE ${coordText(Math.floor(m.idx / N), m.idx % N)}`
      : `${coordText(Math.floor(m.idx / N), m.idx % N)}=${m.val}`,

  parseMove(text) {
    const erase = /erase|clear|remove/i.test(text);
    const m = /([A-Ia-i])\s*([1-9])\s*(?:=|:|\s+to\s+|\s+)?\s*([1-9])?/.exec(text);
    if (m) {
      const idx = parseCoord(`${m[1]}${m[2]}`, N, N);
      if (idx !== null) {
        if (erase) return { idx, val: 0 };
        if (m[3]) return { idx, val: parseInt(m[3], 10) };
      }
    }
    return null;
  },

  ui: {
    cellClass(v, s, idx) {
      const given = (s.extra.given as number[])[idx];
      const cls = ['sud', given ? 'sud-given' : 'sud-user'];
      if (idx % 3 === 2 && idx % 9 !== 8) cls.push('sud-br');
      if (Math.floor(idx / 9) % 3 === 2 && idx < 72) cls.push('sud-bb');
      if (v === 0) cls.push('sud-empty');
      return cls.join(' ');
    },
    cellLabel: (v) => (v === 0 ? '' : String(v)),
    palette: { values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 0], label: (v) => (v === 0 ? '⌫' : String(v)) },
    paletteMove(idx, val, s) {
      const given = (s.extra.given as number[])[idx];
      if (given) return null;
      if (val === 0) return s.board[idx] ? { idx, val: 0 } : null;
      if (s.board[idx]) return null;
      return { idx, val };
    },
    cellSize: 46,
  },
};

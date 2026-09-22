import { IllegalMoveError, type GameDefinition, type GameState } from '../core/types.js';
import { Rng } from '../core/rng.js';
import { renderGrid } from '../core/grid.js';

const N = 4;
const BLANK = 0;
const SHUFFLE_MOVES = 160;

function blankIndex(board: number[]): number {
  return board.indexOf(BLANK);
}

/** 与空格相邻、因此可以滑动的方块编号 */
function slidableTiles(board: number[]): number[] {
  const b = blankIndex(board);
  const r = Math.floor(b / N);
  const c = b % N;
  const out: number[] = [];
  if (r > 0) out.push(board[(r - 1) * N + c]);
  if (r < N - 1) out.push(board[(r + 1) * N + c]);
  if (c > 0) out.push(board[r * N + c - 1]);
  if (c < N - 1) out.push(board[r * N + c + 1]);
  return out.sort((a, z) => a - z);
}

function isSolved(board: number[]): boolean {
  for (let i = 0; i < N * N - 1; i++) if (board[i] !== i + 1) return false;
  return board[N * N - 1] === BLANK;
}

function correctTiles(board: number[]): number {
  let n = 0;
  for (let i = 0; i < N * N - 1; i++) if (board[i] === i + 1) n++;
  return n;
}

function scoreFor(board: number[], plies: number): number {
  return isSolved(board) ? Math.max(120, 1000 - plies * 4) : correctTiles(board) * 5;
}

export const fifteen: GameDefinition<number> = {
  id: 'fifteen',
  name: '数字华容道',
  nameEn: '15 Puzzle',
  tagline: '滑动方块把 1-15 复原成顺序，步数越少分越高',
  players: 1,
  hiddenInfo: false,
  rulesetVersion: 1,
  maxPlies: 800,
  aiMaxTokens: 500,

  init(seed) {
    const board = Array.from({ length: N * N }, (_, i) => (i === N * N - 1 ? BLANK : i + 1));
    const rng = new Rng(seed, 0);
    // 从复原态随机走合法步，保证一定可解
    for (let k = 0; k < SHUFFLE_MOVES; k++) {
      const tiles = slidableTiles(board);
      const tile = tiles[rng.int(tiles.length)];
      const ti = board.indexOf(tile);
      const bi = blankIndex(board);
      board[bi] = tile;
      board[ti] = BLANK;
    }
    // 极小概率打回复原态，再补几步
    let guard = 0;
    while (isSolved(board) && guard++ < 10) {
      const tiles = slidableTiles(board);
      const tile = tiles[rng.int(tiles.length)];
      const ti = board.indexOf(tile);
      const bi = blankIndex(board);
      board[bi] = tile;
      board[ti] = BLANK;
    }
    return {
      board, rows: N, cols: N, turn: 0, status: 'playing',
      score: scoreFor(board, 0), plies: 0, rngCursor: rng.cursor,
      extra: {},
    };
  },

  legalMoves(s) {
    return s.status === 'playing' ? slidableTiles(s.board) : [];
  },

  reduce(s, move, _seed) {
    if (s.status !== 'playing') throw new IllegalMoveError('game already over');
    if (!Number.isInteger(move) || move < 1 || move > N * N - 1) throw new IllegalMoveError(`no such tile: ${move}`);
    if (!slidableTiles(s.board).includes(move)) {
      throw new IllegalMoveError(`tile ${move} is not next to the blank; you can slide ${slidableTiles(s.board).join(', ')}`);
    }
    const board = s.board.slice();
    const ti = board.indexOf(move);
    const bi = blankIndex(board);
    board[bi] = move;
    board[ti] = BLANK;

    const next: GameState = { ...s, board, plies: s.plies + 1, score: scoreFor(board, s.plies + 1) };
    if (isSolved(board)) next.status = 'won';
    return next;
  },

  isTerminal: (s) => s.status !== 'playing',
  scoreOf: (s) => s.score,
  view: (s) => s,

  render(s) {
    return renderGrid(s.board, N, N, (v) => (v === BLANK ? '_' : String(v)), { width: 2 });
  },

  rules() {
    return [
      'You are solving a 15 puzzle on a 4x4 board.',
      '- Tiles 1-15 plus one blank (shown as _).',
      '- A move slides ONE tile that is orthogonally adjacent to the blank into the blank.',
      '- You name the TILE NUMBER to slide, not a direction.',
      '- The goal is the order 1..15 reading left to right, top to bottom, with the blank bottom-right.',
      '- Fewer moves scores higher.',
    ].join('\n');
  },

  moveToText: (m) => String(m),

  parseMove(text) {
    const m = /\d+/.exec(text);
    if (!m) return null;
    const n = parseInt(m[0], 10);
    return n >= 1 && n <= N * N - 1 ? n : null;
  },

  ui: {
    cellClass(v, s, idx) {
      if (v === BLANK) return 'fif fif-blank';
      return `fif${v === idx + 1 ? ' fif-ok' : ''}`;
    },
    cellLabel: (v) => (v === BLANK ? '' : String(v)),
    clickCell: (idx, s) => (slidableTiles(s.board).includes(s.board[idx]) ? s.board[idx] : null),
    keys: {},
    cellSize: 72,
  },
};

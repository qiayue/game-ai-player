import { IllegalMoveError, type GameDefinition, type GameState } from '../core/types.js';
import { winsAt, winningCells } from '../core/lines.js';
import { renderGrid } from '../core/grid.js';

const ROWS = 6;
const COLS = 7;
const MARK = ['.', 'X', 'O'];

/** 该列最低的空格；满了返回 -1 */
function dropRow(board: number[], col: number): number {
  for (let r = ROWS - 1; r >= 0; r--) if (board[r * COLS + col] === 0) return r;
  return -1;
}

export const connect4: GameDefinition<number> = {
  id: 'connect4',
  name: '四子棋',
  nameEn: 'Connect Four',
  tagline: '棋子下落到最底部，先连成四子者胜',
  players: 2,
  hiddenInfo: false,
  rulesetVersion: 1,
  maxPlies: ROWS * COLS,
  aiMaxTokens: 500,

  init() {
    return {
      board: new Array(ROWS * COLS).fill(0),
      rows: ROWS, cols: COLS, turn: 0, status: 'playing',
      score: 0, plies: 0, rngCursor: 0,
      extra: { winner: -1, win: [] },
    };
  },

  legalMoves(s) {
    if (s.status !== 'playing') return [];
    const out: number[] = [];
    for (let c = 0; c < COLS; c++) if (dropRow(s.board, c) >= 0) out.push(c);
    return out;
  },

  reduce(s, move, _seed) {
    if (s.status !== 'playing') throw new IllegalMoveError('game already over');
    if (!Number.isInteger(move) || move < 0 || move >= COLS) throw new IllegalMoveError(`column out of range: ${move}`);
    const r = dropRow(s.board, move);
    if (r < 0) throw new IllegalMoveError(`column ${move} is full`);

    const piece = s.turn + 1;
    const board = s.board.slice();
    const idx = r * COLS + move;
    board[idx] = piece;

    const next: GameState = {
      ...s, board,
      turn: 1 - s.turn,
      plies: s.plies + 1,
      extra: { winner: -1, win: [] },
    };
    if (winsAt(board, ROWS, COLS, idx, piece, 4)) {
      next.status = 'won';
      next.extra.winner = s.turn;
      next.extra.win = winningCells(board, ROWS, COLS, idx, piece, 4);
    } else if (board.every((v) => v !== 0)) {
      next.status = 'draw';
    }
    return next;
  },

  isTerminal: (s) => s.status !== 'playing',

  scoreOf(s, seat) {
    if (s.status === 'playing') return 0;
    if (s.status === 'draw') return 0.5;
    return s.extra.winner === seat ? 1 : 0;
  },

  view: (s) => s,

  render(s) {
    const grid = renderGrid(s.board, ROWS, COLS, (v) => MARK[v], { width: 1 });
    const ruler = Array.from({ length: COLS }, (_, c) => String(c)).join(' ');
    return `${grid}\n${ruler}   <- column numbers`;
  },

  rules(seat) {
    return [
      `You are playing Connect Four as ${MARK[seat + 1]} (seat ${seat}).`,
      `- The board has ${COLS} columns and ${ROWS} rows. Row 0 is the TOP row.`,
      '- You choose a COLUMN (0-6). Your piece falls to the lowest empty cell of that column.',
      '- Four of your pieces in a row (horizontal, vertical or diagonal) wins.',
      '- A full column is not a legal move. X moves first.',
    ].join('\n');
  },

  moveToText: (m) => String(m),

  parseMove(text) {
    const m = /-?\d+/.exec(text);
    if (!m) return null;
    const n = parseInt(m[0], 10);
    return n >= 0 && n < COLS ? n : null;
  },

  ui: {
    cellClass(v, s, idx) {
      const win = (s.extra.win as number[]) || [];
      return `disc disc-${v}${win.includes(idx) ? ' cell-win' : ''}`;
    },
    cellLabel: () => '',
    clickCell: (idx, s) => {
      const col = idx % COLS;
      return dropRow(s.board, col) >= 0 ? col : null;
    },
    cellSize: 56,
  },
};

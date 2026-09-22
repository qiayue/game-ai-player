import { IllegalMoveError, type GameDefinition, type GameState } from '../core/types.js';
import { winsAt, winningCells } from '../core/lines.js';
import { renderGrid } from '../core/grid.js';

const N = 3;
const MARK = ['.', 'X', 'O'];

export const tictactoe: GameDefinition<number> = {
  id: 'tictactoe',
  name: '井字棋',
  nameEn: 'Tic-Tac-Toe',
  tagline: '三三棋盘，先连成一线者胜',
  players: 2,
  hiddenInfo: false,
  rulesetVersion: 1,
  maxPlies: 9,
  aiMaxTokens: 400,

  init() {
    return {
      board: new Array(N * N).fill(0),
      rows: N, cols: N, turn: 0, status: 'playing',
      score: 0, plies: 0, rngCursor: 0,
      extra: { winner: -1, win0: -1, win1: -1, win2: -1 },
    };
  },

  legalMoves(s) {
    if (s.status !== 'playing') return [];
    const out: number[] = [];
    for (let i = 0; i < s.board.length; i++) if (s.board[i] === 0) out.push(i);
    return out;
  },

  reduce(s, move, _seed) {
    if (s.status !== 'playing') throw new IllegalMoveError('game already over');
    if (!Number.isInteger(move) || move < 0 || move >= N * N) throw new IllegalMoveError(`cell out of range: ${move}`);
    if (s.board[move] !== 0) throw new IllegalMoveError(`cell ${move} is already taken`);

    const piece = s.turn + 1;
    const board = s.board.slice();
    board[move] = piece;

    const next: GameState = {
      ...s, board,
      turn: 1 - s.turn,
      plies: s.plies + 1,
      extra: { ...s.extra },
    };
    if (winsAt(board, N, N, move, piece, 3)) {
      next.status = 'won';
      next.extra.winner = s.turn;
      const cells = winningCells(board, N, N, move, piece, 3);
      next.extra.win0 = cells[0]; next.extra.win1 = cells[1]; next.extra.win2 = cells[2];
    } else if (board.every((v) => v !== 0)) {
      next.status = 'draw';
      next.extra.winner = -1;
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
    // 空格显示格子编号，模型直接照着选
    return renderGrid(s.board, N, N, (v, i) => (v === 0 ? String(i) : MARK[v]), { width: 1 });
  },

  rules(seat) {
    return [
      `You are playing Tic-Tac-Toe as ${MARK[seat + 1]} (seat ${seat}).`,
      '- The board is 3x3. Cells are numbered 0-8, left to right, top to bottom.',
      '- Empty cells show their number; taken cells show X or O.',
      '- X moves first. Place your mark on any empty cell.',
      '- Three of your marks in a row (horizontal, vertical or diagonal) wins.',
      '- If the board fills with no line, the game is a draw.',
    ].join('\n');
  },

  moveToText: (m) => String(m),

  parseMove(text) {
    const m = /-?\d+/.exec(text);
    if (!m) return null;
    const n = parseInt(m[0], 10);
    return n >= 0 && n < N * N ? n : null;
  },

  ui: {
    cellClass(v, s, idx) {
      const win = [s.extra.win0, s.extra.win1, s.extra.win2];
      const hit = (win as number[]).includes(idx) ? ' cell-win' : '';
      return `cell mark-${v}${hit}`;
    },
    cellLabel: (v) => (v === 0 ? '' : MARK[v]),
    clickCell: (idx, s) => (s.board[idx] === 0 ? idx : null),
    cellSize: 96,
  },
};

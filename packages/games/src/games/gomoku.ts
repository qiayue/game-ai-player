import { IllegalMoveError, type GameDefinition, type GameState } from '../core/types.js';
import { winsAt, winningCells } from '../core/lines.js';
import { renderGrid, coordText, parseCoord } from '../core/grid.js';

const N = 15;
const MARK = ['.', 'X', 'O'];

export const gomoku: GameDefinition<number> = {
  id: 'gomoku',
  name: '五子棋',
  nameEn: 'Gomoku',
  tagline: '十五路棋盘，先连成五子者胜',
  players: 2,
  hiddenInfo: false,
  rulesetVersion: 1,
  maxPlies: N * N,
  aiMaxTokens: 600,

  init() {
    return {
      board: new Array(N * N).fill(0),
      rows: N, cols: N, turn: 0, status: 'playing',
      score: 0, plies: 0, rngCursor: 0,
      extra: { winner: -1, last: -1, win: [] },
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
    if (s.board[move] !== 0) throw new IllegalMoveError(`${coordText(Math.floor(move / N), move % N)} is already occupied`);

    const piece = s.turn + 1;
    const board = s.board.slice();
    board[move] = piece;

    const next: GameState = {
      ...s, board,
      turn: 1 - s.turn,
      plies: s.plies + 1,
      extra: { winner: -1, last: move, win: [] },
    };
    if (winsAt(board, N, N, move, piece, 5)) {
      next.status = 'won';
      next.extra.winner = s.turn;
      next.extra.win = winningCells(board, N, N, move, piece, 5);
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
    const grid = renderGrid(s.board, N, N, (v) => MARK[v], { ruler: true, width: 1 });
    const last = s.extra.last as number;
    const tail = last >= 0 ? `\nLast move: ${coordText(Math.floor(last / N), last % N)}` : '';
    return grid + tail;
  },

  rules(seat) {
    return [
      `You are playing Gomoku (five in a row) as ${MARK[seat + 1]} (seat ${seat}).`,
      `- The board is ${N}x${N}. Columns are letters A-O, rows are numbers 1-${N}.`,
      '- A coordinate looks like H8 (column H, row 8).',
      '- Place a stone on any empty intersection.',
      '- Five or more of your stones in an unbroken line (horizontal, vertical or diagonal) wins.',
      '- There are no forbidden-move restrictions. X moves first.',
    ].join('\n');
  },

  moveToText: (m) => coordText(Math.floor(m / N), m % N),

  parseMove(text) {
    const coord = parseCoord(text, N, N);
    if (coord !== null) return coord;
    const m = /(\d+)\s*[,，]\s*(\d+)/.exec(text);
    if (m) {
      const r = parseInt(m[1], 10);
      const c = parseInt(m[2], 10);
      if (r >= 0 && r < N && c >= 0 && c < N) return r * N + c;
    }
    return null;
  },

  ui: {
    cellClass(v, s, idx) {
      const win = (s.extra.win as number[]) || [];
      const cls = ['stone', `stone-${v}`];
      if (win.includes(idx)) cls.push('cell-win');
      if (s.extra.last === idx) cls.push('cell-last');
      return cls.join(' ');
    },
    cellLabel: () => '',
    clickCell: (idx, s) => (s.board[idx] === 0 ? idx : null),
    cellSize: 30,
  },
};

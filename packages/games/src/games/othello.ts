import { IllegalMoveError, type GameDefinition, type GameState } from '../core/types.js';
import { renderGrid, coordText, parseCoord } from '../core/grid.js';

const N = 8;
const MARK = ['.', 'X', 'O'];
const PASS = -1;

const DIRS8 = [
  [-1, -1], [-1, 0], [-1, 1],
  [0, -1], [0, 1],
  [1, -1], [1, 0], [1, 1],
] as const;

/** 在 idx 落子会翻转的对方棋子；空数组表示不合法 */
function flipsFor(board: number[], idx: number, piece: number): number[] {
  if (board[idx] !== 0) return [];
  const opp = 3 - piece;
  const r0 = Math.floor(idx / N);
  const c0 = idx % N;
  const out: number[] = [];
  for (const [dr, dc] of DIRS8) {
    const run: number[] = [];
    let r = r0 + dr;
    let c = c0 + dc;
    while (r >= 0 && r < N && c >= 0 && c < N && board[r * N + c] === opp) {
      run.push(r * N + c);
      r += dr;
      c += dc;
    }
    if (run.length && r >= 0 && r < N && c >= 0 && c < N && board[r * N + c] === piece) {
      out.push(...run);
    }
  }
  return out;
}

function placements(board: number[], piece: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < N * N; i++) if (flipsFor(board, i, piece).length) out.push(i);
  return out;
}

function counts(board: number[]): [number, number] {
  let a = 0;
  let b = 0;
  for (const v of board) {
    if (v === 1) a++;
    else if (v === 2) b++;
  }
  return [a, b];
}

function settle(next: GameState): GameState {
  const [black, white] = counts(next.board);
  next.extra.black = black;
  next.extra.white = white;
  const meCanMove = placements(next.board, next.turn + 1).length > 0;
  const oppCanMove = placements(next.board, 2 - next.turn).length > 0;
  if (!meCanMove && !oppCanMove) {
    next.status = black === white ? 'draw' : 'won';
    next.extra.winner = black === white ? -1 : black > white ? 0 : 1;
  }
  return next;
}

export const othello: GameDefinition<number> = {
  id: 'othello',
  name: '黑白棋',
  nameEn: 'Othello',
  tagline: '夹住翻转对手棋子，终局子多者胜',
  players: 2,
  hiddenInfo: false,
  rulesetVersion: 1,
  maxPlies: 120,
  aiMaxTokens: 600,

  init() {
    const board = new Array(N * N).fill(0);
    board[3 * N + 3] = 2;
    board[3 * N + 4] = 1;
    board[4 * N + 3] = 1;
    board[4 * N + 4] = 2;
    return {
      board, rows: N, cols: N, turn: 0, status: 'playing',
      score: 0, plies: 0, rngCursor: 0,
      extra: { winner: -1, last: -1, black: 2, white: 2 },
    };
  },

  legalMoves(s) {
    if (s.status !== 'playing') return [];
    const moves = placements(s.board, s.turn + 1);
    return moves.length ? moves : [PASS];
  },

  reduce(s, move, _seed) {
    if (s.status !== 'playing') throw new IllegalMoveError('game already over');
    const piece = s.turn + 1;

    if (move === PASS) {
      if (placements(s.board, piece).length) throw new IllegalMoveError('you have legal moves, passing is not allowed');
      const next: GameState = {
        ...s, board: s.board.slice(), turn: 1 - s.turn,
        plies: s.plies + 1, extra: { ...s.extra, last: PASS },
      };
      return settle(next);
    }

    if (!Number.isInteger(move) || move < 0 || move >= N * N) throw new IllegalMoveError(`cell out of range: ${move}`);
    const flips = flipsFor(s.board, move, piece);
    if (!flips.length) {
      throw new IllegalMoveError(
        `${coordText(Math.floor(move / N), move % N)} is not legal: it must flip at least one opponent disc`,
      );
    }

    const board = s.board.slice();
    board[move] = piece;
    for (const f of flips) board[f] = piece;

    const next: GameState = {
      ...s, board, turn: 1 - s.turn,
      plies: s.plies + 1,
      extra: { ...s.extra, last: move },
    };
    return settle(next);
  },

  isTerminal: (s) => s.status !== 'playing',

  scoreOf(s, seat) {
    if (s.status === 'playing') return 0;
    if (s.status === 'draw') return 0.5;
    return s.extra.winner === seat ? 1 : 0;
  },

  view: (s) => s,

  render(s) {
    const legal = new Set(placements(s.board, s.turn + 1));
    const grid = renderGrid(s.board, N, N, (v, i) => (v === 0 && legal.has(i) ? '*' : MARK[v]), {
      ruler: true, width: 1,
    });
    return `${grid}\n(* marks a cell where YOU can legally play)\nDiscs  X:${s.extra.black}  O:${s.extra.white}`;
  },

  rules(seat) {
    return [
      `You are playing Othello (Reversi) as ${MARK[seat + 1]} (seat ${seat}).`,
      '- The board is 8x8. Columns are letters A-H, rows are numbers 1-8, e.g. D3.',
      '- A move must sandwich one or more opponent discs between the disc you place and another of your discs,',
      '  in a straight line (horizontal, vertical or diagonal). All sandwiched discs flip to your colour.',
      '- A move that flips nothing is illegal.',
      '- If you have no legal move you must answer PASS.',
      '- The game ends when neither player can move. The player with more discs wins.',
      '- X (black) moves first.',
    ].join('\n');
  },

  moveToText: (m) => (m === PASS ? 'PASS' : coordText(Math.floor(m / N), m % N)),

  parseMove(text) {
    if (/pass/i.test(text)) return PASS;
    const coord = parseCoord(text, N, N);
    return coord;
  },

  ui: {
    cellClass(v, s, idx) {
      const cls = ['disc', `disc-${v}`];
      if (s.extra.last === idx) cls.push('cell-last');
      if (v === 0 && flipsFor(s.board, idx, s.turn + 1).length) cls.push('cell-hint');
      return cls.join(' ');
    },
    cellLabel: () => '',
    clickCell: (idx, s) => (flipsFor(s.board, idx, s.turn + 1).length ? idx : null),
    buttons: [{ label: '无棋可下（PASS）', move: PASS }],
    cellSize: 52,
  },
};

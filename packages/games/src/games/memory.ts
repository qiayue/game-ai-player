import { IllegalMoveError, stripHidden, type GameDefinition, type GameState } from '../core/types.js';
import { Rng } from '../core/rng.js';
import { renderGrid, coordText, parseCoord } from '../core/grid.js';

const ROWS = 4;
const COLS = 4;
const PAIRS = (ROWS * COLS) / 2;
const FACE_DOWN = 0;

const SYMBOLS = ['🍎', '🍋', '🍇', '🍓', '🍑', '🥝', '🍈', '🍒'];

export const memory: GameDefinition<number> = {
  id: 'memory',
  name: '记忆翻牌',
  nameEn: 'Memory',
  tagline: '翻开两张相同的牌就配对成功，步数越少分越高',
  players: 1,
  hiddenInfo: true,
  rulesetVersion: 1,
  maxPlies: 200,
  aiMaxTokens: 500,

  init(seed) {
    const rng = new Rng(seed, 0);
    const values: number[] = [];
    for (let v = 1; v <= PAIRS; v++) values.push(v, v);
    rng.shuffle(values);
    return {
      board: new Array(ROWS * COLS).fill(FACE_DOWN),
      rows: ROWS, cols: COLS, turn: 0, status: 'playing',
      score: 0, plies: 0, rngCursor: rng.cursor,
      extra: {
        _values: values,
        matched: new Array(ROWS * COLS).fill(0),
        // 玩家已经看到过的牌面（AI 的"记忆"，人类界面不显示）
        seen: new Array(ROWS * COLS).fill(0),
        flip0: -1,
        flip1: -1,
        pairs: 0,
      },
    };
  },

  legalMoves(s) {
    if (s.status !== 'playing') return [];
    const matched = s.extra.matched as number[];
    const out: number[] = [];
    for (let i = 0; i < ROWS * COLS; i++) {
      if (matched[i]) continue;
      if (i === s.extra.flip0 || i === s.extra.flip1) continue;
      out.push(i);
    }
    return out;
  },

  reduce(s, move, _seed) {
    if (s.status !== 'playing') throw new IllegalMoveError('game already over');
    if (!Number.isInteger(move) || move < 0 || move >= ROWS * COLS) throw new IllegalMoveError(`card out of range: ${move}`);

    const values = s.extra._values as number[];
    const matched = (s.extra.matched as number[]).slice();
    const seen = (s.extra.seen as number[]).slice();
    const board = s.board.slice();
    let flip0 = s.extra.flip0 as number;
    let flip1 = s.extra.flip1 as number;

    // 上一轮翻开的两张没配上，先盖回去
    if (flip0 >= 0 && flip1 >= 0) {
      board[flip0] = FACE_DOWN;
      board[flip1] = FACE_DOWN;
      flip0 = -1;
      flip1 = -1;
    }

    const at = coordText(Math.floor(move / COLS), move % COLS);
    if (matched[move]) throw new IllegalMoveError(`${at} is already matched`);
    if (move === flip0) throw new IllegalMoveError(`${at} is already face up this turn`);

    board[move] = values[move];
    seen[move] = values[move];

    let pairs = s.extra.pairs as number;
    if (flip0 < 0) {
      flip0 = move;
    } else {
      flip1 = move;
      if (values[flip0] === values[flip1]) {
        matched[flip0] = 1;
        matched[flip1] = 1;
        pairs++;
        flip0 = -1;
        flip1 = -1;
      }
    }

    const plies = s.plies + 1;
    const won = pairs === PAIRS;
    const next: GameState = {
      ...s, board, plies,
      score: pairs * 100 + (won ? Math.max(0, 600 - plies * 6) : 0),
      extra: { _values: values, matched, seen, flip0, flip1, pairs },
    };
    if (won) next.status = 'won';
    return next;
  },

  isTerminal: (s) => s.status !== 'playing',
  scoreOf: (s) => s.score,
  view: (s) => stripHidden(s),

  render(s) {
    const matched = s.extra.matched as number[];
    const seen = s.extra.seen as number[];
    const grid = renderGrid(
      s.board, ROWS, COLS,
      (v, i) => (matched[i] ? `${v}!` : v === FACE_DOWN ? '?' : `${v}`),
      { ruler: true, width: 2 },
    );
    const known = [];
    for (let i = 0; i < ROWS * COLS; i++) {
      if (!matched[i] && s.board[i] === FACE_DOWN && seen[i]) {
        known.push(`${coordText(Math.floor(i / COLS), i % COLS)}=${seen[i]}`);
      }
    }
    return [
      grid,
      '? = face down, a number = the symbol on that card, "!" = already matched',
      known.length ? `Cards you have seen before but are face down now: ${known.join(' ')}` : 'You have not seen any other card yet.',
      `Pairs found: ${s.extra.pairs} / ${PAIRS}`,
    ].join('\n');
  },

  rules() {
    return [
      `You are playing a Memory (concentration) game with ${PAIRS} pairs on a ${ROWS}x${COLS} board.`,
      '- Columns are letters A-D, rows are numbers 1-4, e.g. C2.',
      '- Each turn you flip ONE card. When two cards are face up they either match and stay up,',
      '  or they are turned back over on your next flip.',
      '- You are told which cards you have already seen; use that to find pairs quickly.',
      '- Fewer flips scores higher.',
    ].join('\n');
  },

  moveToText: (m) => coordText(Math.floor(m / COLS), m % COLS),

  parseMove(text) {
    const coord = parseCoord(text, ROWS, COLS);
    if (coord !== null) return coord;
    const m = /\d+/.exec(text);
    if (m) {
      const n = parseInt(m[0], 10);
      if (n >= 0 && n < ROWS * COLS) return n;
    }
    return null;
  },

  ui: {
    cellClass(v, s, idx) {
      const matched = (s.extra.matched as number[])[idx];
      if (matched) return 'card card-matched';
      return v === FACE_DOWN ? 'card card-down' : 'card card-up';
    },
    cellLabel: (v) => (v === FACE_DOWN ? '' : SYMBOLS[v - 1] ?? String(v)),
    clickCell(idx, s) {
      const matched = (s.extra.matched as number[])[idx];
      if (matched || idx === s.extra.flip0 || idx === s.extra.flip1) return null;
      return idx;
    },
    cellSize: 76,
  },
};

import { IllegalMoveError, type GameDefinition, type GameState } from '../core/types.js';
import { Rng } from '../core/rng.js';
import { renderGrid, DIRS, DIR_NAMES } from '../core/grid.js';

/** 0 地板 1 墙 2 目标点 3 箱子 4 箱子在目标点 5 人 6 人在目标点 */
const FLOOR = 0, WALL = 1, GOAL = 2, BOX = 3, BOX_ON = 4, MAN = 5, MAN_ON = 6;

const LEVELS: string[][] = [
  [
    '#####',
    '#@$.#',
    '#####',
  ],
  [
    '######',
    '#    #',
    '# $. #',
    '# @  #',
    '######',
  ],
  [
    '########',
    '#      #',
    '# $$   #',
    '# ..@  #',
    '#      #',
    '########',
  ],
  [
    '#######',
    '#     #',
    '# $#$ #',
    '# . . #',
    '#  @  #',
    '#######',
  ],
  [
    '#######',
    '#  .  #',
    '#  $  #',
    '#.$@$.#',
    '#     #',
    '#######',
  ],
  [
    '#########',
    '#  ...  #',
    '#  $$$  #',
    '#   @   #',
    '#########',
  ],
];

const CHAR_TO_CELL: Record<string, number> = {
  '#': WALL, ' ': FLOOR, '-': FLOOR, '_': FLOOR,
  '.': GOAL, '$': BOX, '*': BOX_ON, '@': MAN, '+': MAN_ON,
};
const CELL_TO_CHAR = ['-', '#', '.', '$', '*', '@', '+'];

function parseLevel(lines: string[]): { board: number[]; rows: number; cols: number } {
  const rows = lines.length;
  const cols = Math.max(...lines.map((l) => l.length));
  const board: number[] = [];
  for (let r = 0; r < rows; r++) {
    const line = lines[r].padEnd(cols, ' ');
    for (let c = 0; c < cols; c++) board.push(CHAR_TO_CELL[line[c]] ?? FLOOR);
  }
  return { board, rows, cols };
}

const isBox = (v: number) => v === BOX || v === BOX_ON;
const isMan = (v: number) => v === MAN || v === MAN_ON;
const isGoalCell = (v: number) => v === GOAL || v === BOX_ON || v === MAN_ON;
const withoutOccupant = (v: number) => (isGoalCell(v) ? GOAL : FLOOR);

function boxesOnGoal(board: number[]): number {
  let n = 0;
  for (const v of board) if (v === BOX_ON) n++;
  return n;
}

function allBoxesPlaced(board: number[]): boolean {
  return !board.some((v) => v === BOX);
}

function scoreFor(board: number[], plies: number, won: boolean): number {
  return won ? Math.max(150, 1000 - plies * 6) : boxesOnGoal(board) * 60;
}

function manIndex(board: number[]): number {
  return board.findIndex(isMan);
}

export const sokoban: GameDefinition<number> = {
  id: 'sokoban',
  name: '推箱子',
  nameEn: 'Sokoban',
  tagline: '把所有箱子推到目标点，步数越少分越高',
  players: 1,
  hiddenInfo: false,
  rulesetVersion: 1,
  maxPlies: 500,
  aiMaxTokens: 600,

  init(seed) {
    const rng = new Rng(seed, 0);
    const level = rng.int(LEVELS.length);
    const { board, rows, cols } = parseLevel(LEVELS[level]);
    return {
      board, rows, cols, turn: 0, status: 'playing',
      score: scoreFor(board, 0, false), plies: 0, rngCursor: rng.cursor,
      extra: { level },
    };
  },

  legalMoves(s) {
    if (s.status !== 'playing') return [];
    const out: number[] = [];
    for (let d = 0; d < 4; d++) if (tryMove(s, d)) out.push(d);
    return out;
  },

  reduce(s, move, _seed) {
    if (s.status !== 'playing') throw new IllegalMoveError('game already over');
    if (!Number.isInteger(move) || move < 0 || move > 3) throw new IllegalMoveError(`bad direction: ${move}`);
    const board = tryMove(s, move);
    if (!board) throw new IllegalMoveError(`${DIR_NAMES[move]} is blocked`);

    const won = allBoxesPlaced(board);
    const plies = s.plies + 1;
    const next: GameState = { ...s, board, plies, score: scoreFor(board, plies, won) };
    if (won) next.status = 'won';
    return next;
  },

  isTerminal: (s) => s.status !== 'playing',
  scoreOf: (s) => s.score,
  view: (s) => s,

  render(s) {
    const grid = renderGrid(s.board, s.rows, s.cols, (v) => CELL_TO_CHAR[v], { width: 1 });
    let boxes = 0;
    for (const v of s.board) if (isBox(v)) boxes++;
    return `${grid}\nBoxes on goals: ${boxesOnGoal(s.board)} / ${boxes}`;
  },

  rules() {
    return [
      'You are playing Sokoban.',
      '- @ is you, $ is a box, . is a goal, * is a box already on a goal, + is you standing on a goal,',
      '  # is a wall and - is empty floor.',
      '- Each move you walk one cell UP, DOWN, LEFT or RIGHT.',
      '- UP decreases the row, DOWN increases it, LEFT decreases the column, RIGHT increases it.',
      '- Walking into a box PUSHES it one cell in the same direction. You can only push one box at a time,',
      '  and only if the cell behind it is empty floor or a goal. You can never pull a box.',
      '- The level is solved when every box sits on a goal. Fewer moves scores higher.',
      '- A box pushed into a corner can be stuck forever, so plan ahead.',
    ].join('\n');
  },

  moveToText: (m) => DIR_NAMES[m],

  parseMove(text) {
    const t = text.trim().toUpperCase();
    const map: Record<string, number> = { UP: 0, RIGHT: 1, DOWN: 2, LEFT: 3, U: 0, R: 1, D: 2, L: 3, W: 0, A: 3, S: 2 };
    if (t in map) return map[t];
    for (const key of ['UP', 'DOWN', 'LEFT', 'RIGHT']) {
      if (t.includes(key)) return DIR_NAMES.indexOf(key as (typeof DIR_NAMES)[number]);
    }
    return null;
  },

  ui: {
    cellClass: (v) => `sok sok-${v}`,
    cellLabel: (v) => (v === BOX ? '📦' : v === BOX_ON ? '✅' : isMan(v) ? '🙂' : v === GOAL ? '·' : ''),
    keys: {
      ArrowUp: 0, ArrowRight: 1, ArrowDown: 2, ArrowLeft: 3,
      w: 0, d: 1, s: 2, a: 3, W: 0, D: 1, S: 2, A: 3,
    },
    swipe: true,
    cellSize: 48,
  },
};

/** 试着往 d 方向走一步，返回新棋盘；走不动返回 null */
function tryMove(s: GameState, d: number): number[] | null {
  const { rows, cols } = s;
  const man = manIndex(s.board);
  if (man < 0) return null;
  const r = Math.floor(man / cols) + DIRS[d].dr;
  const c = (man % cols) + DIRS[d].dc;
  if (r < 0 || r >= rows || c < 0 || c >= cols) return null;
  const target = r * cols + c;
  const tv = s.board[target];
  if (tv === WALL) return null;

  const board = s.board.slice();
  if (isBox(tv)) {
    const r2 = r + DIRS[d].dr;
    const c2 = c + DIRS[d].dc;
    if (r2 < 0 || r2 >= rows || c2 < 0 || c2 >= cols) return null;
    const beyond = r2 * cols + c2;
    const bv = board[beyond];
    if (bv !== FLOOR && bv !== GOAL) return null;
    board[beyond] = bv === GOAL ? BOX_ON : BOX;
  }
  board[man] = withoutOccupant(board[man]);
  board[target] = isGoalCell(tv) ? MAN_ON : MAN;
  return board;
}

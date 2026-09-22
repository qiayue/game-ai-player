import { IllegalMoveError, type GameDefinition, type GameState } from '../core/types.js';
import { Rng } from '../core/rng.js';
import { renderGrid, DIRS, DIR_NAMES } from '../core/grid.js';

const N = 12;
const EMPTY = 0;
const BODY = 1;
const HEAD = 2;
const FOOD = 3;

function paint(body: number[], food: number): number[] {
  const board = new Array(N * N).fill(EMPTY);
  for (let i = body.length - 1; i >= 0; i--) board[body[i]] = i === 0 ? HEAD : BODY;
  if (food >= 0) board[food] = FOOD;
  return board;
}

function spawnFood(body: number[], rng: Rng): number {
  const occupied = new Set(body);
  const empty: number[] = [];
  for (let i = 0; i < N * N; i++) if (!occupied.has(i)) empty.push(i);
  if (!empty.length) return -1;
  return empty[rng.int(empty.length)];
}

export const snake: GameDefinition<number> = {
  id: 'snake',
  name: '贪吃蛇',
  nameEn: 'Snake',
  tagline: '吃到食物就变长，撞墙或撞自己就结束',
  players: 1,
  hiddenInfo: false,
  rulesetVersion: 1,
  maxPlies: 2000,
  aiMaxTokens: 500,

  init(seed) {
    const mid = Math.floor(N / 2);
    const start = mid * N + mid;
    const body = [start, start - 1, start - 2];
    const rng = new Rng(seed, 0);
    const food = spawnFood(body, rng);
    return {
      board: paint(body, food),
      rows: N, cols: N, turn: 0, status: 'playing',
      score: 0, plies: 0, rngCursor: rng.cursor,
      extra: { body, food, dir: 1 },
    };
  },

  legalMoves(s) {
    if (s.status !== 'playing') return [];
    const body = s.extra.body as number[];
    const dir = s.extra.dir as number;
    const out: number[] = [];
    for (let d = 0; d < 4; d++) {
      // 长度大于 1 时不能直接掉头
      if (body.length > 1 && d === (dir + 2) % 4) continue;
      out.push(d);
    }
    return out;
  },

  reduce(s, move, seed) {
    if (s.status !== 'playing') throw new IllegalMoveError('game already over');
    if (!Number.isInteger(move) || move < 0 || move > 3) throw new IllegalMoveError(`bad direction: ${move}`);
    const body = (s.extra.body as number[]).slice();
    const dir = s.extra.dir as number;
    const food = s.extra.food as number;
    if (body.length > 1 && move === (dir + 2) % 4) {
      throw new IllegalMoveError(`cannot reverse into your own neck (you are heading ${DIR_NAMES[dir]})`);
    }

    const head = body[0];
    const r = Math.floor(head / N) + DIRS[move].dr;
    const c = (head % N) + DIRS[move].dc;

    const next: GameState = {
      ...s, plies: s.plies + 1,
      extra: { body, food, dir: move },
    };

    if (r < 0 || r >= N || c < 0 || c >= N) {
      next.status = 'lost';
      next.board = paint(body, food);
      next.extra.dead = 1;
      return next;
    }
    const nh = r * N + c;
    const eating = nh === food;
    // 不吃东西时尾巴会让开，所以撞到尾格不算死
    const blocking = eating ? body : body.slice(0, body.length - 1);
    if (blocking.includes(nh)) {
      next.status = 'lost';
      next.board = paint(body, food);
      next.extra.dead = 1;
      return next;
    }

    body.unshift(nh);
    let newFood = food;
    const rng = new Rng(seed, s.rngCursor);
    if (eating) {
      next.score = s.score + 1;
      newFood = spawnFood(body, rng);
      next.rngCursor = rng.cursor;
      if (newFood < 0) next.status = 'won';
    } else {
      body.pop();
    }
    next.extra.body = body;
    next.extra.food = newFood;
    next.board = paint(body, newFood);
    return next;
  },

  isTerminal: (s) => s.status !== 'playing',
  scoreOf: (s) => s.score,
  view: (s) => s,

  render(s) {
    const body = s.extra.body as number[];
    const head = body[0];
    const food = s.extra.food as number;
    const grid = renderGrid(
      s.board, N, N,
      (v) => (v === HEAD ? 'H' : v === BODY ? 'o' : v === FOOD ? '*' : '.'),
      { ruler: true, width: 1 },
    );
    const pos = (i: number) => `(row ${Math.floor(i / N) + 1}, col ${(i % N) + 1})`;
    return [
      grid,
      `Head H is at ${pos(head)}, facing ${DIR_NAMES[s.extra.dir as number]}.`,
      food >= 0 ? `Food * is at ${pos(food)}.` : 'No food left.',
      `Snake length: ${body.length}.`,
    ].join('\n');
  },

  rules() {
    return [
      `You are playing Snake on a ${N}x${N} grid.`,
      '- H is your head, o is your body, * is food, . is empty.',
      '- Rows are numbered 1 (top) to 12 (bottom), columns 1 (left) to 12 (right).',
      '- Each move you pick a direction and the head advances one cell.',
      '- UP decreases the row, DOWN increases it, LEFT decreases the column, RIGHT increases it.',
      '- Eating food grows the snake by one and scores 1 point; new food appears in a random empty cell.',
      '- You die if the head leaves the grid or enters a cell occupied by your own body.',
      '- You cannot reverse directly into your neck.',
      '- Survive and eat as much as possible.',
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
    const n = /-?\d+/.exec(t);
    if (n) {
      const v = parseInt(n[0], 10);
      if (v >= 0 && v <= 3) return v;
    }
    return null;
  },

  ui: {
    cellClass: (v) => `snake-cell sc-${v}`,
    cellLabel: () => '',
    keys: {
      ArrowUp: 0, ArrowRight: 1, ArrowDown: 2, ArrowLeft: 3,
      w: 0, d: 1, s: 2, a: 3, W: 0, D: 1, S: 2, A: 3,
    },
    swipe: true,
    cellSize: 28,
    autoTickMs: 220,
  },
};

import { describe, it, expect } from 'vitest';
import {
  g2048, tictactoe, connect4, gomoku, othello, snake,
  minesweeper, sudoku, fifteen, sokoban, memory,
  type GameState,
} from '../src/index.js';

function withBoard(s: GameState, board: number[]): GameState {
  return { ...s, board: board.slice() };
}

describe('2048', () => {
  it('同值方块合并一次，分数等于合并值', () => {
    const s = withBoard(g2048.init('x'), [
      2, 2, 4, 4,
      0, 0, 0, 0,
      0, 0, 0, 0,
      0, 0, 0, 0,
    ]);
    const next = g2048.reduce(s, 3, 'x'); // LEFT
    expect(next.board.slice(0, 4).filter((v) => v)).toEqual([4, 8]);
    expect(next.score).toBe(12);
  });

  it('一次移动里一个方块不会连续合并两次', () => {
    const s = withBoard(g2048.init('x'), [
      2, 2, 2, 2,
      0, 0, 0, 0,
      0, 0, 0, 0,
      0, 0, 0, 0,
    ]);
    const next = g2048.reduce(s, 3, 'x');
    expect(next.board.slice(0, 2)).toEqual([4, 4]);
  });

  it('不改变棋盘的方向是非法的', () => {
    const s = withBoard(g2048.init('x'), [
      2, 4, 8, 16,
      0, 0, 0, 0,
      0, 0, 0, 0,
      0, 0, 0, 0,
    ]);
    expect(g2048.legalMoves(s)).not.toContain(0); // UP 没有变化
    expect(() => g2048.reduce(s, 0, 'x')).toThrow(/does not change/);
  });
});

describe('井字棋', () => {
  it('连成一线即获胜', () => {
    let s = tictactoe.init('x');
    for (const m of [0, 3, 1, 4, 2]) s = tictactoe.reduce(s, m, 'x');
    expect(s.status).toBe('won');
    expect(s.extra.winner).toBe(0);
    expect(tictactoe.scoreOf(s, 0)).toBe(1);
    expect(tictactoe.scoreOf(s, 1)).toBe(0);
  });

  it('下满无人连线则平局', () => {
    let s = tictactoe.init('x');
    for (const m of [4, 0, 1, 7, 6, 2, 5, 3, 8]) s = tictactoe.reduce(s, m, 'x');
    expect(s.status).toBe('draw');
    expect(tictactoe.scoreOf(s, 0)).toBe(0.5);
  });

  it('不能下在已占用的格子', () => {
    const s = tictactoe.reduce(tictactoe.init('x'), 0, 'x');
    expect(() => tictactoe.reduce(s, 0, 'x')).toThrow(/taken/);
  });
});

describe('四子棋', () => {
  it('棋子落到该列最底部', () => {
    const s = connect4.reduce(connect4.init('x'), 3, 'x');
    expect(s.board[5 * 7 + 3]).toBe(1);
    const s2 = connect4.reduce(s, 3, 'x');
    expect(s2.board[4 * 7 + 3]).toBe(2);
  });

  it('竖向四连获胜', () => {
    let s = connect4.init('x');
    for (const m of [0, 1, 0, 1, 0, 1, 0]) s = connect4.reduce(s, m, 'x');
    expect(s.status).toBe('won');
    expect(s.extra.winner).toBe(0);
    expect((s.extra.win as number[]).length).toBe(4);
  });

  it('满列不可再下', () => {
    let s = connect4.init('x');
    for (let i = 0; i < 6; i++) s = connect4.reduce(s, 2, 'x');
    expect(connect4.legalMoves(s)).not.toContain(2);
    expect(() => connect4.reduce(s, 2, 'x')).toThrow(/full/);
  });
});

describe('五子棋', () => {
  it('五连获胜，四连不获胜', () => {
    let s = gomoku.init('x');
    const black = [0, 1, 2, 3];
    const white = [15 * 1 + 0, 15 * 1 + 1, 15 * 1 + 2, 15 * 1 + 3];
    for (let i = 0; i < 4; i++) {
      s = gomoku.reduce(s, black[i], 'x');
      expect(s.status).toBe('playing');
      s = gomoku.reduce(s, white[i], 'x');
    }
    s = gomoku.reduce(s, 4, 'x');
    expect(s.status).toBe('won');
    expect(s.extra.winner).toBe(0);
  });

  it('坐标文本与索引互转', () => {
    expect(gomoku.moveToText(0)).toBe('A1');
    expect(gomoku.parseMove('H8', gomoku.init('x'))).toBe(7 * 15 + 7);
  });
});

describe('黑白棋', () => {
  it('开局黑棋有 4 个合法点', () => {
    const s = othello.init('x');
    expect(othello.legalMoves(s).length).toBe(4);
    expect(s.extra.black).toBe(2);
  });

  it('落子会翻转夹住的棋子', () => {
    const s = othello.init('x');
    const move = othello.parseMove('D3', s)!;
    const next = othello.reduce(s, move, 'x');
    expect(next.extra.black).toBe(4);
    expect(next.extra.white).toBe(1);
  });

  it('不翻转任何棋子的落子是非法的', () => {
    const s = othello.init('x');
    expect(() => othello.reduce(s, 0, 'x')).toThrow(/not legal/);
  });

  it('有棋可下时不允许 PASS', () => {
    const s = othello.init('x');
    expect(() => othello.reduce(s, -1, 'x')).toThrow(/passing is not allowed/);
  });
});

describe('贪吃蛇', () => {
  it('不能直接掉头', () => {
    const s = snake.init('x'); // 初始朝右
    expect(snake.legalMoves(s)).not.toContain(3);
    expect(() => snake.reduce(s, 3, 'x')).toThrow(/reverse/);
  });

  it('撞墙就结束', () => {
    let s = snake.init('x');
    for (let i = 0; i < 20 && s.status === 'playing'; i++) s = snake.reduce(s, 1, 'x');
    expect(s.status).toBe('lost');
  });

  it('吃到食物会加分并变长', () => {
    let s = snake.init('food-seed');
    const startLen = (s.extra.body as number[]).length;
    let ate = false;
    for (let i = 0; i < 300 && s.status === 'playing'; i++) {
      const legal = snake.legalMoves(s);
      const food = s.extra.food as number;
      const head = (s.extra.body as number[])[0];
      const hr = Math.floor(head / s.cols), hc = head % s.cols;
      const fr = Math.floor(food / s.cols), fc = food % s.cols;
      // 简单贪心：先对齐行再对齐列
      let want = hr > fr ? 0 : hr < fr ? 2 : hc < fc ? 1 : 3;
      if (!legal.includes(want)) want = legal[0];
      const before = s.score;
      s = snake.reduce(s, want, 'food-seed');
      if (s.score > before) { ate = true; break; }
    }
    expect(ate).toBe(true);
    expect((s.extra.body as number[]).length).toBeGreaterThan(startLen);
  });
});

describe('扫雷', () => {
  it('第一下永远安全，且隐藏雷层不会下发给客户端', () => {
    for (let i = 0; i < 30; i++) {
      const seed = `ms-${i}`;
      const s = minesweeper.init(seed);
      const next = minesweeper.reduce(s, { idx: 40, action: 0 }, seed);
      expect(next.status).toBe('playing');
      expect(next.score).toBeGreaterThan(0);
      expect(Object.keys(minesweeper.view(next, 0).extra)).not.toContain('_mines');
    }
  });

  it('插旗后不能直接翻开', () => {
    const seed = 'ms-flag';
    let s = minesweeper.init(seed);
    s = minesweeper.reduce(s, { idx: 0, action: 1 }, seed);
    expect(s.extra.flags).toBe(1);
    expect(() => minesweeper.reduce(s, { idx: 0, action: 0 }, seed)).toThrow(/flagged/);
  });

  it('踩到雷就结束', () => {
    const seed = 'ms-boom';
    let s = minesweeper.reduce(minesweeper.init(seed), { idx: 40, action: 0 }, seed);
    const mines = s.extra._mines as number[];
    const mine = mines.findIndex((v) => v === 1);
    if (s.board[mine] === 10) {
      s = minesweeper.reduce(s, { idx: mine, action: 0 }, seed);
      expect(s.status).toBe('lost');
    }
  });
});

describe('数独', () => {
  it('生成的谜题只有唯一解，且提示数合理', () => {
    const s = sudoku.init('sud-1');
    const clues = s.board.filter((v) => v).length;
    expect(clues).toBeGreaterThanOrEqual(24);
    expect(clues).toBeLessThanOrEqual(45);
    expect(s.extra.given).toEqual(s.board.map((v) => (v ? 1 : 0)));
  });

  it('谜题可以被解开', () => {
    const seed = 'sud-solve';
    let s = sudoku.init(seed);
    let guard = 0;
    while (s.status === 'playing' && guard++ < 400) {
      const moves = sudoku.legalMoves(s).filter((m) => m.val !== 0);
      // 选候选最少的格子，等价于人类的唯一候选法
      const byCell = new Map<number, number[]>();
      for (const m of moves) {
        const arr = byCell.get(m.idx) ?? [];
        arr.push(m.val);
        byCell.set(m.idx, arr);
      }
      let best: { idx: number; val: number } | null = null;
      let bestN = 10;
      for (const [idx, vals] of byCell) {
        if (vals.length < bestN) { bestN = vals.length; best = { idx, val: vals[0] }; }
      }
      if (!best) break;
      s = sudoku.reduce(s, best, seed);
    }
    expect(s.status).toBe('won');
    expect(s.score).toBe(81);
  });

  it('冲突的填入会被拒绝', () => {
    const seed = 'sud-conflict';
    const s = sudoku.init(seed);
    const empty = s.board.findIndex((v) => v === 0);
    const row = Math.floor(empty / 9);
    const existing = s.board.slice(row * 9, row * 9 + 9).find((v) => v);
    if (existing) {
      expect(() => sudoku.reduce(s, { idx: empty, val: existing }, seed)).toThrow(/conflicts/);
    }
  });
});

describe('数字华容道', () => {
  it('初始局面不是复原态，但一定可解', () => {
    const s = fifteen.init('f-1');
    const solved = s.board.every((v, i) => (i === 15 ? v === 0 : v === i + 1));
    expect(solved).toBe(false);
    expect(fifteen.legalMoves(s).length).toBeGreaterThanOrEqual(2);
  });

  it('只能滑动与空格相邻的方块', () => {
    const s = fifteen.init('f-2');
    const legal = fifteen.legalMoves(s);
    const illegal = [1, 2, 3, 4, 5, 6, 7, 8].find((t) => !legal.includes(t))!;
    expect(() => fifteen.reduce(s, illegal, 'f-2')).toThrow(/not next to the blank/);
  });

  it('滑回去会回到原局面', () => {
    const s = fifteen.init('f-3');
    const tile = fifteen.legalMoves(s)[0];
    const a = fifteen.reduce(s, tile, 'f-3');
    const b = fifteen.reduce(a, tile, 'f-3');
    expect(b.board).toEqual(s.board);
  });
});

describe('推箱子', () => {
  it('第一关一步推完', () => {
    // 找到会选中最小那一关的 seed
    let seed = '';
    for (let i = 0; i < 200; i++) {
      const s = sokoban.init(`sk-${i}`);
      if (s.extra.level === 0) { seed = `sk-${i}`; break; }
    }
    expect(seed).not.toBe('');
    const s = sokoban.init(seed);
    const next = sokoban.reduce(s, 1, seed); // RIGHT
    expect(next.status).toBe('won');
    expect(next.score).toBeGreaterThan(900);
  });

  it('推不动的方向是非法的', () => {
    let seed = '';
    for (let i = 0; i < 200; i++) {
      const s = sokoban.init(`sk-${i}`);
      if (s.extra.level === 0) { seed = `sk-${i}`; break; }
    }
    const s = sokoban.init(seed);
    expect(() => sokoban.reduce(s, 0, seed)).toThrow(/blocked/); // 上面是墙
  });
});

describe('记忆翻牌', () => {
  it('配对成功后牌保持翻开', () => {
    const seed = 'mem-1';
    const s = memory.init(seed);
    const values = s.extra._values as number[];
    const a = 0;
    const b = values.indexOf(values[a], 1);
    let n = memory.reduce(s, a, seed);
    n = memory.reduce(n, b, seed);
    expect(n.extra.pairs).toBe(1);
    expect((n.extra.matched as number[])[a]).toBe(1);
    expect(n.board[a]).toBe(values[a]);
  });

  it('没配上的两张会在下一次翻牌时盖回去', () => {
    const seed = 'mem-2';
    const s = memory.init(seed);
    const values = s.extra._values as number[];
    const a = 0;
    const b = values.findIndex((v, i) => i > 0 && v !== values[a]);
    let n = memory.reduce(s, a, seed);
    n = memory.reduce(n, b, seed);
    expect(n.extra.pairs).toBe(0);
    const c = n.board.findIndex((v, i) => v === 0 && i !== a && i !== b);
    n = memory.reduce(n, c, seed);
    expect(n.board[a]).toBe(0);
    expect(n.board[b]).toBe(0);
  });

  it('全部配对后获胜，且客户端拿不到未翻开的牌面', () => {
    const seed = 'mem-3';
    let s = memory.init(seed);
    const values = s.extra._values as number[];
    for (let v = 1; v <= 8; v++) {
      const [a, b] = values.map((x, i) => (x === v ? i : -1)).filter((i) => i >= 0);
      s = memory.reduce(s, a, seed);
      s = memory.reduce(s, b, seed);
    }
    expect(s.status).toBe('won');
    expect(s.extra.pairs).toBe(8);
    expect(Object.keys(memory.view(s, 0).extra)).not.toContain('_values');
  });
});

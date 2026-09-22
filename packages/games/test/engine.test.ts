import { describe, it, expect } from 'vitest';
import { GAME_LIST, getGame, hashState, validate, frames, Rng, type GameState, type Move } from '../src/index.js';

/** 用固定 seed 的伪随机挑一条合法走法，跑到终局 */
function playout(gameId: string, seed: string, pickSeed = 'pick'): { moves: Move[]; final: GameState } {
  const def = getGame(gameId);
  const rng = new Rng(pickSeed + seed, 0);
  let s = def.init(seed);
  const moves: Move[] = [];
  let guard = 0;
  while (!def.isTerminal(s) && guard++ < def.maxPlies) {
    const legal = def.legalMoves(s);
    if (!legal.length) break;
    const m = legal[rng.int(legal.length)];
    moves.push(m);
    s = def.reduce(s, m, seed);
  }
  return { moves, final: s };
}

describe.each(GAME_LIST.map((g) => g.id))('%s', (gameId) => {
  const def = getGame(gameId);

  it('初始状态自洽', () => {
    const s = def.init('seed-1');
    expect(s.board.length).toBe(s.rows * s.cols);
    expect(s.plies).toBe(0);
    expect(s.status).toBe('playing');
    expect(def.legalMoves(s).length).toBeGreaterThan(0);
  });

  it('init 对同一个 seed 完全确定', () => {
    expect(hashState(def.init('abc'))).toBe(hashState(def.init('abc')));
    // 开局不消费随机数的游戏（棋类、扫雷首点后才布雷）不同 seed 本来就同一个开局
    if (def.init('abc').rngCursor > 0) {
      expect(hashState(def.init('abc'))).not.toBe(hashState(def.init('abd')));
    }
  });

  it('reduce 不修改入参', () => {
    const s = def.init('purity');
    const snapshot = JSON.stringify(s);
    const legal = def.legalMoves(s);
    def.reduce(s, legal[0], 'purity');
    expect(JSON.stringify(s)).toBe(snapshot);
  });

  it('随机对局可重放，且哈希逐帧一致', () => {
    const seed = `replay-${gameId}`;
    const { moves, final } = playout(gameId, seed);
    const again = validate(def, seed, moves);
    expect(again.ok).toBe(true);
    expect(again.finalHash).toBe(hashState(final));
    const f = frames(def, seed, moves);
    expect(f.length).toBe(moves.length + 1);
    expect(hashState(f[f.length - 1])).toBe(hashState(final));
  });

  it('模糊测试：随机走法不会抛出意外异常，且能在步数上限内结束', () => {
    const runs = gameId === 'sudoku' ? 3 : 25;
    for (let i = 0; i < runs; i++) {
      const seed = `fuzz-${gameId}-${i}`;
      const { moves, final } = playout(gameId, seed);
      expect(moves.length).toBeLessThanOrEqual(def.maxPlies);
      expect(['playing', 'won', 'lost', 'draw']).toContain(final.status);
    }
  });

  it('终局后不能再走', () => {
    const seed = `over-${gameId}`;
    const { final } = playout(gameId, seed);
    if (def.isTerminal(final)) {
      expect(def.legalMoves(final).length).toBe(0);
      expect(() => def.reduce(final, 0 as never, seed)).toThrow();
    }
  });

  it('走法文本可以被自己解析回来', () => {
    const s = def.init('roundtrip');
    for (const m of def.legalMoves(s).slice(0, 12)) {
      const text = def.moveToText(m);
      const parsed = def.parseMove(text, s);
      expect(parsed, `${gameId}: "${text}" 解析失败`).not.toBeNull();
      expect(JSON.stringify(parsed)).toBe(JSON.stringify(m));
    }
  });

  it('render 与 rules 输出非空文本', () => {
    const s = def.init('render');
    expect(def.render(s, 0).length).toBeGreaterThan(0);
    expect(def.rules(0).length).toBeGreaterThan(0);
  });

  it('隐藏信息游戏的 view 会剥掉隐藏字段', () => {
    const s = def.init('hidden');
    const v = def.view(s, 0);
    const hiddenKeys = Object.keys(v.extra).filter((k) => k.startsWith('_'));
    expect(hiddenKeys).toEqual([]);
    if (!def.hiddenInfo) expect(Object.keys(v.extra).sort()).toEqual(Object.keys(s.extra).sort());
  });
});

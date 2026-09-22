import { describe, it, expect } from 'vitest';
import { GAME_LIST, Rng, type Move } from '@gap/games';
import { buildPrompt, buildRetryPrompt, splitResponse } from '../src/ai/prompt.js';
import { estimateTokens, ESTIMATED_PLIES } from '../src/ai/estimate.js';

describe('提示词协议', () => {
  it.each(GAME_LIST.map((g) => g.id))('%s 的提示词包含规则、棋盘与合法走法', (gameId) => {
    const def = GAME_LIST.find((g) => g.id === gameId)!;
    const state = def.init('prompt-seed');
    const { system, user } = buildPrompt(def, state, 0);

    expect(system).toContain('HOW TO ANSWER');
    expect(system).toContain('MOVE:');
    expect(user).toContain('CURRENT POSITION');
    // 要么逐条列出合法走法，要么给一段紧凑摘要（数独）
    expect(/LEGAL MOVES|Empty cells/.test(user)).toBe(true);
    expect(user.length).toBeGreaterThan(40);
  });

  it.each(GAME_LIST.map((g) => g.id))('%s：模型照着格式回答就能被解析回合法走法', (gameId) => {
    const def = GAME_LIST.find((g) => g.id === gameId)!;
    const rng = new Rng(`protocol-${gameId}`, 0);
    let state = def.init(`protocol-${gameId}`);

    // 连走 12 步，每一步都模拟一次「模型按格式回答」的完整往返
    for (let i = 0; i < 12 && !def.isTerminal(state); i++) {
      const legal = def.legalMoves(state) as Move[];
      if (!legal.length) break;
      const want = legal[rng.int(legal.length)];
      const fakeResponse = `Let me look at the board.\nI will take this one.\nMOVE: ${def.moveToText(want)}`;

      const { moveText, thought } = splitResponse(fakeResponse);
      expect(thought).toContain('board');
      const parsed = def.parseMove(moveText, def.view(state, state.turn));
      expect(parsed, `${gameId} 第 ${i} 步解析失败：${moveText}`).not.toBeNull();
      expect(() => def.reduce(state, parsed as Move, `protocol-${gameId}`)).not.toThrow();
      state = def.reduce(state, parsed as Move, `protocol-${gameId}`);
    }
  });

  it('结构化输出也能解析', () => {
    const r = splitResponse('{"reasoning":"角落最安全","move":"D3"}');
    expect(r.moveText).toBe('D3');
    expect(r.thought).toBe('角落最安全');
  });

  it('没有 MOVE 前缀时退回取最后一行', () => {
    const r = splitResponse('先看看棋盘\n我选 UP');
    expect(r.moveText).toBe('我选 UP');
  });

  it('纠错提示会带上错误原因和可选走法', () => {
    const def = GAME_LIST[0];
    const state = def.init('retry');
    const { user } = buildRetryPrompt(def, state, 0, 2, 'LEFT does not change the board');
    expect(user).toContain('rejected');
    expect(user).toContain('does not change the board');
  });

  it('最后一次尝试会要求只输出走法', () => {
    const def = GAME_LIST[0];
    const { user } = buildRetryPrompt(def, def.init('retry'), 0, 3, 'bad');
    expect(user).toContain('LAST attempt');
  });
});

describe('成本预估', () => {
  it.each(GAME_LIST.map((g) => g.id))('%s 的单步 token 估算在合理范围', (gameId) => {
    const def = GAME_LIST.find((g) => g.id === gameId)!;
    const { input, output } = estimateTokens(def);
    expect(input).toBeGreaterThan(50);
    // 最大的棋盘是五子棋 15x15，提示词也不该超过几千 token
    expect(input).toBeLessThan(4000);
    expect(output).toBeGreaterThan(0);
  });

  it('每个游戏都配了典型步数', () => {
    for (const g of GAME_LIST) {
      expect(ESTIMATED_PLIES[g.id], `${g.id} 缺少步数估计`).toBeGreaterThan(0);
      expect(ESTIMATED_PLIES[g.id]).toBeLessThanOrEqual(g.maxPlies);
    }
  });
});

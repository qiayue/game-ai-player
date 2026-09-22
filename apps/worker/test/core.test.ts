import { describe, it, expect } from 'vitest';
import { getGame } from '@gap/games';
import { signJwt, verifyJwt } from '../src/util/jwt.js';
import { ulid, ulidTime, slugify } from '../src/util/ids.js';
import { eloUpdate, windowKeys } from '../src/leaderboard.js';
import { suspicious } from '../src/routes/matches.js';

const SECRET = 'test-secret-value';

describe('session / 票据 JWT', () => {
  it('签发的 token 能被验回来', async () => {
    const token = await signJwt({ sub: 'p1', h: 'alice' }, SECRET, 60);
    const payload = await verifyJwt<{ sub: string; h: string }>(token, SECRET);
    expect(payload?.sub).toBe('p1');
    expect(payload?.h).toBe('alice');
  });

  it('换一个密钥就验不过', async () => {
    const token = await signJwt({ sub: 'p1' }, SECRET, 60);
    expect(await verifyJwt(token, 'other-secret')).toBeNull();
  });

  it('改过内容的 token 会被拒绝', async () => {
    const token = await signJwt({ sub: 'p1' }, SECRET, 60);
    const [h, , s] = token.split('.');
    const forged = `${h}.${btoa(JSON.stringify({ sub: 'admin' })).replace(/=+$/, '')}.${s}`;
    expect(await verifyJwt(forged, SECRET)).toBeNull();
  });

  it('过期的 token 会被拒绝', async () => {
    const token = await signJwt({ sub: 'p1' }, SECRET, -10);
    expect(await verifyJwt(token, SECRET)).toBeNull();
  });

  it('格式不对的 token 不会抛异常', async () => {
    expect(await verifyJwt('not-a-jwt', SECRET)).toBeNull();
    expect(await verifyJwt('a.b.c', SECRET)).toBeNull();
  });
});

describe('ULID', () => {
  it('长度固定且按时间有序', () => {
    const a = ulid(1_000_000_000_000);
    const b = ulid(1_000_000_001_000);
    expect(a).toHaveLength(26);
    expect(a < b).toBe(true);
  });

  it('能还原出时间戳', () => {
    const ts = 1_700_000_000_000;
    expect(ulidTime(ulid(ts))).toBe(ts);
  });

  it('同一毫秒内也不会重复', () => {
    const ids = new Set(Array.from({ length: 500 }, () => ulid(123)));
    expect(ids.size).toBe(500);
  });
});

describe('handle 生成', () => {
  it('中文和空格都能转成可用的 handle', () => {
    expect(slugify('张三 的小号', 'fallback')).toBe('张三-的小号');
    expect(slugify('Alice Smith', 'fallback')).toBe('alice-smith');
    expect(slugify('!!!', 'fallback')).toBe('fallback');
  });
});

describe('Elo', () => {
  it('赢棋涨分、输棋掉分，且总分守恒', () => {
    const [a, b] = eloUpdate(1500, 1500, 1);
    expect(a).toBeGreaterThan(1500);
    expect(b).toBeLessThan(1500);
    expect(a + b).toBeCloseTo(3000, 6);
  });

  it('平局时高分方掉分', () => {
    const [a, b] = eloUpdate(1700, 1400, 0.5);
    expect(a).toBeLessThan(1700);
    expect(b).toBeGreaterThan(1400);
  });

  it('赢弱者涨得少，赢强者涨得多', () => {
    const [weak] = eloUpdate(1500, 1100, 1);
    const [strong] = eloUpdate(1500, 1900, 1);
    expect(strong - 1500).toBeGreaterThan(weak - 1500);
  });
});

describe('排行榜时间窗', () => {
  it('一局同时进总榜、日榜和周榜', () => {
    const keys = windowKeys(Date.UTC(2026, 8, 22, 10, 0, 0));
    expect(keys[0]).toBe('all');
    expect(keys[1]).toBe('daily:2026-09-22');
    expect(keys[2]).toMatch(/^weekly:2026-W\d{2}$/);
  });
});

describe('反作弊判定', () => {
  const g2048 = getGame('2048');
  const snake = getGame('snake');

  const jitter = (n: number, base = 400) =>
    Array.from({ length: n }, (_, i) => base + ((i * 137) % 900));

  it('正常的人类节奏不会被标记', () => {
    const steps = jitter(120);
    const total = steps.reduce((a, b) => a + b, 0);
    expect(suspicious(g2048, steps.length, total, steps)).toBe(false);
  });

  it('整局用时短到不可能是人操作的会被标记', () => {
    expect(suspicious(g2048, 200, 500, [])).toBe(true);
  });

  it('步与步之间过于均匀会被标记', () => {
    const steps = new Array(120).fill(300);
    expect(suspicious(g2048, steps.length, 36_000, steps)).toBe(true);
  });

  it('步数很少时不做判定，避免误伤', () => {
    expect(suspicious(g2048, 5, 100, [20, 20, 20, 20, 20])).toBe(false);
  });

  it('自动推进的游戏（贪吃蛇）不做节奏判定', () => {
    const steps = new Array(120).fill(220);
    const total = steps.reduce((a, b) => a + b, 0);
    expect(suspicious(snake, steps.length, total, steps)).toBe(false);
  });

  it('自动推进的游戏如果跑得比 tick 还快，仍然会被标记', () => {
    expect(suspicious(snake, 200, 1000, [])).toBe(true);
  });
});

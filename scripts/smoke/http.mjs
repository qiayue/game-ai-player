/**
 * 端到端冒烟：对着本地 `wrangler dev` 跑真实的 HTTP 流程。
 *
 *   npm run build && npm run dev     # 另开一个终端
 *   npm run smoke
 *
 * 游戏内核直接从构建产物里引，所以这个脚本不需要 TypeScript 运行时。
 */
import { readdir } from 'node:fs/promises';

const GAMES = {};
for (const f of await readdir(new URL('../../apps/web/public/assets/games/', import.meta.url))) {
  if (!f.endsWith('.js')) continue;
  const mod = await import(new URL(`../../apps/web/public/assets/games/${f}`, import.meta.url));
  GAMES[mod.game.id] = mod.game;
  Object.assign(globalThis, { __hashState: mod.hashState, __validate: mod.validate });
}
const hashState = globalThis.__hashState;
const validate = globalThis.__validate;
/** 挑走法用不着确定性，普通随机就够 */
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const BASE = 'http://127.0.0.1:8787';
const SECRET = 'dev-only-secret-change-me';
const PLAYER = '01TESTPLAYER0000000000000';

let pass = 0, fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}

// ---- 用 dev 密钥自己签一个 session cookie（不给代码开任何后门） ----
const b64url = (buf) => Buffer.from(buf).toString('base64url');
async function signJwt(payload, ttl) {
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + ttl };
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const data = `${head}.${b64url(JSON.stringify(body))}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return `${data}.${b64url(new Uint8Array(sig))}`;
}

const session = await signJwt(
  { sub: PLAYER, h: 'tester', n: '冒烟测试员', a: null, adm: 0, ver: 0 }, 3600);
const authHeaders = { Cookie: `gap_session=${session}`, 'Content-Type': 'application/json' };

// ---------------------------------------------------------- 页面
console.log('\n[页面]');
for (const [path, must] of [
  ['/', ['2048', '五子棋', '全部游戏']],
  ['/games/2048', ['滑块游戏', 'models-data', '开始游戏', 'application/ld+json']],
  ['/games/minesweeper', ['扫雷', '第一次翻开']],
  ['/games/2048/leaderboard', ['排行榜']],
  ['/games/2048/ai', ['AI 录像']],
  ['/models', ['模型横评', '守规率']],
  ['/sitemap.xml', ['sitemapindex']],
  ['/sitemap-pages.xml', ['/games/2048']],
  ['/robots.txt', ['Sitemap:']],
  ['/p/tester', ['冒烟测试员']],
]) {
  const res = await fetch(BASE + path);
  const text = await res.text();
  const missing = must.filter((m) => !text.includes(m));
  check(`${path} → ${res.status}`, res.ok && !missing.length, missing.length ? `缺少 ${missing}` : '');
}

const res404 = await fetch(BASE + '/games/nope');
check('未知游戏返回 404', res404.status === 404);

// ---------------------------------------------------------- 模型列表缓存
console.log('\n[模型列表与缓存]');
const m1 = await fetch(BASE + '/api/models');
const mj = await m1.json();
const etag = m1.headers.get('ETag');
check('返回可用模型', Array.isArray(mj.models) && mj.models.length > 0);
check('带 ETag', !!etag);
check('带成本预估', typeof mj.estimates?.['2048'] === 'object');
const m2 = await fetch(BASE + '/api/models', { headers: { 'If-None-Match': etag } });
check('条件请求命中 304', m2.status === 304);

// ---------------------------------------------------------- 完整对局
console.log('\n[完整对局：开局 → 玩完 → 校验 → 上榜]');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function playFull(gameId, { authed = true, realistic = false } = {}) {
  const def = GAMES[gameId];
  const start = await (await fetch(`${BASE}/api/matches`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gameId }),
  })).json();

  const seed = start.seed;
  const moves = [], stepMs = [];

  if (start.stepwise) {
    // 隐藏信息游戏：逐步提交，服务端每次重放出可见视图
    let view = start.state, guard = 0;
    while (guard++ < 120) {
      const legal = def.legalMoves(view);
      if (!legal.length) break;
      const m = pick(legal);
      moves.push(m); stepMs.push(300 + Math.floor(Math.random() * 500));
      const step = await (await fetch(`${BASE}/api/matches/${start.matchId}/step`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticket: start.ticket, moves }),
      })).json();
      if (step.error) return { error: step.error };
      view = step.state;
      if (step.terminal) break;
    }
    const finish = await fetch(`${BASE}/api/matches/${start.matchId}/finish`, {
      method: 'POST', headers: authed ? authHeaders : { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket: start.ticket, moves, stepMs, durationMs: stepMs.reduce((a, b) => a + b, 0) }),
    });
    return { start, body: await finish.json(), status: finish.status, moves };
  }

  let s = def.init(seed);
  while (!def.isTerminal(s) && moves.length < def.maxPlies) {
    const legal = def.legalMoves(s);
    if (!legal.length) break;
    const m = pick(legal);
    moves.push(m); stepMs.push(300 + Math.floor(Math.random() * 500));
    s = def.reduce(s, m, seed);
  }
  // 服务端会把 durationMs 夹在「真实经过的时间 + 5 秒」以内，
  // 所以要测正常上榜的路径就必须真的等一会儿，不能秒交
  if (realistic) await sleep(Math.min(8000, moves.length * 40 + 2000));
  const finish = await fetch(`${BASE}/api/matches/${start.matchId}/finish`, {
    method: 'POST', headers: authed ? authHeaders : { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ticket: start.ticket, moves, stepMs,
      durationMs: stepMs.reduce((a, b) => a + b, 0), finalHash: hashState(s),
    }),
  });
  return { start, body: await finish.json(), status: finish.status, moves, final: s };
}

const r2048 = await playFull('2048', { realistic: true });
check('2048 终局落库', r2048.status === 200 && r2048.body.moves === r2048.moves.length,
  JSON.stringify(r2048.body).slice(0, 200));
check('2048 拿到分数与名次', r2048.body.score > 0 && r2048.body.rank >= 1, JSON.stringify(r2048.body));
check('2048 返回了是否个人最好成绩', typeof r2048.body.personalBest === 'boolean');
check('2048 没有被误判为作弊', r2048.body.flagged === false);

const rMine = await playFull('minesweeper');
check('扫雷（信息不完全）逐步提交后可以结算', rMine.status === 200,
  JSON.stringify(rMine.body).slice(0, 200));

const rAnon = await playFull('connect4', { authed: false });
check('未登录也能拿到成绩（但不落库）', rAnon.status === 200 && rAnon.body.rank === null);

// ---- 幂等 ----
const again = await fetch(`${BASE}/api/matches/${r2048.start.matchId}/finish`, {
  method: 'POST', headers: authHeaders,
  body: JSON.stringify({ ticket: r2048.start.ticket, moves: r2048.moves, stepMs: [], durationMs: 60000 }),
});
const againBody = await again.json();
check('重复提交同一局是幂等的，不重复计分', again.status === 200 && againBody.rank === null);

// ---- 反作弊与校验 ----
console.log('\n[校验与反作弊]');
const bad = await fetch(`${BASE}/api/matches`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ gameId: 'tictactoe' }),
});
const badStart = await bad.json();
const badFinish = await fetch(`${BASE}/api/matches/${badStart.matchId}/finish`, {
  method: 'POST', headers: authHeaders,
  body: JSON.stringify({ ticket: badStart.ticket, moves: [0, 0, 1], stepMs: [500, 500, 500], durationMs: 1500 }),
});
check('非法走法序列被拒绝', badFinish.status === 400);

const noTicket = await fetch(`${BASE}/api/matches/x/finish`, {
  method: 'POST', headers: authHeaders, body: JSON.stringify({ moves: [], stepMs: [], durationMs: 1 }),
});
check('没有票据不能提交', noTicket.status === 400);

const forged = await fetch(`${BASE}/api/matches/${badStart.matchId}/finish`, {
  method: 'POST', headers: authHeaders,
  body: JSON.stringify({ ticket: badStart.ticket.slice(0, -4) + 'AAAA', moves: [], stepMs: [], durationMs: 1 }),
});
check('伪造的票据被拒绝', forged.status === 400);

// 机器人节奏：整局用时远低于人类可能
const botStart = await (await fetch(`${BASE}/api/matches`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ gameId: '2048' }),
})).json();
{
  const def = GAMES['2048'];
  
  let s = def.init(botStart.seed); const mv = [];
  while (!def.isTerminal(s) && mv.length < 300) {
    const legal = def.legalMoves(s); if (!legal.length) break;
    const m = pick(legal); mv.push(m); s = def.reduce(s, m, botStart.seed);
  }
  const botFinish = await (await fetch(`${BASE}/api/matches/${botStart.matchId}/finish`, {
    method: 'POST', headers: authHeaders,
    body: JSON.stringify({ ticket: botStart.ticket, moves: mv, stepMs: new Array(mv.length).fill(2), durationMs: mv.length * 2 }),
  })).json();
  check('脚本速度的对局被标记且不上榜', botFinish.flagged === true && botFinish.rank === null);
}

// ---------------------------------------------------------- 排行榜与回放
console.log('\n[排行榜与回放]');
const lb = await (await fetch(`${BASE}/api/leaderboards/2048?track=human`)).json();
check('排行榜里能看到刚才的成绩', lb.rows.some((r) => r.playerId === PLAYER), JSON.stringify(lb.rows).slice(0, 200));
check('排行榜带上了玩家名（免 join）', lb.rows[0]?.displayName === '冒烟测试员');

const replay = await (await fetch(`${BASE}/api/replays/${r2048.start.matchId}`)).json();
check('回放包存在且走法数一致', replay.moves?.length === r2048.moves.length);
const revalidated = validate(GAMES['2048'], replay.seed, replay.moves);
check('回放包能被独立重放出同样的终局', revalidated.ok && revalidated.state.score === r2048.body.score);

const replayPage = await fetch(`${BASE}/replay/${r2048.start.matchId}`);
const replayHtml = await replayPage.text();
check('回放页返回 HTML 且含叙述文字', replayPage.ok && replayHtml.includes('冒烟测试员') && replayHtml.includes('replay-data'));
check('普通人类对局的回放页不被索引', replayHtml.includes('noindex'));

const meLb = await (await fetch(`${BASE}/api/leaderboards/2048/me`, { headers: authHeaders })).json();
check('能查到自己的最好成绩与名次', meLb.best?.bestScore > 0 && meLb.rank === 1);

// ---------------------------------------------------------- 权限
console.log('\n[权限]');
const noAuthRun = await fetch(`${BASE}/api/ai-runs`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ gameId: '2048', modelKey: 'anthropic/claude-haiku-4.5' }),
});
check('未登录不能发起 AI 录制', noAuthRun.status === 401);

const notAdmin = await fetch(`${BASE}/api/admin/models`, { headers: authHeaders });
check('普通用户不能访问管理接口', notAdmin.status === 401);

const csrf = await fetch(`${BASE}/api/matches`, {
  method: 'POST', headers: { ...authHeaders, Origin: 'https://evil.example' },
  body: JSON.stringify({ gameId: '2048' }),
});
check('跨站来源的写请求被拒绝', csrf.status === 403);

console.log(`\n通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);

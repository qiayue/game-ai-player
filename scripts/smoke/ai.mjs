/**
 * AI 录制全链路冒烟：DO alarm 循环 → 非法走法重试 → R2 → Queue → D1 → 排行榜 → 回放页。
 *
 * 不需要真的调模型，也不花钱：
 *   npm run mock:openrouter          # 另开一个终端
 * 并在 .dev.vars 里设：
 *   OPENROUTER_API_KEY=mock-key
 *   AI_GATEWAY_URL=http://127.0.0.1:9911/api/v1
 * 然后 npm run dev，最后 npm run smoke:ai
 *
 * 可以传一个玩家 id 作为参数，避开每日配额：node scripts/smoke/ai.mjs <playerId>
 */
const BASE = 'http://127.0.0.1:8787';
const SECRET = 'dev-only-secret-change-me';
const PLAYER = process.argv[2] ?? '01TESTPLAYER0000000000000';

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64url = (b) => Buffer.from(b).toString('base64url');

async function signJwt(payload, ttl) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const data = `${head}.${b64url(JSON.stringify({ ...payload, iat: now, exp: now + ttl }))}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return `${data}.${b64url(new Uint8Array(sig))}`;
}

const session = await signJwt({ sub: PLAYER, h: 'tester', n: '冒烟测试员', a: null, adm: 0, ver: 0 }, 3600);
const H = { Cookie: `gap_session=${session}`, 'Content-Type': 'application/json' };

console.log('\n[AI 录制：井字棋]');
const create = await fetch(`${BASE}/api/ai-runs`, {
  method: 'POST', headers: H,
  body: JSON.stringify({ gameId: 'tictactoe', modelKey: 'anthropic/claude-haiku-4.5' }),
});
const run = await create.json();
check('创建录制任务并立即返回 runId', create.status === 200 && !!run.runId, JSON.stringify(run));
check('返回了成本预估', typeof run.estimateUsd === 'number');
if (!run.runId) process.exit(1);

let status = null;
for (let i = 0; i < 40; i++) {
  await sleep(500);
  status = await (await fetch(`${BASE}/api/ai-runs/${run.runId}`)).json();
  if (i === 1) check('进行中可以轮询到实时局面', status.state !== null || status.status !== 'running');
  if (status.status !== 'running' && status.status !== 'queued') break;
}
check('录制跑完', status?.status === 'finished', JSON.stringify(status).slice(0, 300));
check('走了若干步', (status?.ply ?? 0) > 0);
check('累计了成本', (status?.costUsd ?? 0) > 0);
check('记录了非法走法重试（mock 故意给了一次非法）', (status?.illegalMoves ?? 0) >= 1);
check('拿到了 matchId', !!status?.matchId);

// D1 还没写进来时，回放页要能靠 R2 兜底打开
const early = await fetch(`${BASE}/replay/${status.matchId}`);
const earlyHtml = await early.text();
check('结算完成前回放页也能打开（从 R2 兜底）', early.ok && earlyHtml.includes('replay-data'), String(early.status));
check('结算中的回放页明确提示还在结算', earlyHtml.includes('正在结算'));

// Queue consumer 是异步的，等它把 D1 写完
await sleep(9000);

console.log('\n[落库与回放]');
const replay = await fetch(`${BASE}/api/replays/${status.matchId}`);
const pkg = await replay.json();
check('回放包已写入 R2', replay.ok && Array.isArray(pkg.moves), JSON.stringify(pkg).slice(0, 200));
check('回放包里记录了两个座位', pkg.players?.length === 2);

const step0 = await fetch(`${BASE}/api/replays/${status.matchId}/ai/0`);
const rec = await step0.json();
check('第 0 步的 AI 明细已写入 R2', step0.ok && typeof rec.prompt === 'string');
check('明细里存了完整提示词与原始回复', rec.prompt.includes('LEGAL MOVES') && rec.response.includes('MOVE:'));
check('明细里存了推理文本', typeof rec.thought === 'string' && rec.thought.length > 0);
check('明细里存了 token 与延迟', rec.inputTokens > 0 && rec.latencyMs >= 0);

const page = await fetch(`${BASE}/replay/${status.matchId}`);
const html = await page.text();
check('回放页能渲染这局 AI 录像', page.ok && html.includes('replay-data') && html.includes('次模型调用'));
check('回放页写出了叙述文字', html.includes('通过 OpenRouter 驱动'));

const runs = await (await fetch(`${BASE}/api/ai-runs`, { headers: H })).json();
check('能列出自己发起的录制', runs.runs?.some((r) => r.runId === run.runId));
const mine = runs.runs.find((r) => r.runId === run.runId);
check('ai_runs 行已更新为 finished 并关联 matchId', mine?.status === 'finished' && mine?.matchId === status.matchId,
  JSON.stringify(mine));

const lb = await (await fetch(`${BASE}/api/leaderboards/tictactoe?track=ai`)).json();
check('AI 赛道排行榜里出现了这个模型', (lb.rows ?? []).length > 0, JSON.stringify(lb).slice(0, 200));
check('双人游戏用 Elo 评分', lb.rows?.[0]?.rating != null && lb.rows[0].bestScore !== 0);

const aiList = await fetch(`${BASE}/games/tictactoe/ai`);
const aiHtml = await aiList.text();
check('AI 录像列表页能看到这局', aiList.ok && aiHtml.includes(status.matchId.slice(0, 10)));

console.log('\n[配额]');
const overflow = [];
for (let i = 0; i < 11; i++) {
  const r = await fetch(`${BASE}/api/ai-runs`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ gameId: 'tictactoe', modelKey: 'anthropic/claude-haiku-4.5' }),
  });
  overflow.push(r.status);
  if (r.status === 429) break;
}
check('超过每日次数后返回 429', overflow.includes(429), JSON.stringify(overflow));

console.log(`\n通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);

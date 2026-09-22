import type { Context } from 'hono';
import type { Env, Vars } from '../env.js';
import { getGame } from '@gap/games';
import { copyFor } from '../content/games.js';
import { renderPage, esc, breadcrumb, jsonScript, fmtDuration, fmtDate, fmtNumber } from './layout.js';
import { notFound, cacheHeaders, param } from '../util/http.js';
import * as repo from '../repo.js';
import * as storage from '../storage.js';

/**
 * 回放页。
 *
 * 这是全站 SEO 价值最高的页面：HTML 里直接写出这一局的叙述
 *（哪个模型、多少分、多少步、有没有犯规），而页面数量会随录像自然增长。
 * 但只有「精选」的录像才发 index，否则几万个雷同页面会被判低质量。
 */
export async function replayPage(c: Context<{ Bindings: Env; Variables: Vars }>): Promise<Response> {
  const env = c.env;
  const matchId = param(c, 'matchId');
  const [bundle, pkg] = await Promise.all([
    repo.getMatch(env, matchId),
    storage.getReplay(env, matchId).catch(() => null),
  ]);
  // 终局时先写 R2、再由 Queue 批量写 D1，所以刚跑完的几秒里 D1 可能还没有这一行。
  // 这时直接用 R2 里的回放包渲染，页面不会 404，只是暂时不进索引。
  if (!bundle && !pkg) throw notFound('没有这局对局');
  const settling = !bundle;
  const { match, players } = bundle ?? fromPackage(pkg!);
  const def = getGame(match.game_id);
  const copy = copyFor(match.game_id);
  const people = settling ? new Map() : await repo.getPlayersByIds(env, players.map((p) => p.player_id));

  const seat0 = players[0];
  const who = seat0 ? people.get(seat0.player_id) : undefined;
  const isAi = seat0?.is_ai === 1;
  const name = who?.display_name
    ?? pkg?.players.find((p) => p.seat === 0)?.displayName
    ?? (isAi ? seat0?.model_key ?? 'AI' : '匿名玩家');

  const totalCalls = players.reduce((n, p) => n + (p.ai_calls ?? 0), 0);
  const totalIllegal = players.reduce((n, p) => n + (p.ai_illegal_moves ?? 0), 0);
  const avgLatency = totalCalls ? Math.round(players.reduce((n, p) => n + (p.ai_latency_ms_sum ?? 0), 0) / totalCalls) : 0;

  const reasonText: Record<string, string> = {
    terminal: '正常终局',
    illegal_move: '连续三次给出非法走法，判定结束',
    ply_limit: '达到步数上限',
    cost_limit: '达到成本上限',
    aborted: '中途被中止',
    abandoned: '中途放弃',
    stalled: '任务卡住被终止',
    model_error: '模型调用连续失败',
  };

  // 这一段叙述是搜索引擎实际会读到的内容
  const narrative = isAi
    ? `${name} 通过 OpenRouter 驱动，在${def.name}里自主走了 ${match.moves_count} 步，`
      + `${def.players === 1 ? `最终得分 ${fmtNumber(match.score ?? 0)}` : `结果为${seat0?.result === 'win' ? '获胜' : seat0?.result === 'draw' ? '平局' : '落败'}`}。`
      + `全程耗时 ${fmtDuration(match.duration_ms ?? 0)}，共调用模型 ${totalCalls} 次，`
      + `平均每步 ${(avgLatency / 1000).toFixed(1)} 秒，${totalIllegal ? `其中 ${totalIllegal} 次给出了非法走法需要重试` : '没有出现一次非法走法'}。`
      + `结束原因：${reasonText[match.ended_reason ?? ''] ?? match.ended_reason ?? '未知'}。`
    : `${name} 在${def.name}里走了 ${match.moves_count} 步，`
      + `${def.players === 1 ? `得分 ${fmtNumber(match.score ?? 0)}` : '完成了一局对弈'}，`
      + `用时 ${fmtDuration(match.duration_ms ?? 0)}。`;

  const resultWord = seat0?.result === 'win' ? '获胜' : seat0?.result === 'draw' ? '平局' : seat0?.result === 'loss' ? '落败' : '—';
  const headline = def.players === 2 ? resultWord : fmtNumber(match.score ?? 0);

  const body = `
<nav class="small muted"><a href="/">首页</a> / <a href="/games/${esc(match.game_id)}">${esc(def.name)}</a> / 回放</nav>
<h1>${esc(name)} 玩${esc(def.name)}${def.players === 1 ? ` · ${fmtNumber(match.score ?? 0)} 分` : ''}</h1>
<p class="lede">${esc(narrative)}</p>

<div class="stat">
  <div><b>${headline}</b><span>${def.players === 2 ? '结果' : '分数'}</span></div>
  <div><b>${match.moves_count}</b><span>步</span></div>
  <div><b>${fmtDuration(match.duration_ms ?? 0)}</b><span>用时</span></div>
  ${isAi ? `<div><b>${totalCalls}</b><span>次模型调用</span></div>
  <div><b>${totalIllegal}</b><span>次非法走法</span></div>` : ''}
  <div><b>${fmtDate(match.ended_at)}</b><span>日期</span></div>
</div>

${settling ? '<p class="notice">这局刚刚跑完，成绩正在结算，排行榜稍后更新。回放已经可以看了。</p>' : ''}
${pkg ? `
<div id="replay" data-game="${esc(match.game_id)}" data-match="${esc(matchId)}" data-ai="${isAi ? '1' : '0'}">
  <div id="replay-board"></div>
  <div class="player-bar">
    <button id="rp-first" title="回到开头">⏮</button>
    <button id="rp-prev" title="上一步">◀</button>
    <button id="rp-play" class="primary">播放</button>
    <button id="rp-next" title="下一步">▶</button>
    <input type="range" id="rp-slider" min="0" max="${pkg.moves.length}" value="0">
    <span class="mono small" id="rp-label">0 / ${pkg.moves.length}</span>
  </div>
  ${isAi ? '<h2>AI 当时在想什么</h2><div class="thought" id="rp-thought">选一步看看模型的推理。</div><details id="rp-prompt-wrap"><summary>看这一步完整的提示词与原始回复</summary><pre class="prompt" id="rp-prompt"></pre></details>' : ''}
</div>
${jsonScript('replay-data', pkg)}
` : '<p class="notice">这局的回放数据还在生成中，稍后刷新试试。</p>'}

<h2>关于${esc(def.name)}</h2>
<p>${esc(copy.intro)}</p>
<p><a href="/games/${esc(match.game_id)}">自己玩一局 →</a> · <a href="/games/${esc(match.game_id)}/leaderboard">看排行榜 →</a></p>
`;

  const html = renderPage(env, {
    title: `${name} 玩${def.name}${def.players === 1 ? ` · ${fmtNumber(match.score ?? 0)} 分` : ''} · 完整回放`,
    description: narrative.slice(0, 155),
    path: `/replay/${matchId}`,
    user: c.get('user'),
    body,
    // 只有精选录像才允许收录，避免大量雷同页面拖低站点质量
    robots: !settling && match.indexable === 1 ? undefined : 'noindex,follow',
    keywords: copy.keywords,
    scripts: pkg ? '<script type="module" src="/assets/replay.js"></script>' : '',
    jsonLd: [
      breadcrumb(env, [
        { name: '首页', path: '/' },
        { name: def.name, path: `/games/${match.game_id}` },
        { name: '回放', path: `/replay/${matchId}` },
      ]),
      {
        '@context': 'https://schema.org',
        '@type': 'CreativeWork',
        name: `${name} 玩${def.name}`,
        description: narrative,
        dateCreated: new Date(match.ended_at).toISOString(),
        about: { '@type': 'VideoGame', name: def.name, url: `${env.SITE_URL}/games/${match.game_id}` },
      },
    ],
  });
  // 已结束的对局不会再变，可以放心长缓存；还在结算的则只缓存几秒
  return c.html(
    html, 200,
    !settling && match.status === 'finished'
      ? { 'Cache-Control': 'public, max-age=600, s-maxage=86400' }
      : cacheHeaders(5, 10),
  );
}

/** D1 还没写进来时，用 R2 里的回放包拼出页面需要的那部分数据 */
function fromPackage(pkg: NonNullable<Awaited<ReturnType<typeof storage.getReplay>>>): {
  match: repo.MatchRow;
  players: repo.MatchPlayerRow[];
} {
  return {
    match: {
      id: pkg.matchId, game_id: pkg.gameId, mode: pkg.players.length > 1 ? 'versus' : 'single',
      track: pkg.track, seed: pkg.seed, ruleset_ver: 1, status: pkg.status,
      ended_reason: pkg.endedReason, score: pkg.score, result: null,
      moves_count: pkg.movesCount, duration_ms: pkg.durationMs, final_hash: null,
      ai_run_id: null, indexable: 0, started_at: pkg.startedAt, ended_at: pkg.endedAt,
    },
    players: pkg.players.map((p) => ({
      match_id: pkg.matchId, seat: p.seat, player_id: p.playerId, is_ai: p.isAi ? 1 : 0,
      model_key: p.modelKey, score: p.score ?? null, result: p.result,
      ai_calls: p.aiCalls ?? 0, ai_illegal_moves: p.aiIllegalMoves ?? 0,
      ai_input_tokens: 0, ai_output_tokens: 0,
      ai_cost_usd: p.aiCostUsd ?? 0, ai_latency_ms_sum: p.aiLatencyMsSum ?? 0,
    })),
  };
}

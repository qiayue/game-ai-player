import type { Context } from 'hono';
import type { Env, Vars } from '../env.js';
import type { Track } from '@gap/shared';
import { getGame } from '@gap/games';
import { copyFor } from '../content/games.js';
import { renderPage, esc, breadcrumb, fmtNumber } from './layout.js';
import { getLeaderboard } from '../leaderboard.js';
import { parseTrack, parseWindow } from '../routes/leaderboards.js';
import { cacheHeaders, notFound, param } from '../util/http.js';
import * as repo from '../repo.js';

export async function leaderboardPage(c: Context<{ Bindings: Env; Variables: Vars }>): Promise<Response> {
  const env = c.env;
  const gameId = param(c, 'gameId');
  let def;
  try {
    def = getGame(gameId);
  } catch {
    throw notFound('没有这个游戏');
  }
  const copy = copyFor(gameId);
  const track = parseTrack(c.req.query('track'));
  const windowKey = parseWindow(c.req.query('window') ?? 'all');
  const data = await getLeaderboard(env, gameId, track, windowKey);

  const tab = (t: Track, w: string, label: string) => {
    const href = `/games/${gameId}/leaderboard?track=${t}&window=${w}`;
    const active = t === track && (windowKey === w || (w === 'all' && windowKey === 'all'));
    return `<a href="${esc(href)}"${active ? ' aria-current="page"' : ''}>${esc(label)}</a>`;
  };

  const rows = data.rows.length
    ? data.rows.map((r) => `<tr>
<td class="rank${r.rank <= 3 ? ' top' : ''}">${r.rank}</td>
<td><a href="/p/${esc(r.handle)}">${esc(r.displayName)}</a>${r.modelKey ? ` <span class="badge ai">AI</span>` : ''}</td>
<td class="num">${fmtNumber(r.bestScore)}</td>
<td class="num">${r.plays}</td>
<td class="num small"><a href="/replay/${esc(r.bestMatch)}">回放</a></td>
</tr>`).join('')
    : `<tr><td colspan="5" class="muted">这个榜还没有成绩。</td></tr>`;

  const body = `
<nav class="small muted"><a href="/">首页</a> / <a href="/games/${esc(gameId)}">${esc(def.name)}</a> / 排行榜</nav>
<h1>${esc(def.name)}排行榜</h1>
<p class="lede">${esc(def.players === 2 ? '双人游戏用 Elo 评分排名，人类和 AI 分开计算。' : '按单局最高分排名，同分时用时更短的排在前面。')}</p>
<div class="tabs">
${tab('human', 'all', '人类 · 总榜')}${tab('ai', 'all', 'AI · 总榜')}
${tab('human', 'weekly', '人类 · 本周')}${tab('ai', 'weekly', 'AI · 本周')}
</div>
<table>
<thead><tr><th class="rank">#</th><th>玩家</th><th class="num">${def.players === 2 ? '评分' : '最高分'}</th><th class="num">局数</th><th></th></tr></thead>
<tbody>${rows}</tbody>
</table>
<p class="small muted">更新于 ${new Date(data.updatedAt).toISOString().replace('T', ' ').slice(0, 16)} UTC · 榜单每分钟重建一次</p>
<h2>关于${esc(def.name)}</h2>
<p>${esc(copy.intro)}</p>
<p><a href="/games/${esc(gameId)}">去玩一局 →</a></p>
`;

  const html = renderPage(env, {
    title: `${def.name}排行榜 · ${track === 'ai' ? 'AI 模型' : '人类玩家'}成绩`,
    description: `${def.name}的${track === 'ai' ? 'AI 模型' : '人类玩家'}排行榜，每条成绩都可以点开完整回放。${copy.description.slice(0, 60)}`,
    path: `/games/${gameId}/leaderboard`,
    user: c.get('user'),
    body,
    keywords: [...copy.keywords, `${def.name}排行榜`],
    jsonLd: [
      breadcrumb(env, [
        { name: '首页', path: '/' },
        { name: def.name, path: `/games/${gameId}` },
        { name: '排行榜', path: `/games/${gameId}/leaderboard` },
      ]),
      {
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        name: `${def.name}排行榜`,
        itemListElement: data.rows.slice(0, 20).map((r) => ({
          '@type': 'ListItem',
          position: r.rank,
          name: r.displayName,
          url: `${env.SITE_URL}/replay/${r.bestMatch}`,
        })),
      },
    ],
  });
  return c.html(html, 200, cacheHeaders(60));
}

export async function aiRunsPage(c: Context<{ Bindings: Env; Variables: Vars }>): Promise<Response> {
  const env = c.env;
  const gameId = param(c, 'gameId');
  let def;
  try {
    def = getGame(gameId);
  } catch {
    throw notFound('没有这个游戏');
  }
  const copy = copyFor(gameId);
  const cursor = c.req.query('cursor') ?? undefined;
  const list = await repo.listAiMatches(env, gameId, cursor, 30);

  const rows = list.length
    ? list.map((m) => `<tr>
<td class="small mono">${esc(m.id.slice(0, 10))}</td>
<td>${m.handle ? `<a href="/p/${esc(m.handle)}">${esc(m.display_name ?? 'AI')}</a>` : esc(m.display_name ?? 'AI')}</td>
<td class="num">${fmtNumber(m.score ?? 0)}</td>
<td class="num">${m.moves_count}</td>
<td class="small">${esc(m.ended_reason ?? '')}</td>
<td class="small"><a href="/replay/${esc(m.id)}">回放</a></td>
</tr>`).join('')
    : '<tr><td colspan="6" class="muted">还没有 AI 录像。去游戏页点一下「开始录制」吧。</td></tr>';

  const body = `
<nav class="small muted"><a href="/">首页</a> / <a href="/games/${esc(gameId)}">${esc(def.name)}</a> / AI 录像</nav>
<h1>${esc(def.name)}的 AI 录像</h1>
<p class="lede">${esc(copy.aiNote)}</p>
<table>
<thead><tr><th>对局</th><th>模型</th><th class="num">分数</th><th class="num">步数</th><th>结束原因</th><th></th></tr></thead>
<tbody>${rows}</tbody>
</table>
${list.length >= 30 ? `<p><a href="/games/${esc(gameId)}/ai?cursor=${esc(list[list.length - 1].id)}">下一页 →</a></p>` : ''}
<p><a href="/games/${esc(gameId)}">回到${esc(def.name)} →</a></p>
`;

  return c.html(
    renderPage(env, {
      title: `${def.name} AI 录像 · 各家模型实战记录`,
      description: `各个 AI 模型玩${def.name}的完整录像，每一局都能逐步回放并查看模型每一步的推理。`,
      path: `/games/${gameId}/ai`,
      user: c.get('user'),
      body,
      keywords: [...copy.keywords, `AI 玩${def.name}`],
      jsonLd: [breadcrumb(env, [
        { name: '首页', path: '/' },
        { name: def.name, path: `/games/${gameId}` },
        { name: 'AI 录像', path: `/games/${gameId}/ai` },
      ])],
    }),
    200,
    cacheHeaders(300),
  );
}

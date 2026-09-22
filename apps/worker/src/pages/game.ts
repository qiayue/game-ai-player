import type { Context } from 'hono';
import type { Env, Vars } from '../env.js';
import { getGame } from '@gap/games';
import { copyFor } from '../content/games.js';
import { renderPage, esc, breadcrumb, jsonScript, fmtNumber } from './layout.js';
import { getLeaderboard } from '../leaderboard.js';
import { cachedModelPayload } from '../routes/models.js';
import { cacheHeaders, notFound, param } from '../util/http.js';
import * as repo from '../repo.js';
import { ESTIMATED_PLIES } from '../ai/estimate.js';

export async function gamePage(c: Context<{ Bindings: Env; Variables: Vars }>): Promise<Response> {
  const env = c.env;
  const gameId = param(c, 'gameId');
  let def;
  try {
    def = getGame(gameId);
  } catch {
    throw notFound('没有这个游戏');
  }
  const copy = copyFor(gameId);

  // 排行榜、模型列表、AI 录像三份数据都走缓存，正常情况下不落 SQL 排序
  const [human, ai, models, recent] = await Promise.all([
    getLeaderboard(env, gameId, 'human', 'all').catch(() => null),
    getLeaderboard(env, gameId, 'ai', 'all').catch(() => null),
    cachedModelPayload(env).catch(() => null),
    repo.listRecentMatches(env, { gameId, track: 'ai', limit: 5 }).catch(() => []),
  ]);

  const board = (rows: { rank: number; handle: string; displayName: string; bestScore: number; bestMatch: string }[] | undefined, empty: string) =>
    rows?.length
      ? `<table><thead><tr><th class="rank">#</th><th>玩家</th><th class="num">${def.players === 2 ? '评分' : '分数'}</th><th></th></tr></thead><tbody>${
          rows.slice(0, 10).map((r) =>
            `<tr><td class="rank${r.rank <= 3 ? ' top' : ''}">${r.rank}</td>
<td><a href="/p/${esc(r.handle)}">${esc(r.displayName)}</a></td>
<td class="num">${fmtNumber(r.bestScore)}</td>
<td class="num small"><a href="/replay/${esc(r.bestMatch)}">回放</a></td></tr>`,
          ).join('')
        }</tbody></table>`
      : `<p class="muted small">${empty}</p>`;

  const modelOptions = (models?.models ?? [])
    .filter((m) => {
      const est = models?.estimates?.[gameId]?.[m.key];
      return est !== undefined;
    })
    .map((m) => {
      const est = models?.estimates?.[gameId]?.[m.key] ?? 0;
      return `<option value="${esc(m.key)}">${esc(m.displayName)} · 约 $${est.toFixed(3)}</option>`;
    }).join('');

  const body = `
<nav class="small muted"><a href="/">首页</a> / ${esc(def.name)}</nav>
<h1>${esc(def.name)}${def.players === 2 ? ' <span class="badge">双人</span>' : ''}${def.hiddenInfo ? ' <span class="badge">信息不完全</span>' : ''}</h1>
<p class="lede">${esc(copy.intro)}</p>

<div id="stage" data-game="${esc(gameId)}" data-stepwise="${def.hiddenInfo ? '1' : '0'}">
  <div class="row">
    <button id="play-btn" class="primary">开始游戏</button>
    <span id="hud" class="muted small"></span>
  </div>
  <div id="board-host"></div>
  <div id="play-msg" class="small"></div>
</div>

<div class="split">
<div>
<h2>怎么玩</h2>
<ul>${copy.howTo.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>

<h2>${esc(def.name)}技巧</h2>
${copy.tips.map((t) => `<h3>${esc(t.heading)}</h3><p>${esc(t.body)}</p>`).join('')}

<h2>让 AI 玩一局</h2>
<p>${esc(copy.aiNote)}</p>
<div class="card" id="ai-panel" data-game="${esc(gameId)}" data-plies="${ESTIMATED_PLIES[gameId] ?? 60}">
  <div class="row">
    <select id="model-select" aria-label="选择模型">${modelOptions || '<option value="">暂无可用模型</option>'}</select>
    ${def.players === 2 ? '<select id="opponent-select" aria-label="选择对手模型"><option value="">对手：同一个模型</option></select>' : ''}
    <button id="run-btn" class="primary"${modelOptions ? '' : ' disabled'}>开始录制</button>
  </div>
  <p class="small muted" id="run-hint">跑完一整局大约需要几分钟，期间可以离开页面。费用按实际调用计算。</p>
  <div id="run-progress" class="hidden">
    <div class="progress"><i style="width:0%"></i></div>
    <p class="small" id="run-status"></p>
    <div id="run-board"></div>
    <div class="thought" id="run-thought"></div>
    <button id="abort-btn" class="small">中止</button>
  </div>
</div>

<h2 class="faq">常见问题</h2>
${copy.faq.map((f) => `<h3>${esc(f.q)}</h3><p>${esc(f.a)}</p>`).join('')}
</div>

<aside>
<div class="sticky">
<h2 style="margin-top:0">人类榜</h2>
${board(human?.rows, '还没有人上榜，第一个就是你。')}
<h2>AI 榜</h2>
${board(ai?.rows, '还没有模型打过这个游戏。')}
<p class="small"><a href="/games/${esc(gameId)}/leaderboard">完整排行榜 →</a></p>
${recent.length ? `<h2>最近的 AI 录像</h2><ul class="small">${recent.map((m) =>
    `<li><a href="/replay/${esc(m.id)}">${fmtNumber(m.score ?? 0)} 分 · ${m.moves_count} 步</a></li>`,
  ).join('')}</ul><p class="small"><a href="/games/${esc(gameId)}/ai">全部录像 →</a></p>` : ''}
</div>
</aside>
</div>
`;

  const html = renderPage(env, {
    title: copy.title,
    description: copy.description,
    path: `/games/${gameId}`,
    user: c.get('user'),
    body,
    wide: true,
    keywords: copy.keywords,
    // 模型列表直接内联，首屏不需要任何额外请求；前端还会把它缓存进 localStorage
    head: models ? jsonScript('models-data', models) : '',
    jsonLd: [
      {
        '@context': 'https://schema.org',
        '@type': 'VideoGame',
        name: def.name,
        alternateName: def.nameEn,
        description: copy.description,
        url: `${env.SITE_URL}/games/${gameId}`,
        genre: '益智',
        playMode: def.players === 2 ? 'SinglePlayer' : 'SinglePlayer',
        applicationCategory: 'Game',
        operatingSystem: 'Web',
      },
      breadcrumb(env, [{ name: '首页', path: '/' }, { name: def.name, path: `/games/${gameId}` }]),
      {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: copy.faq.map((f) => ({
          '@type': 'Question',
          name: f.q,
          acceptedAnswer: { '@type': 'Answer', text: f.a },
        })),
      },
    ],
  });
  return c.html(html, 200, cacheHeaders(300));
}

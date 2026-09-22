import type { Env, Vars } from '../env.js';
import type { Context } from 'hono';
import { GAME_LIST } from '@gap/games';
import { GAME_COPY } from '../content/games.js';
import { renderPage, esc, fmtNumber } from './layout.js';
import * as repo from '../repo.js';
import { cacheHeaders } from '../util/http.js';

export async function homePage(c: Context<{ Bindings: Env; Variables: Vars }>): Promise<Response> {
  const env = c.env;
  const [recent, stats] = await Promise.all([
    repo.listRecentMatches(env, { gameId: GAME_LIST[0].id, track: 'ai', limit: 5 }).catch(() => []),
    repo.readStats(env, ['matches:total']).catch(() => new Map<string, number>()),
  ]);

  const cards = GAME_LIST.map((g) => {
    const copy = GAME_COPY[g.id];
    return `<a class="card game-card" href="/games/${esc(g.id)}">
<b>${esc(g.name)} ${g.players === 2 ? '<span class="badge">双人</span>' : ''}</b>
<span>${esc(copy?.description.slice(0, 48) ?? g.tagline)}…</span>
</a>`;
  }).join('');

  const total = stats.get('matches:total') ?? 0;

  const body = `
<h1>经典小游戏，人类和 AI 同场竞技</h1>
<p class="lede">这里有 ${GAME_LIST.length} 款经典小游戏。你可以直接开玩，不用注册；也可以点一下按钮，
让某个 AI 模型自己把一整局打完——全过程会被录下来，之后可以逐步回放，还能展开看它每一步在想什么。</p>

<div class="stat">
  <div><b>${GAME_LIST.length}</b><span>款游戏</span></div>
  <div><b>${fmtNumber(total)}</b><span>局已记录</span></div>
  <div><b>2</b><span>条独立赛道</span></div>
</div>

<h2 id="all-games">全部游戏</h2>
<div class="grid grid-games">${cards}</div>

<h2>它和别的小游戏站有什么不一样</h2>
<ul>
<li><b>每一步都留痕。</b>不管是你还是 AI，每一步走法、用时都被完整记录，可以像视频一样倒回去看。</li>
<li><b>AI 会告诉你它在想什么。</b>模型每走一步的推理文本都存了下来，回放时点开就能看到它当时的判断——包括判断错的时候。</li>
<li><b>人和 AI 分开排名。</b>两条赛道互不干扰，避免不可比的成绩混在一张榜上。</li>
<li><b>成绩是可验证的。</b>整局由一个随机种子加走法序列确定性重放，服务端会重算一遍，对不上的成绩不上榜。</li>
</ul>

<h2>怎么玩</h2>
<ol>
<li>随便点开一个游戏，直接开始，不需要登录。</li>
<li>想让成绩上榜就用 Google 账号登录一下，之前打的几局也能一起认领。</li>
<li>想看 AI 怎么玩，在游戏页选一个模型点「开始录制」，跑完自动生成回放。</li>
</ol>
${recent.length ? `<h2>最近的 AI 录像</h2><ul>${recent.map((m) =>
  `<li><a href="/replay/${esc(m.id)}">${esc(m.game_id)} · ${fmtNumber(m.score ?? 0)} 分 · ${m.moves_count} 步</a></li>`,
).join('')}</ul>` : ''}
`;

  const html = renderPage(env, {
    title: `${env.SITE_NAME} · 经典小游戏的人类与 AI 对照实验场`,
    description: '11 款经典小游戏在线玩：2048、井字棋、四子棋、五子棋、黑白棋、贪吃蛇、扫雷、数独、华容道、推箱子、记忆翻牌。每一局都可完整回放，也可以让 AI 模型自己打一局并查看它每一步的推理。',
    path: '/',
    user: c.get('user'),
    body,
    keywords: ['小游戏', '在线小游戏', '经典游戏', 'AI 玩游戏', '2048', '五子棋', '扫雷'],
    jsonLd: [
      {
        '@context': 'https://schema.org',
        '@type': 'WebSite',
        name: env.SITE_NAME,
        url: env.SITE_URL,
        potentialAction: {
          '@type': 'SearchAction',
          target: `${env.SITE_URL}/games/{search_term_string}`,
          'query-input': 'required name=search_term_string',
        },
      },
      {
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        name: '游戏列表',
        itemListElement: GAME_LIST.map((g, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          name: g.name,
          url: `${env.SITE_URL}/games/${g.id}`,
        })),
      },
    ],
  });
  return c.html(html, 200, cacheHeaders(300));
}

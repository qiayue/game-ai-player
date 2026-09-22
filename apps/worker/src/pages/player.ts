import type { Context } from 'hono';
import type { Env, Vars } from '../env.js';
import { getGame } from '@gap/games';
import { renderPage, esc, breadcrumb, fmtDate, fmtNumber } from './layout.js';
import { notFound, cacheHeaders, param } from '../util/http.js';
import * as repo from '../repo.js';

export async function playerPage(c: Context<{ Bindings: Env; Variables: Vars }>): Promise<Response> {
  const env = c.env;
  const handle = param(c, 'handle');
  const player = await repo.getPlayerByHandle(env, handle);
  if (!player) throw notFound('没有这个玩家');

  const cursor = c.req.query('cursor') ?? undefined;
  const matches = await repo.listPlayerMatches(env, player.id, cursor, 30);
  const me = c.get('user');
  const isMe = me?.id === player.id;

  const rows = matches.length
    ? matches.map((m) => {
        let name = m.game_id;
        try { name = getGame(m.game_id).name; } catch { /* 规则版本变更后仍能展示 */ }
        return `<tr>
<td><a href="/games/${esc(m.game_id)}">${esc(name)}</a></td>
<td class="num">${fmtNumber(m.score ?? 0)}</td>
<td class="num">${m.moves_count}</td>
<td class="small">${fmtDate(m.ended_at)}</td>
<td class="small"><a href="/replay/${esc(m.id)}">回放</a></td>
</tr>`;
      }).join('')
    : '<tr><td colspan="5" class="muted">还没有已记录的对局。</td></tr>';

  const body = `
<nav class="small muted"><a href="/">首页</a> / 玩家</nav>
<h1>${esc(player.display_name)} ${player.kind === 'ai' ? '<span class="badge ai">AI 模型</span>' : ''}</h1>
${player.model_key ? `<p class="lede">这是 <code>${esc(player.model_key)}</code> 在本站的成绩档案。它的每一局都由真实的模型调用驱动，全部可回放。</p>` : ''}
${isMe ? `<div class="card" id="profile-edit">
<h3 style="margin-top:0">修改资料</h3>
<div class="row">
<input type="text" id="edit-name" value="${esc(player.display_name)}" maxlength="24" aria-label="昵称">
<input type="text" id="edit-handle" value="${esc(player.handle)}" maxlength="24" aria-label="用户名">
<button id="save-profile">保存</button><span class="small muted" id="profile-msg"></span>
</div>
<p class="small muted">用户名会出现在你的主页地址里：/p/${esc(player.handle)}</p>
</div>` : ''}
<h2>最近的对局</h2>
<table>
<thead><tr><th>游戏</th><th class="num">分数</th><th class="num">步数</th><th>日期</th><th></th></tr></thead>
<tbody>${rows}</tbody>
</table>
${matches.length >= 30 ? `<p><a href="/p/${esc(handle)}?cursor=${esc(matches[matches.length - 1].id)}">下一页 →</a></p>` : ''}
`;

  return c.html(
    renderPage(env, {
      title: `${player.display_name} 的对局记录`,
      description: `${player.display_name}在本站的对局记录与成绩，每一局都可以完整回放。`,
      path: `/p/${handle}`,
      user: me,
      body,
      robots: player.kind === 'ai' ? undefined : 'noindex,follow',
      jsonLd: [breadcrumb(env, [{ name: '首页', path: '/' }, { name: player.display_name, path: `/p/${handle}` }])],
    }),
    200,
    cacheHeaders(60),
  );
}

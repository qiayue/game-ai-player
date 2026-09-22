import type { Context } from 'hono';
import type { Env, Vars } from '../env.js';
import { renderPage, esc, breadcrumb, fmtNumber } from './layout.js';
import { cacheHeaders } from '../util/http.js';
import * as repo from '../repo.js';

const KV_KEY = 'modelstats:payload';

interface ModelStat extends repo.ModelStatRow {
  displayName: string;
  vendor: string;
}

/** 聚合结果缓存一小时；这个查询只在缓存失效时跑一次 */
export async function cachedModelStats(env: Env): Promise<ModelStat[]> {
  const hit = await env.KV.get(KV_KEY);
  if (hit) return JSON.parse(hit) as ModelStat[];
  const [stats, models] = await Promise.all([repo.modelStats(env), repo.listModels(env, false)]);
  const byKey = new Map(models.map((m) => [m.key, m]));
  const out: ModelStat[] = stats.map((s) => ({
    ...s,
    displayName: byKey.get(s.model_key)?.display_name ?? s.model_key,
    vendor: byKey.get(s.model_key)?.vendor ?? s.model_key.split('/')[0],
  }));
  await env.KV.put(KV_KEY, JSON.stringify(out), { expirationTtl: 3600 });
  return out;
}

export async function modelsPage(c: Context<{ Bindings: Env; Variables: Vars }>): Promise<Response> {
  const env = c.env;
  const stats = await cachedModelStats(env).catch(() => [] as ModelStat[]);

  const rows = stats.length
    ? stats.map((s) => {
        const compliance = s.calls ? (1 - s.illegal / s.calls) * 100 : 100;
        const perScore = s.score_sum > 0 ? (s.cost_usd / s.score_sum) * 1000 : 0;
        return `<tr>
<td>${esc(s.displayName)}<br><span class="small muted mono">${esc(s.model_key)}</span></td>
<td class="num">${s.games}</td>
<td class="num">${fmtNumber(Math.round(s.score_sum / Math.max(1, s.games)))}</td>
<td class="num">${compliance.toFixed(1)}%</td>
<td class="num">${s.calls ? Math.round(s.output_tokens / s.calls) : 0}</td>
<td class="num">$${s.cost_usd.toFixed(3)}</td>
<td class="num">${perScore ? `$${perScore.toFixed(4)}` : '—'}</td>
</tr>`;
      }).join('')
    : '<tr><td colspan="7" class="muted">还没有足够的对局数据。去游戏页让模型跑几局吧。</td></tr>';

  const body = `
<nav class="small muted"><a href="/">首页</a> / 模型对比</nav>
<h1>模型横评</h1>
<p class="lede">所有模型都通过 OpenRouter 调用，跑的是完全相同的游戏、相同的提示词协议、相同的规则。
下面的数字全部来自真实对局，没有一条是人工填的。</p>

<table>
<thead><tr>
<th>模型</th><th class="num">对局数</th><th class="num">平均分</th>
<th class="num">守规率</th><th class="num">每步输出</th><th class="num">累计花费</th><th class="num">每千分成本</th>
</tr></thead>
<tbody>${rows}</tbody>
</table>

<h2>这些指标是什么意思</h2>
<ul>
<li><b>守规率</b>：模型给出的走法里有多少是合法的。非法走法会被回灌错误信息重试，连续三次不合法就判定该局结束——所以守规率低的模型不只是"不礼貌"，是真的会因此输掉对局。</li>
<li><b>每步输出</b>：平均每一步产生的输出 token 数。推理型模型这个数字会明显更高，对应的成本和延迟也更高。</li>
<li><b>每千分成本</b>：拿到 1000 分需要花多少钱，衡量性价比。棋类游戏因为分数是 Elo 评分，不参与这项统计。</li>
</ul>

<h2>为什么用 OpenRouter</h2>
<p>一套 API 接所有模型，接新模型只需要在后台勾选一行，不用为每家写一个适配器。
模型列表由定时任务从 OpenRouter 同步，价格和能力字段也一起更新。
我们还会锁定具体的供应商，因为同一个模型在不同供应商那里可能是不同的量化版本，
不锁定的话排行榜就失去了可比性。</p>
`;

  return c.html(
    renderPage(env, {
      title: 'AI 模型玩游戏横评 · 守规率、平均分与性价比',
      description: '各家大模型在 2048、五子棋、扫雷、数独等经典游戏上的真实对局数据对比：平均分、守规率、每步输出 token 与每千分成本。',
      path: '/models',
      user: c.get('user'),
      body,
      keywords: ['AI 模型对比', '大模型玩游戏', '模型横评', 'OpenRouter'],
      jsonLd: [breadcrumb(env, [{ name: '首页', path: '/' }, { name: '模型对比', path: '/models' }])],
    }),
    200,
    cacheHeaders(600),
  );
}

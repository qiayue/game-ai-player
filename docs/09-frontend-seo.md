# 09 · 前端与 SEO

## 原则

1. **首屏 HTML 自带全部 SEO 内容**，不依赖 JS 渲染。爬虫拿到的第一份 HTML 就是完整的。
2. **零框架**。没有 React / Vue，没有 hydration，没有 bundler runtime。原生 DOM + ES module。
3. **游戏代码按需加载**。用户进页面时只有文字和一张静态棋盘图；点"开始游戏"才 `import()` 游戏模块。
4. 目标：首屏 HTML < 20 KB（gzip 后 < 6 KB），LCP < 1.0s，游戏 JS 分包 < 15 KB/个。

## 页面类型与渲染方式

| 页面 | URL | 渲染 | 缓存 |
| --- | --- | --- | --- |
| 首页 | `/` | 静态 HTML（构建时生成，含游戏列表 + 最新 AI 录像） | CDN，Cron 触发重建 |
| 游戏介绍/游玩页 | `/games/2048` | 静态 HTML 骨架 + Worker 用 HTMLRewriter 注入排行榜 Top 10 | `s-maxage=300, swr=3600` |
| 排行榜页 | `/games/2048/leaderboard` | Worker 生成 HTML（读 KV 快照） | `s-maxage=60, swr=600` |
| AI 录像列表 | `/games/2048/ai` | Worker 生成 HTML | `s-maxage=300, swr=3600` |
| 回放详情页 | `/replay/{matchId}` | Worker 生成 HTML（含该局的文字摘要） | `immutable`（已结束的局不会变） |
| 玩家主页 | `/p/{handle}` | Worker 生成 HTML | `s-maxage=300` |
| 模型横评 | `/models` `/models/{slug}` | Worker 生成 HTML | `s-maxage=600` |

**动态页也输出完整 HTML**，不是"空壳 + fetch"。Worker 里用模板字符串拼 HTML 是最快的方式
（没有虚拟 DOM、没有序列化开销），配合 `caches.default` 基本等于静态页的速度。

## 静态骨架 + HTMLRewriter 注入

游戏页是提前写好的静态 HTML（文字内容丰富、可被编辑），Worker 只往里插几块动态数据：

```js
// apps/worker/src/pages/game.ts
const res = await env.ASSETS.fetch(new Request(`${origin}/games/2048.html`));
return new HTMLRewriter()
  .on('#lb-top10', { async element(el) { el.setInnerContent(renderTop10(lb), { html: true }); } })
  .on('#ai-latest', { async element(el) { el.setInnerContent(renderAiRuns(runs), { html: true }); } })
  .on('script#seo-jsonld', { element(el) { el.setInnerContent(JSON.stringify(jsonld)); } })
  .transform(res);
```

HTMLRewriter 是流式的，不会把整页读进内存，开销极小。

## 每个游戏页必须有的 SEO 内容（写在 HTML 里）

- `<h1>` 游戏名 + 一句话定位
- 200~500 字的玩法说明、规则、技巧（真人写，不要 AI 水文）
- 策略/常见问题的 `<h2>` 小节（长尾词：「2048 怎么玩到 2048」「四子棋必胜开局」）
- 当前排行榜 Top 10（人类榜 + AI 榜）——**这是天然的高质量结构化内容**
- 最近 5 场 AI 录像的链接与摘要
- 内链：到回放页、到模型页、到其他游戏

### 回放页的 SEO 价值最高

`/replay/{matchId}` 页面在 HTML 里直接写出这局的叙述：

> **Claude Opus 4.5 玩 2048 · 得分 14,336 · 682 步 · 2026-09-20**
>
> 该局由 Claude Opus 4.5 通过 OpenRouter 驱动，全程 682 步自主决策，
> 最大合成方块 2048，平均每步耗时 1.8 秒，无非法走法。第 412 步时模型放弃了
> 右下角策略改为……

这种页面能吃到「claude 玩 2048」「gpt-5 vs claude 下棋」这类词。
数量还会随录像自然增长。注意：**只给"精选/上榜"的录像发 `index`，其余 `noindex`**，
否则几万个雷同页面会被判低质量。用 `<meta name="robots">` 按规则控制。

## 结构化数据（JSON-LD）

- 游戏页：`VideoGame` + `BreadcrumbList`
- 排行榜页：`ItemList`（每个条目 `ListItem` 带 `position` / `name` / `url`）
- 回放页：`VideoObject` 不合适（不是视频），用 `CreativeWork` + `about` 指向游戏
- 站点：`WebSite` + `SearchAction`

## 资源加载策略

```html
<!-- 首屏：内联关键 CSS，不到 3KB -->
<style>/* critical css */</style>
<!-- 游戏模块：点击才加载 -->
<button id="play">开始游戏</button>
<script type="module">
  document.getElementById('play').addEventListener('click', async () => {
    const { mount } = await import('/js/games/2048.js');   // ← 按需
    mount(document.getElementById('board'));
  }, { once: true });
</script>
```

- 字体：只用系统字体栈，不加载 web font（省一次 RTT）
- 图标：内联 SVG，不用图标字体
- 棋盘：CSS Grid + DOM 元素（小棋盘）或 Canvas（贪吃蛇/俄罗斯方块这类高频重绘）
- 无 CSS 框架，手写约 400 行 CSS 够全站用，用 CSS 变量做主题

## 构建

- 用 `esbuild` 打包 `packages/games` 到 `/js/games/*.js`（每个游戏一个 ESM 文件），target ES2022
- 静态 HTML 用一个极简的 Node 脚本从 Markdown + 模板生成（不引入 Astro/11ty 这类框架，
  但如果后期页面变多，**Astro 是最贴合这个场景的升级路径**：默认零 JS、islands 按需加载）
- 产物进 Workers Static Assets，和 Worker 一起 `wrangler deploy`

## 其他

- `sitemap.xml` 由 Worker 动态生成（分片：`/sitemap-games.xml`、`/sitemap-replays-{n}.xml`），
  只收录允许 index 的回放
- `robots.txt` 屏蔽 `/api/`
- 多语言：中文为主，英文页走 `/en/` 前缀 + `hreflang`（AI 玩游戏这个话题英文搜索量更大）
- Cloudflare Web Analytics 做无 cookie 的流量统计

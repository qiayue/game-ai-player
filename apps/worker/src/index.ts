import { Hono } from 'hono';
import type { Env, Vars } from './env.js';
import { withUser } from './auth.js';
import { errorResponse, ApiError } from './util/http.js';
import { auth } from './routes/auth.js';
import { matches } from './routes/matches.js';
import { airuns } from './routes/airuns.js';
import { models as modelsApi } from './routes/models.js';
import { leaderboards } from './routes/leaderboards.js';
import { replays } from './routes/replays.js';
import { admin } from './routes/admin.js';
import { homePage } from './pages/home.js';
import { gamePage } from './pages/game.js';
import { leaderboardPage, aiRunsPage } from './pages/leaderboard.js';
import { replayPage } from './pages/replay.js';
import { playerPage } from './pages/player.js';
import { modelsPage } from './pages/models.js';
import { sitemapIndex, sitemapPages, sitemapReplays, robotsTxt } from './pages/sitemap.js';
import { renderPage } from './pages/layout.js';
import { handleQueue, type AiRunFinishedMessage } from './queue.js';
import { handleScheduled } from './cron.js';

export { AiRunDO } from './do/AiRunDO.js';

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

app.use('*', withUser);

app.onError((err, c) => {
  if (!(err instanceof ApiError)) console.error('unhandled', err);
  // 页面请求返回 HTML 错误页，API 返回 JSON
  if (!c.req.path.startsWith('/api/') && c.req.method === 'GET') {
    const status = err instanceof ApiError ? err.status : 500;
    const message = err instanceof ApiError ? err.message : '服务出了点问题，稍后再试';
    return c.html(
      renderPage(c.env, {
        title: `${status} · ${c.env.SITE_NAME}`,
        description: message,
        path: c.req.path,
        user: c.get('user') ?? null,
        robots: 'noindex',
        body: `<h1>${status}</h1><p class="lede">${message}</p><p><a href="/">回到首页 →</a></p>`,
      }),
      status as 404,
    );
  }
  return errorResponse(err);
});

// ------------------------------------------------------------------ API
app.route('/api/auth', auth);
app.get('/api/me', (c) => c.json({ user: c.get('user') }, { headers: { 'Cache-Control': 'private, no-store' } }));
app.route('/api/matches', matches);
app.route('/api/ai-runs', airuns);
app.route('/api/models', modelsApi);
app.route('/api/leaderboards', leaderboards);
app.route('/api/replays', replays);
app.route('/api/admin', admin);

// ------------------------------------------------------------------ 页面
// 每个页面都输出完整 HTML（SEO 内容在首屏），游戏逻辑才由 JS 按需加载
app.get('/', homePage);
app.get('/models', modelsPage);
app.get('/games/:gameId', gamePage);
app.get('/games/:gameId/leaderboard', leaderboardPage);
app.get('/games/:gameId/ai', aiRunsPage);
app.get('/replay/:matchId', replayPage);
app.get('/p/:handle', playerPage);
app.get('/sitemap.xml', sitemapIndex);
app.get('/sitemap-pages.xml', sitemapPages);
app.get('/sitemap-replays.xml', sitemapReplays);
app.get('/robots.txt', robotsTxt);

app.notFound(async (c) => {
  // 交回给静态资源，它没有的话才是真的 404
  const res = await c.env.ASSETS.fetch(c.req.raw);
  if (res.status !== 404) return res;
  return c.html(
    renderPage(c.env, {
      title: `找不到这个页面 · ${c.env.SITE_NAME}`,
      description: '这个地址不存在',
      path: c.req.path,
      user: c.get('user') ?? null,
      robots: 'noindex',
      body: '<h1>找不到这个页面</h1><p class="lede">链接可能过期了，或者从来就没存在过。</p><p><a href="/">回到首页 →</a></p>',
    }),
    404,
  );
});

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<AiRunFinishedMessage>, env: Env): Promise<void> {
    await handleQueue(batch, env);
  },
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(handleScheduled(event, env));
  },
};

import type { Context } from 'hono';
import type { Env, Vars } from '../env.js';
import { GAME_LIST } from '@gap/games';
import * as repo from '../repo.js';
import { cacheHeaders } from '../util/http.js';

const xmlHeaders = (seconds: number) => ({ 'Content-Type': 'application/xml; charset=utf-8', ...cacheHeaders(seconds) });

export function sitemapIndex(c: Context<{ Bindings: Env; Variables: Vars }>): Response {
  const site = c.env.SITE_URL.replace(/\/$/, '');
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<sitemap><loc>${site}/sitemap-pages.xml</loc></sitemap>
<sitemap><loc>${site}/sitemap-replays.xml</loc></sitemap>
</sitemapindex>`;
  return c.body(body, 200, xmlHeaders(3600));
}

export function sitemapPages(c: Context<{ Bindings: Env; Variables: Vars }>): Response {
  const site = c.env.SITE_URL.replace(/\/$/, '');
  const urls = ['/', '/models'];
  for (const g of GAME_LIST) {
    urls.push(`/games/${g.id}`, `/games/${g.id}/leaderboard`, `/games/${g.id}/ai`);
  }
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `<url><loc>${site}${u}</loc><changefreq>daily</changefreq></url>`).join('\n')}
</urlset>`;
  return c.body(body, 200, xmlHeaders(3600));
}

/** 只收录标记为 indexable 的精选录像 */
export async function sitemapReplays(c: Context<{ Bindings: Env; Variables: Vars }>): Promise<Response> {
  const site = c.env.SITE_URL.replace(/\/$/, '');
  const cursor = c.req.query('cursor') ?? undefined;
  const rows = await repo.listIndexableMatches(c.env, cursor, 1000).catch(() => []);
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${rows.map((m) =>
    `<url><loc>${site}/replay/${m.id}</loc><lastmod>${new Date(m.ended_at).toISOString().slice(0, 10)}</lastmod></url>`,
  ).join('\n')}
</urlset>`;
  return c.body(body, 200, xmlHeaders(3600));
}

export function robotsTxt(c: Context<{ Bindings: Env; Variables: Vars }>): Response {
  const site = c.env.SITE_URL.replace(/\/$/, '');
  return c.body(
    `User-agent: *\nDisallow: /api/\nAllow: /\n\nSitemap: ${site}/sitemap.xml\n`,
    200,
    { 'Content-Type': 'text/plain; charset=utf-8', ...cacheHeaders(86400) },
  );
}

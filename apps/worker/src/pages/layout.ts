import type { Env } from '../env.js';
import type { PublicUser } from '@gap/shared';
import { GAME_LIST } from '@gap/games';
import { CSS } from './css.js';

export function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 内联进 <script type="application/json"> 的安全写法 */
export function jsonScript(id: string, data: unknown): string {
  const text = JSON.stringify(data).replace(/</g, '\\u003c').replace(/-->/g, '--\\>');
  return `<script type="application/json" id="${esc(id)}">${text}</script>`;
}

export interface PageOptions {
  title: string;
  description: string;
  path: string;
  user: PublicUser | null;
  body: string;
  /** 结构化数据 */
  jsonLd?: unknown[];
  /** 额外塞进 head 的内容 */
  head?: string;
  /** 额外塞在 body 末尾的脚本 */
  scripts?: string;
  robots?: string;
  wide?: boolean;
  keywords?: string[];
}

export function renderPage(env: Env, o: PageOptions): string {
  const site = env.SITE_URL.replace(/\/$/, '');
  const canonical = `${site}${o.path}`;
  const jsonLd = (o.jsonLd ?? []).map(
    (d) => `<script type="application/ld+json">${JSON.stringify(d).replace(/</g, '\\u003c')}</script>`,
  ).join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.description)}">
${o.keywords?.length ? `<meta name="keywords" content="${esc(o.keywords.join(','))}">` : ''}
${o.robots ? `<meta name="robots" content="${esc(o.robots)}">` : ''}
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(o.title)}">
<meta property="og:description" content="${esc(o.description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:site_name" content="${esc(env.SITE_NAME)}">
<meta name="twitter:card" content="summary">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>${CSS}</style>
${jsonLd}
${o.head ?? ''}
</head>
<body>
${header(o.user, o.path, o.wide)}
<main><div class="wrap${o.wide ? ' wide' : ''}">${o.body}</div></main>
${footer(env)}
${jsonScript('bootstrap', { user: o.user, siteName: env.SITE_NAME, googleClientId: env.GOOGLE_CLIENT_ID })}
<script type="module" src="/assets/app.js"></script>
${o.scripts ?? ''}
</body>
</html>`;
}

function header(user: PublicUser | null, path: string, wide?: boolean): string {
  const links = GAME_LIST.slice(0, 6)
    .map((g) => {
      const href = `/games/${g.id}`;
      return `<a href="${href}"${path === href ? ' aria-current="page"' : ''}>${esc(g.name)}</a>`;
    })
    .join('');
  return `<header class="site"><div class="wrap${wide ? ' wide' : ''}">
<a class="brand" href="/">${esc('Game AI Player')}</a>
<nav class="top">${links}<a href="/#all-games">全部游戏</a><a href="/models">模型对比</a></nav>
<div id="auth-slot" class="small">${
    user
      ? `<a href="/p/${esc(user.handle)}">${esc(user.displayName)}</a>`
      : '<button id="login-btn" class="small">登录</button>'
  }</div>
</div></header>`;
}

function footer(env: Env): string {
  return `<footer class="site"><div class="wrap">
<p>${esc(env.SITE_NAME)} · 经典小游戏的人类与 AI 对照实验场。每一局都可完整回放。</p>
<p class="small"><a href="/">首页</a> · <a href="/models">模型对比</a> · <a href="/sitemap.xml">站点地图</a></p>
</div></footer>`;
}

/** 面包屑结构化数据 */
export function breadcrumb(env: Env, items: { name: string; path: string }[]): unknown {
  const site = env.SITE_URL.replace(/\/$/, '');
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: it.name,
      item: `${site}${it.path}`,
    })),
  };
}

export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${s % 60} 秒`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

export function fmtDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export function fmtNumber(n: number): string {
  return n.toLocaleString('en-US');
}

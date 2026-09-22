import type { Context } from 'hono';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string) => new ApiError(400, 'bad_request', msg);
export const unauthorized = (msg = '请先登录') => new ApiError(401, 'unauthorized', msg);
export const forbidden = (msg = '没有权限') => new ApiError(403, 'forbidden', msg);
export const notFound = (msg = '没有找到') => new ApiError(404, 'not_found', msg);

export function errorResponse(err: unknown): Response {
  if (err instanceof ApiError) {
    return Response.json({ error: { code: err.code, message: err.message } }, { status: err.status });
  }
  const message = err instanceof Error ? err.message : String(err);
  return Response.json({ error: { code: 'internal', message } }, { status: 500 });
}

/** 写接口的 CSRF 兜底：配合 SameSite=Lax Cookie 校验 Origin */
export function checkOrigin(c: Context, siteUrl: string): void {
  const origin = c.req.header('Origin');
  if (!origin) return; // 同源的简单请求可能不带 Origin
  const allowed = new Set([siteUrl, new URL(c.req.url).origin]);
  if (!allowed.has(origin)) throw forbidden('跨站请求被拒绝');
}

export function cacheHeaders(seconds: number, swr = seconds * 10): Record<string, string> {
  return { 'Cache-Control': `public, max-age=0, s-maxage=${seconds}, stale-while-revalidate=${swr}` };
}

export const IMMUTABLE = { 'Cache-Control': 'public, max-age=31536000, immutable' };

/** 路由参数：Hono 在无路径泛型时返回 string | undefined，这里统一收口 */
export function param(c: Context, name: string): string {
  const v = c.req.param(name);
  if (!v) throw notFound(`缺少路径参数 ${name}`);
  return v;
}

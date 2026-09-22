import type { Context, MiddlewareHandler } from 'hono';
import type { PublicUser } from '@gap/shared';
import type { Env, Vars } from './env.js';
import { signJwt, verifyJwt, decodeJwtPart } from './util/jwt.js';
import { ulid, slugify } from './util/ids.js';
import { unauthorized, badRequest } from './util/http.js';
import * as repo from './repo.js';

const SESSION_COOKIE = 'gap_session';
const SESSION_TTL = 60 * 60 * 24 * 30; // 30 天
const GOOGLE_JWKS = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

interface Jwk extends JsonWebKey { kid: string }

let jwksCache: { keys: Jwk[]; expires: number } | null = null;

async function googleKeys(): Promise<Jwk[]> {
  if (jwksCache && jwksCache.expires > Date.now()) return jwksCache.keys;
  const res = await fetch(GOOGLE_JWKS);
  if (!res.ok) throw new Error(`fetch google jwks failed: ${res.status}`);
  const body = (await res.json()) as { keys: Jwk[] };
  const maxAge = /max-age=(\d+)/.exec(res.headers.get('Cache-Control') ?? '');
  const ttl = maxAge ? parseInt(maxAge[1], 10) * 1000 : 3600_000;
  jwksCache = { keys: body.keys, expires: Date.now() + ttl };
  return body.keys;
}

export interface GoogleIdentity {
  sub: string;
  name: string;
  picture: string | null;
}

/**
 * 校验 Google Identity Services 下发的 ID token。
 * 走完整流程：签名 / iss / aud / exp，允许 60 秒时钟偏移。
 */
export async function verifyGoogleIdToken(idToken: string, clientId: string): Promise<GoogleIdentity> {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw badRequest('不是合法的 ID token');
  const header = decodeJwtPart(parts[0]) as { kid?: string; alg?: string } | null;
  if (!header?.kid || header.alg !== 'RS256') throw badRequest('ID token 头部不合法');

  const jwk = (await googleKeys()).find((k) => k.kid === header.kid);
  if (!jwk) throw badRequest('找不到对应的 Google 公钥');

  const key = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'],
  );
  const { b64urlDecode } = await import('./util/jwt.js');
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', key, b64urlDecode(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!ok) throw badRequest('ID token 签名校验失败');

  const payload = decodeJwtPart(parts[1]) as {
    iss?: string; aud?: string; sub?: string; exp?: number; nbf?: number;
    name?: string; picture?: string;
  } | null;
  if (!payload?.sub) throw badRequest('ID token 缺少 sub');
  if (!payload.iss || !GOOGLE_ISSUERS.has(payload.iss)) throw badRequest('ID token 签发方不正确');
  if (payload.aud !== clientId) throw badRequest('ID token 不是发给本站的');
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && payload.exp + 60 < now) throw badRequest('ID token 已过期');
  if (typeof payload.nbf === 'number' && payload.nbf - 60 > now) throw badRequest('ID token 尚未生效');

  return { sub: payload.sub, name: payload.name || '玩家', picture: payload.picture ?? null };
}

interface SessionPayload {
  sub: string;      // playerId
  h: string;        // handle
  n: string;        // displayName
  a: string | null; // avatar
  adm: number;
  ver: number;
}

export async function issueSession(c: Context<{ Bindings: Env; Variables: Vars }>, user: PublicUser, ver: number): Promise<void> {
  const token = await signJwt(
    { sub: user.id, h: user.handle, n: user.displayName, a: user.avatarUrl, adm: user.isAdmin ? 1 : 0, ver },
    c.env.SESSION_SECRET, SESSION_TTL,
  );
  const secure = new URL(c.req.url).protocol === 'https:' ? ' Secure;' : '';
  c.header(
    'Set-Cookie',
    `${SESSION_COOKIE}=${token}; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=${SESSION_TTL}`,
    { append: true },
  );
}

export function clearSession(c: Context<{ Bindings: Env; Variables: Vars }>): void {
  c.header('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`, { append: true });
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

/**
 * 从 Cookie 还原用户。验签是纯 CPU 运算，不查数据库。
 * 只有在 KV 里存在版本号且与 token 不一致时才要求重新登录（用于强制下线）。
 */
export const withUser: MiddlewareHandler<{ Bindings: Env; Variables: Vars }> = async (c, next) => {
  c.set('user', null);
  const token = readCookie(c.req.header('Cookie'), SESSION_COOKIE);
  if (token) {
    const payload = await verifyJwt<SessionPayload>(token, c.env.SESSION_SECRET);
    if (payload) {
      const ver = await c.env.KV.get(`uver:${payload.sub}`);
      if (!ver || Number(ver) === payload.ver) {
        c.set('user', {
          id: payload.sub,
          handle: payload.h,
          displayName: payload.n,
          avatarUrl: payload.a,
          isAdmin: payload.adm === 1,
        });
      }
    }
  }
  await next();
};

export function requireUser(c: Context<{ Bindings: Env; Variables: Vars }>): PublicUser {
  const user = c.get('user');
  if (!user) throw unauthorized();
  return user;
}

export function requireAdmin(c: Context<{ Bindings: Env; Variables: Vars }>): PublicUser {
  const user = requireUser(c);
  if (!user.isAdmin) throw unauthorized('需要管理员权限');
  return user;
}

/** 按 Google sub 找到或创建玩家 */
export async function upsertGooglePlayer(env: Env, id: GoogleIdentity): Promise<PublicUser> {
  const existing = await repo.getPlayerByGoogleSub(env, id.sub);
  const isAdmin = (env.ADMIN_SUBS ?? '').split(',').map((s) => s.trim()).filter(Boolean).includes(id.sub);
  if (existing) {
    if (isAdmin && !existing.isAdmin) await repo.setAdmin(env, existing.id, true);
    return { ...existing, isAdmin: isAdmin || existing.isAdmin };
  }
  const playerId = ulid();
  const handle = await repo.uniqueHandle(env, slugify(id.name, `player-${playerId.slice(-6).toLowerCase()}`));
  await repo.createHumanPlayer(env, {
    id: playerId, handle, displayName: id.name, avatarUrl: id.picture, googleSub: id.sub, isAdmin,
  });
  return { id: playerId, handle, displayName: id.name, avatarUrl: id.picture, isAdmin };
}

/** session 版本号 +1，使该用户所有已签发的 token 失效 */
export async function bumpSessionVersion(env: Env, playerId: string): Promise<number> {
  const cur = Number((await env.KV.get(`uver:${playerId}`)) ?? '0');
  const next = cur + 1;
  await env.KV.put(`uver:${playerId}`, String(next));
  return next;
}

export async function currentSessionVersion(env: Env, playerId: string): Promise<number> {
  return Number((await env.KV.get(`uver:${playerId}`)) ?? '0');
}

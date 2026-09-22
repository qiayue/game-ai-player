const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(str: string): Uint8Array {
  const pad = str.length % 4 ? '='.repeat(4 - (str.length % 4)) : '';
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const keyCache = new Map<string, CryptoKey>();

async function hmacKey(secret: string): Promise<CryptoKey> {
  const hit = keyCache.get(secret);
  if (hit) return hit;
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
  );
  keyCache.set(secret, key);
  return key;
}

/** 签一个 HS256 JWT。验签是纯 CPU 运算，因此 session 不需要落库。 */
export async function signJwt(
  payload: Record<string, unknown>, secret: string, ttlSeconds: number,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + ttlSeconds };
  const head = b64urlEncode(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const data = `${head}.${b64urlEncode(enc.encode(JSON.stringify(body)))}`;
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(data));
  return `${data}.${b64urlEncode(new Uint8Array(sig))}`;
}

export async function verifyJwt<T = Record<string, unknown>>(
  token: string, secret: string,
): Promise<T | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const data = `${parts[0]}.${parts[1]}`;
  let ok = false;
  try {
    ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), b64urlDecode(parts[2]), enc.encode(data));
  } catch {
    return null;
  }
  if (!ok) return null;
  try {
    const payload = JSON.parse(dec.decode(b64urlDecode(parts[1]))) as { exp?: number };
    if (typeof payload.exp === 'number' && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload as T;
  } catch {
    return null;
  }
}

/** 只解 payload，不验签 —— 只用于读 kid/iss 之类的路由信息 */
export function decodeJwtPart(part: string): Record<string, unknown> | null {
  try {
    return JSON.parse(dec.decode(b64urlDecode(part))) as Record<string, unknown>;
  } catch {
    return null;
  }
}

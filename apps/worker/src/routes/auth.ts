import { Hono } from 'hono';
import type { Env, Vars } from '../env.js';
import {
  verifyGoogleIdToken, upsertGooglePlayer, issueSession, clearSession,
  requireUser, currentSessionVersion,
} from '../auth.js';
import { badRequest, checkOrigin } from '../util/http.js';
import * as repo from '../repo.js';
import { slugify } from '../util/ids.js';

export const auth = new Hono<{ Bindings: Env; Variables: Vars }>();

/** Google Identity Services 拿到的 ID token 换成本站的 session Cookie */
auth.post('/google', async (c) => {
  checkOrigin(c, c.env.SITE_URL);
  if (!c.env.GOOGLE_CLIENT_ID) throw badRequest('本站尚未配置 Google 登录');
  const { credential } = await c.req.json<{ credential?: string }>().catch(() => ({ credential: undefined }));
  if (!credential) throw badRequest('缺少 credential');

  const identity = await verifyGoogleIdToken(credential, c.env.GOOGLE_CLIENT_ID);
  const user = await upsertGooglePlayer(c.env, identity);
  await issueSession(c, user, await currentSessionVersion(c.env, user.id));
  return c.json({ user });
});

auth.post('/logout', async (c) => {
  checkOrigin(c, c.env.SITE_URL);
  clearSession(c);
  return c.json({ ok: true });
});

auth.get('/me', (c) => c.json({ user: c.get('user') }, { headers: { 'Cache-Control': 'private, no-store' } }));

auth.patch('/me', async (c) => {
  checkOrigin(c, c.env.SITE_URL);
  const user = requireUser(c);
  const body = await c.req.json<{ displayName?: string; handle?: string }>();
  const patch: { displayName?: string; handle?: string } = {};

  if (body.displayName !== undefined) {
    const name = body.displayName.trim().slice(0, 24);
    if (name.length < 1) throw badRequest('昵称不能为空');
    patch.displayName = name;
  }
  if (body.handle !== undefined) {
    const wanted = slugify(body.handle, '');
    if (wanted.length < 3) throw badRequest('用户名至少 3 个字符');
    if (wanted !== user.handle) {
      const taken = await repo.getPlayerByHandle(c.env, wanted);
      if (taken) throw badRequest('这个用户名已经被占用了');
      patch.handle = wanted;
    }
  }
  await repo.updateProfile(c.env, user.id, patch);
  const next = { ...user, ...patch };
  await issueSession(c, next, await currentSessionVersion(c.env, user.id));
  return c.json({ user: next });
});

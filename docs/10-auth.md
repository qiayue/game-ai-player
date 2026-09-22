# 10 · 登录（Google）

只做 Google 登录，不做邮箱密码、不做其他 OAuth。

## 方案：Google Identity Services（ID token）+ 自签 session JWT

比标准 OAuth Authorization Code 流程更适合"静态 HTML + Worker"：不需要回调页、
不需要维护 `state` 和 `code_verifier`，前端一个按钮就够。

```
1. 页面引入 Google Identity Services，渲染「使用 Google 登录」按钮 / One Tap
2. 用户点选账号 → GIS 回调拿到 ID token（一个 RS256 签名的 JWT）
3. 前端 POST /api/auth/google  { credential: <id_token> }
4. Worker 校验这个 JWT：
     - 从 https://www.googleapis.com/oauth2/v3/certs 拉 JWKS（用 Cache API 缓存，按 max-age）
     - WebCrypto 验 RS256 签名
     - 校验 iss ∈ {accounts.google.com, https://accounts.google.com}
     - 校验 aud === GOOGLE_CLIENT_ID
     - 校验 exp / nbf，允许 60s 时钟偏移
     - 取 sub（Google 用户唯一 ID）、email、email_verified、name、picture
5. 按 sub upsert 到 D1 players 表（唯一索引 auth_provider='google' + auth_subject=sub）
6. Worker 签发自己的 session JWT（HS256，密钥在 Worker Secret），写入 Cookie：
     HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000
7. 后续请求从 Cookie 验 session JWT
```

## 为什么 session 不查数据库

**每个 API 请求都查一次 D1 验 session，是最容易被忽视的 D1 压力来源。**
用自签 JWT 就完全不需要：验签是纯 CPU 运算（< 1ms），零 I/O。

JWT payload 只放：`{ sub: playerId, name, ver, iat, exp }`。

- 需要强制下线（封号、改名同步）时：在 KV 存 `uver:{playerId} = N`，
  JWT 里带 `ver`，不一致就要求重新登录。KV 读比 D1 便宜且就近，且只在必要路径上读。
- 不做 refresh token。30 天过期后重新点一次 Google 登录即可（One Tap 几乎无感）。

## 匿名游玩

**不强制登录才能玩。** 未登录用户可以直接玩，成绩存在 localStorage，
页面上提示"登录后即可上榜"。点登录后，前端把本地的历史对局一次性提交，服务端校验后归属到新账号。

这对 SEO 和转化都重要：搜索进来的人第一秒就能玩，不会被登录墙挡掉。

## 权限模型

| 角色 | 能做什么 |
| --- | --- |
| 匿名 | 玩所有游戏、看所有排行榜和回放 |
| 登录用户 | + 成绩上榜、保存回放、**手动触发 AI 跑局**（有配额） |
| 管理员 | + 无限 AI 配额、删除违规对局、重算排行榜、管理模型开关 |

管理员用一个环境变量里的 Google sub 白名单判定，不建角色表。

## AI 跑局的配额

AI 跑局要花真金白银，必须限流。存在 KV 里，按用户和全局两层：

```
quota:user:{playerId}:{yyyy-mm-dd}   → 今日已发起次数（默认上限 10）
quota:cost:{yyyy-mm-dd}              → 今日全站累计成本（美分），超预算全站暂停新任务
```

超限时返回 429 并在页面上说明"今日 AI 对局次数已用完"。
管理员可以在后台临时提额。

## 安全细项

- `GOOGLE_CLIENT_ID` 可以公开（要写在前端 HTML 里），`SESSION_SECRET` 必须是 Worker Secret
- 所有写接口校验 `Origin` 头，配合 `SameSite=Lax` 防 CSRF
- 不在前端存任何 token（不用 localStorage 存 session，只用 HttpOnly Cookie）
- 用户资料只存 `sub` / 显示名 / 头像 URL；**不存 email**（不需要，且减少合规负担）。
  如果后续要发通知再单独申请授权。
- 显示名允许用户自定义（默认取 Google 的 name），做敏感词过滤和唯一性检查

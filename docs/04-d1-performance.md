# 04 · D1 在大数据量下的性能问题与对策

D1 是托管的 SQLite。它的优点（便宜、SQL、和 Worker 同生态）和它的约束是一体两面。
下面每一条都写明"问题 → 症状 → 对策"，实施时按这个清单逐项检查。

> 具体数字（单库容量、每日读写行数、并发限制）以 Cloudflare 官方文档当前版本为准，
> 本文只给数量级和结论。架构设计不应该依赖某个具体阈值，而应该让增长曲线本身可控。

---

## 问题 1：写放大 —— 按"步"写库

**症状**：一局 2048 有 800+ 步。如果每步 `INSERT INTO moves`，
10 万局就是近亿行。表膨胀、索引维护变慢、写入排队、逼近单库容量上限。

**对策（最关键的一条）**：
- **人类对局**：全程在浏览器内存里跑，只有开局和终局两次请求。中间 800 步一次库都不碰。
- **AI 录制**：状态在 Durable Object 内存 + DO storage 里，alarm 循环推进，**全程不碰 D1**；
  前端轮询进度打的也是 DO，不是 D1。
- 走法明细终局时一次性以 JSONL 写入 R2。
- D1 只在终局写 **1 行 `matches` + 1~2 行 `match_players` + 1 次排行榜 upsert**
  （AI 录制额外有 1 行 `ai_runs`，开始时插入、结束时更新）。
- 结果：D1 写入量与"对局数"线性，与"步数"无关。10 万局 ≈ 40 万行，完全在舒适区。

---

## 问题 2：每条 SQL 都是一次网络往返

**症状**：D1 没有长连接。在一个请求里串行执行 6 条语句 = 6 次往返，
即使每条只要 1ms，用户也会感到明显延迟。

**对策**：
- 用 `db.batch([...])` 把同一请求里的多条语句打成一个往返，同时获得隐式事务语义。
- 能用一条 SQL 表达的就别拆开（`INSERT ... ON CONFLICT DO UPDATE` 替代"先查后写"）。
- 所有语句用 `prepare()` + `bind()`，让 SQLite 复用查询计划，同时杜绝注入。
- 单个请求里 **D1 查询数设硬上限（比如 4 条）**，超了就说明设计有问题，写进 code review checklist。

---

## 问题 3：写入串行化

**症状**：SQLite 单写者。高并发时所有写请求排在一条队列上，P99 飙升。
终局瞬间同时更新 `matches`、`match_players`、`leaderboard` 三张表，锁竞争明显。

**对策**：
- 终局写入走 **Queue 异步化**：DO 先把结果写进 R2 和自己的 storage（用户立刻看到结算页），
  再投一条消息给 Queue，由 consumer 批量写 D1。用户体验和数据库压力解耦。
- Queue consumer 配置 `max_batch_size` / `max_batch_timeout`，**把多局的写入合并成一次 batch**，
  比如一次写 25 局，写入 QPS 直接降一个数量级。
- 排行榜不在终局同步更新，见问题 4。

---

## 问题 4：排行榜实时 `ORDER BY` 扫全表

**症状**：`SELECT ... FROM matches WHERE game_id=? ORDER BY score DESC LIMIT 100`
在百万行上每次都要扫描+排序，且这是首页最热的查询。

**对策（三层）**：
1. **预聚合表**：`leaderboard` 表每个 `(game, track, window, player)` 只有一行"个人最好成绩"。
   一百万局也许只对应几万名玩家，行数小两个数量级。
2. **整榜快照**：Cron（比如每分钟）把 Top 100 序列化成一行 JSON 存进 `leaderboard_snapshot`，
   同时写 KV。前台读排行榜是 **一次 KV 读**，不是一次 SQL 排序。
3. **写路径 upsert**：终局时只做
   `INSERT INTO leaderboard ... ON CONFLICT(...) DO UPDATE SET best_score=MAX(...)`，
   O(1) 写入，不触发任何扫描。

个人排名（"我是第几名"）不要用 `COUNT(*) WHERE score > mine`——那是全表扫。
用快照里的分数分布做近似排名，或者只在榜内（前 100）显示精确名次，榜外显示"前 X%"。

---

## 问题 5：`COUNT(*)`、`OFFSET` 分页

**症状**：`SELECT COUNT(*) FROM matches` 和 `LIMIT 20 OFFSET 10000` 都是 O(N)。
"共 1,234,567 局"这种展示会成为最慢的查询。

**对策**：
- **keyset 分页**：`WHERE game_id=? AND id < ?cursor ORDER BY id DESC LIMIT 20`。
  主键用 ULID（时间有序），游标就是上一页最后一条的 id，任意深度都是 O(log N)。
- 计数用 **计数器表**（`stats(key, value)`，Queue consumer 里 `+1`）或 Analytics Engine，
  不做实时 `COUNT(*)`。展示"1.2M+"这种近似值就够了。

---

## 问题 6：索引没覆盖，回表放大

**症状**：查询用了索引定位，但还要回主表取列，随机 I/O 多。

**对策**：
- 为热查询建**覆盖索引**，把排序列和返回列都放进索引：
  `CREATE INDEX idx_matches_board ON matches(game_id, track, status, score DESC, duration_ms ASC, id DESC);`
- 上线前对每条热查询跑 `EXPLAIN QUERY PLAN`，确认出现 `USING COVERING INDEX`，
  没有 `SCAN TABLE` 和 `USE TEMP B-TREE FOR ORDER BY`。把这一步写进 CI。
- 索引不是越多越好：每个索引都增加写入成本。只为真实查询建索引，定期删掉没用上的。

---

## 问题 7：宽表 / 大字段

**症状**：把 AI 的 prompt 和完整回复（几十 KB 的文本）存进 D1。
SQLite 会产生溢出页，行扫描变慢，容量迅速逼近上限，备份和迁移都变重。

**对策**：
- 大文本一律进 R2，D1 只存对象 key。
- D1 里的 TEXT 字段设长度约定（应用层校验），超长截断。
- JSON 只用于"小且不参与查询"的元数据；任何需要筛选的字段都提成独立列。

---

## 问题 7.5：每个请求都查一次 session 表

**症状**：`SELECT * FROM sessions WHERE token=?` 出现在每一个 API 请求上。
这是最隐蔽的 D1 压力来源——它的 QPS 等于全站 QPS，还在关键路径上。

**对策**：
- **不建 session 表**。登录后签发自签 JWT（HS256，密钥在 Worker Secret），
  验签是纯 CPU 运算（< 1ms），零 I/O。详见 [10-auth.md](10-auth.md)。
- 需要强制下线时在 KV 存一个版本号，只在必要路径上读 KV（比 D1 便宜且就近）。
- 同理：限流计数器、AI 跑局配额，全部用 KV 或 DO，不要用 D1 做计数。

---

## 问题 8：容量上限（单库 GB 级）

**症状**：D1 单个数据库有硬容量上限，触顶后写入直接失败，且不能在线扩容。

**对策（按优先级）**：
1. 上面 1~7 条做到位，单库能撑很久（对局元数据一行不过百来字节）。
2. **冷热分离**：Cron 把超过 N 个月且未上榜的对局搬到 R2 归档（Parquet/JSONL），D1 里删除。
   榜上有名的对局和个人最好成绩永久保留。
3. **按游戏水平分库**：D1 允许一个账号建大量数据库。
   把 `game_id` 作为分片键，每个游戏一个 D1 实例（`env.DB_2048`、`env.DB_OTHELLO`），
   在 Worker 里做一层 `getDbForGame(gameId)` 的路由。
   排行榜天然按游戏隔离，跨游戏的全局查询只有"用户总览"，可以由聚合表或多库并行查询后合并解决。
   **这个分片方向在一开始就要在代码里留出抽象**（所有 D1 访问走一个 `repo` 层，不在路由里直接写 SQL），
   否则事后改造成本很高。
4. 用户、模型等共享维度表放一个独立的"主库"，每个游戏分库里只存 id，
   展示名字时由 Worker 内存缓存 / KV 缓存补齐，避免跨库 join。

---

## 问题 9：读延迟与地理分布

**症状**：D1 主实例在某个地区，全球用户的读请求都要跨洋。

**对策**：
- 排行榜、回放这类只读热数据走 **KV / Cache API**（边缘缓存），根本不打 D1。
- 需要读 D1 的地方启用 **read replication（Sessions API）**，读走就近副本；
  写后立即读的场景用 session bookmark 保证读到自己的写。
- 回放包放 R2 + Cache API，用 `Cache-Control: public, max-age=31536000, immutable`
  （已结束的对局不可变，永久缓存）。

---

## 问题 10：迁移与备份

**症状**：表大了之后 `ALTER TABLE` / 建索引可能超时；误删数据无法恢复。

**对策**：
- 迁移文件进版本库，用 `wrangler d1 migrations apply`，dev 先行。
- 大表加索引拆成"新建表 + 分批回填 + 切换"，或者趁分库时顺便重建。
- 依赖 D1 的 Time Travel 做时间点恢复，同时用 Cron 定期把关键表导出到 R2 作为二次备份。

---

## 上线前的自检清单

- [ ] 没有任何一张 D1 表的行数与"步数"成正比
- [ ] 每个 API 请求的 D1 查询数 ≤ 4，多语句用 `batch()`
- [ ] 所有列表接口用 keyset 分页，没有 `OFFSET`
- [ ] 没有实时 `COUNT(*)`
- [ ] 排行榜读路径命中 KV 快照，不落 SQL 排序
- [ ] 每条热查询的 `EXPLAIN QUERY PLAN` 无 `SCAN TABLE`
- [ ] 终局写入经 Queue 批量合并
- [ ] D1 访问集中在 `repo` 层，随时可切分片
- [ ] 大文本（prompt / 走法明细）全部在 R2
- [ ] 有归档 Cron 和容量告警
- [ ] session / 限流 / 配额不查 D1（走 JWT 和 KV）
- [ ] AI 跑局的进度轮询打 DO，不打 D1

---

## 用压测验证，而不是凭感觉

写一个种子脚本，灌入 **50 万局 + 5 万玩家** 的模拟数据，然后测：

| 场景 | 目标 |
| --- | --- |
| 排行榜首页（走 KV） | P95 < 50 ms |
| 排行榜首页（KV miss 落 D1 快照表） | P95 < 100 ms |
| 个人对局列表第 500 页（keyset） | P95 < 100 ms，且与第 1 页无明显差距 |
| 终局写入（Queue 批量 25 局） | 单批 < 200 ms |
| 回放拉取（R2 + Cache） | P95 < 80 ms |

任何一项不达标，回到上面对应的问题条目。

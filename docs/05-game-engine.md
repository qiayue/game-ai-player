# 05 · 游戏内核抽象

所有游戏实现同一个接口，平台侧（对局、回放、AI、排行榜）对具体游戏零感知。

## 统一接口

```ts
// packages/games/src/core/types.ts

/** 状态永远是「定长数值数组 + 少量标量」，这样才能序列化、哈希、喂给模型 */
export interface GameState {
  /** 主棋盘：一维展开（idx = r * cols + c），或多层时用 board[layer] */
  board: Int32Array;
  rows: number;
  cols: number;
  /** 轮到谁（单人游戏恒为 0） */
  turn: number;
  /** 游戏私有的额外标量，如 2048 的 score、贪吃蛇的方向与蛇身队列 */
  extra: Record<string, number | number[]>;
  status: 'playing' | 'won' | 'lost' | 'draw';
  score: number;
  /** 确定性随机的游标：每次消费随机数后自增，保证回放一致 */
  rngCursor: number;
}

export interface GameDefinition<M = number> {
  id: string;
  name: string;
  players: 1 | 2;
  /** 信息不完全的游戏为 true，客户端只拿 view() 的结果 */
  hiddenInfo: boolean;
  rulesetVersion: number;

  init(seed: string, options?: Record<string, unknown>): GameState;

  /** 当前可走的全部合法走法，UI 高亮 + AI 约束 + 非法走法兜底都用它 */
  legalMoves(s: GameState): M[];

  /** 纯函数。非法走法必须抛错，不允许静默忽略 */
  reduce(s: GameState, move: M, seed: string): GameState;

  isTerminal(s: GameState): boolean;
  /** 单人=分数；双人=从 seat 视角的结果 */
  scoreOf(s: GameState, seat: number): number;

  /** 下发给客户端/AI 的可见视图（完全信息游戏直接返回 s） */
  view(s: GameState, seat: number): GameState;

  /** 给模型看的文本形式，见 06-ai-players.md */
  toPrompt(s: GameState, seat: number): string;
  /** 解析模型输出为走法，失败返回 null */
  parseMove(text: string, s: GameState): M | null;

  /** 稳定哈希，用于校验与回放核对 */
  hash(s: GameState): string;
}
```

## 确定性随机

不用 `Math.random()`。用 seed + `rngCursor` 驱动的 PRNG（如 xorshift128 / splitmix32）：

```ts
function rand(seed: string, cursor: number): number  // 纯函数，同样输入同样输出
```

`reduce` 内需要随机时读 `rand(seed, s.rngCursor)` 并把 `rngCursor + 1` 写进新状态。
这样**整局只需要 `seed + moves[]` 就能逐帧重放**，回放不需要存任何中间状态。

## 服务端校验

Durable Object 持有权威 `GameState`。客户端提交走法时：

1. 检查 `move ∈ legalMoves(state)`
2. `next = reduce(state, move, seed)`
3. 比对客户端上报的 `clientStateHash` 与服务端 `hash(state)`——不一致说明客户端被篡改或版本不匹配
4. 追加走法到缓冲区

客户端本地也跑同一份 `reduce` 做乐观更新，服务端确认后校正。用户感知是零延迟的。

## 回放

```ts
function replay(def: GameDefinition, seed: string, moves: unknown[]): GameState[] {
  let s = def.init(seed);
  const frames = [s];
  for (const m of moves) frames.push((s = def.reduce(s, m, seed)));
  return frames;
}
```

回放器就是一个 `frames[i]` 的滑块，外加侧栏显示 AI 在该步的推理文本。

## 测试策略

每个游戏必须有：

- **规则单测**：已知局面 → 合法走法集合、终局判定
- **确定性测试**：同一 seed + 同一走法序列，跑 100 次哈希完全一致
- **不可变性测试**：`reduce` 不修改入参
- **模糊测试**：随机走 10 万局，断言永不抛出未预期异常、永远能终局（有步数上限）
- **黄金回放**：存几局历史对局的 `seed + moves + finalHash` 作为快照测试，
  防止规则改动悄悄破坏老回放（真要改规则就升 `rulesetVersion`，老榜单独归档）

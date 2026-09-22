/**
 * 所有游戏共用的状态与定义。
 *
 * 约束（务必遵守，否则回放和服务端校验会失效）：
 *  - reduce 必须是纯函数：不修改入参、不读时钟、不用 Math.random
 *  - 全部随机性来自 seed + state.rngCursor
 *  - 状态必须能被 JSON 序列化（所以用 number[] 而不是 TypedArray）
 */

export type GameStatus = 'playing' | 'won' | 'lost' | 'draw';

/** 走法：一个整数，或一个字段都是整数的小对象 */
export type Move = number | Record<string, number>;

export interface GameState {
  /** 主棋盘，一维展开：idx = r * cols + c */
  board: number[];
  rows: number;
  cols: number;
  /** 轮到哪个座位（单人游戏恒为 0） */
  turn: number;
  status: GameStatus;
  /** 始终「越大越好」，方便排行榜统一处理 */
  score: number;
  /** 已走步数 */
  plies: number;
  /** 确定性随机游标：每消费一个随机数就 +1 */
  rngCursor: number;
  /** 游戏私有数据。隐藏信息放在以 `_` 开头的键里，view() 会剥掉 */
  extra: Record<string, number | number[]>;
}

/** 前端渲染提示（纯数据 / 纯函数，不碰 DOM） */
export interface GameUi {
  /** 棋盘格子的额外 class，用于配色 */
  cellClass(v: number, s: GameState, idx: number): string;
  /** 格子里显示的文字，空字符串表示不显示 */
  cellLabel(v: number, s: GameState, idx: number): string;
  /** 键盘映射：KeyboardEvent.key -> 走法 */
  keys?: Record<string, Move>;
  /** 是否响应滑动手势（方向 0上 1右 2下 3左） */
  swipe?: boolean;
  /** 点击格子产生的走法；返回 null 表示该格不可点 */
  clickCell?(idx: number, s: GameState): Move | null;
  /** 右键/长按格子产生的走法（扫雷插旗） */
  altClickCell?(idx: number, s: GameState): Move | null;
  /** 需要先选中一个值再点格子（数独） */
  palette?: { values: number[]; label(v: number): string };
  /** 配合 palette：选中值 val 后点击格子 idx 产生的走法 */
  paletteMove?(idx: number, val: number, s: GameState): Move | null;
  /** 额外按钮 */
  buttons?: { label: string; move: Move }[];
  /** 格子边长的 CSS 尺寸提示 */
  cellSize?: number;
  /**
   * 自动推进的间隔（毫秒）。贪吃蛇这类游戏会按固定节奏走子，
   * 玩家只负责改方向。服务端据此跳过「操作节奏过于均匀」的反作弊判定。
   */
  autoTickMs?: number;
}

export interface GameMeta {
  id: string;
  /** 中文名 */
  name: string;
  /** 英文名，用于 URL 和英文页 */
  nameEn: string;
  /** 一句话介绍 */
  tagline: string;
  players: 1 | 2;
  /** 信息不完全：客户端与 AI 只能看到 view() 的结果 */
  hiddenInfo: boolean;
  /** 规则版本，规则变更后老榜单独归档 */
  rulesetVersion: number;
  /** 单局步数硬上限，防止死循环烧钱 */
  maxPlies: number;
  /** AI 每步的输出 token 预算 */
  aiMaxTokens: number;
}

export interface GameDefinition<M extends Move = Move> extends GameMeta {
  init(seed: string): GameState;
  legalMoves(s: GameState): M[];
  /** 非法走法必须抛错，不允许静默忽略 */
  reduce(s: GameState, move: M, seed: string): GameState;
  isTerminal(s: GameState): boolean;
  /** 从 seat 视角的分数，始终越大越好 */
  scoreOf(s: GameState, seat: number): number;
  /** 下发给客户端 / AI 的可见视图 */
  view(s: GameState, seat: number): GameState;
  /** 文本棋盘，喂给模型也用于调试 */
  render(s: GameState, seat: number): string;
  /** 规则说明，拼进 system prompt */
  rules(seat: number): string;
  /** 走法 -> 模型可输出的文本 */
  moveToText(m: M): string;
  /** 模型输出 -> 走法；解析失败返回 null */
  parseMove(text: string, s: GameState): M | null;
  /**
   * 合法走法太多时（如数独），用一段紧凑文本代替逐条列举喂给模型。
   * 返回 null 表示按常规列举。
   */
  legalSummary?(s: GameState): string | null;
  ui: GameUi;
}

export type AnyGameDefinition = GameDefinition<any>;

export function cloneState(s: GameState): GameState {
  const extra: Record<string, number | number[]> = {};
  for (const k of Object.keys(s.extra)) {
    const v = s.extra[k];
    extra[k] = Array.isArray(v) ? v.slice() : v;
  }
  return { ...s, board: s.board.slice(), extra };
}

/** 剥掉以 `_` 开头的隐藏字段 */
export function stripHidden(s: GameState): GameState {
  const extra: Record<string, number | number[]> = {};
  for (const k of Object.keys(s.extra)) {
    if (k.startsWith('_')) continue;
    const v = s.extra[k];
    extra[k] = Array.isArray(v) ? v.slice() : v;
  }
  return { ...s, board: s.board.slice(), extra };
}

export class IllegalMoveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IllegalMoveError';
  }
}

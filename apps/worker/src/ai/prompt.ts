import type { AnyGameDefinition, GameState, Move } from '@gap/games';

/** 合法走法列表最多列这么多条，超了就截断（数独等走 legalSummary） */
const MAX_LISTED_MOVES = 60;

export interface BuiltPrompt {
  system: string;
  user: string;
}

/**
 * 三段式：规则 → 当前局面 → 输出格式。
 *
 * 只发当前局面，不发历史走法 —— 游戏是马尔可夫的，这是压 token 最有效的一招。
 */
export function buildPrompt(def: AnyGameDefinition, state: GameState, seat: number): BuiltPrompt {
  const view = def.view(state, seat);
  const legal = def.legalMoves(view) as Move[];
  const sample = legal.length ? def.moveToText(legal[0]) : '';

  const system = [
    def.rules(seat),
    '',
    'HOW TO ANSWER',
    '- Think briefly about the position first. Keep it short.',
    `- Then put your move on the LAST line, in exactly this format:  MOVE: ${sample || '<move>'}`,
    '- Output nothing after that line.',
  ].join('\n');

  const parts: string[] = [];
  parts.push('CURRENT POSITION');
  parts.push(def.render(view, seat));
  parts.push('');

  const summary = def.legalSummary?.(view);
  if (summary) {
    parts.push(summary);
  } else if (legal.length <= MAX_LISTED_MOVES) {
    parts.push(`LEGAL MOVES: ${legal.map((m) => def.moveToText(m)).join(', ')}`);
  } else {
    const shown = legal.slice(0, MAX_LISTED_MOVES).map((m) => def.moveToText(m)).join(', ');
    parts.push(`LEGAL MOVES (${legal.length} total, showing ${MAX_LISTED_MOVES}): ${shown}, ...`);
  }

  parts.push('');
  if (def.players === 1) parts.push(`Score so far: ${view.score}. Moves played: ${view.plies}.`);
  else parts.push(`Move number: ${view.plies + 1}.`);
  parts.push(`Your move (format "MOVE: ${sample || '<move>'}"):`);

  return { system, user: parts.join('\n') };
}

/** 模型走了非法走法后的纠错提示 */
export function buildRetryPrompt(
  def: AnyGameDefinition, state: GameState, seat: number, attempt: number, error: string,
): BuiltPrompt {
  const base = buildPrompt(def, state, seat);
  const view = def.view(state, seat);
  const legal = def.legalMoves(view) as Move[];
  const shown = legal.slice(0, MAX_LISTED_MOVES).map((m) => def.moveToText(m)).join(', ');
  const strict = attempt >= 2
    ? '\nThis is your LAST attempt. Answer with the MOVE line only, no reasoning at all.'
    : '';
  return {
    system: base.system,
    user: `${base.user}\n\nYour previous answer was rejected: ${error}\nChoose one of: ${shown}${strict}`,
  };
}

/** 支持结构化输出的模型走这个 schema，解析更稳 */
export const MOVE_SCHEMA = {
  name: 'game_move',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      reasoning: { type: 'string', description: 'Short reasoning, at most two sentences.' },
      move: { type: 'string', description: 'The move, in the exact notation the rules describe.' },
    },
    required: ['reasoning', 'move'],
    additionalProperties: false,
  },
} as const;

/** 把模型回复拆成「推理」和「走法文本」 */
export function splitResponse(text: string): { thought: string | null; moveText: string } {
  const trimmed = text.trim();
  // 结构化输出
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed) as { reasoning?: string; move?: string };
      if (typeof obj.move === 'string') return { thought: obj.reasoning ?? null, moveText: obj.move };
    } catch {
      // 落到下面的正则
    }
  }
  const m = /MOVE\s*[:：]\s*(.+?)\s*$/im.exec(trimmed);
  if (m) {
    const thought = trimmed.slice(0, m.index).trim();
    return { thought: thought || null, moveText: m[1].trim() };
  }
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim());
  const last = lines.length ? lines[lines.length - 1].trim() : '';
  return { thought: lines.slice(0, -1).join('\n').trim() || null, moveText: last };
}

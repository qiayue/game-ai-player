/**
 * 回放播放器。
 *
 * 回放数据只有 seed + 走法序列，所有帧都在浏览器本地重放出来，
 * 服务端不参与逐帧计算。AI 的推理文本按需再拉。
 */
import type { GameState } from '@gap/games';
import { loadGame } from './play.js';
import { mountBoard } from './board.js';

interface ReplayPackage {
  matchId: string;
  gameId: string;
  seed: string;
  moves: unknown[];
  stepMs: number[];
  players: { seat: number; displayName: string; modelKey: string | null }[];
}

interface AiStep {
  ply: number;
  moveText: string | null;
  thought: string | null;
  prompt: string;
  response: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  attempts: { response: string; error: string }[];
}

async function main(): Promise<void> {
  const root = document.getElementById('replay');
  const dataEl = document.getElementById('replay-data');
  if (!root || !dataEl?.textContent) return;

  const pkg = JSON.parse(dataEl.textContent) as ReplayPackage;
  const isAi = root.dataset.ai === '1';
  const mod = await loadGame(pkg.gameId);

  let states: GameState[];
  try {
    states = mod.frames(mod.game, pkg.seed, pkg.moves as never[]);
  } catch (err) {
    document.getElementById('replay-board')!.textContent =
      `回放失败：${err instanceof Error ? err.message : String(err)}`;
    return;
  }

  const host = document.getElementById('replay-board')!;
  const board = mountBoard(host, mod.game, states[0], { readonly: true });
  const slider = document.getElementById('rp-slider') as HTMLInputElement;
  const label = document.getElementById('rp-label')!;
  const playBtn = document.getElementById('rp-play') as HTMLButtonElement;
  const thought = document.getElementById('rp-thought');
  const promptEl = document.getElementById('rp-prompt');
  const promptWrap = document.getElementById('rp-prompt-wrap');

  const stepCache = new Map<number, AiStep | null>();
  let index = 0;
  let timer: number | undefined;

  function show(i: number): void {
    index = Math.max(0, Math.min(i, states.length - 1));
    board.update(states[index]);
    slider.value = String(index);
    const s = states[index];
    label.textContent = `${index} / ${states.length - 1} · ${s.score} 分`;
    if (isAi) void showThought(index);
  }

  async function showThought(i: number): Promise<void> {
    if (!thought) return;
    if (i === 0) {
      thought.textContent = '开局。拖动进度条或点播放，看模型每一步的判断。';
      if (promptEl) promptEl.textContent = '';
      return;
    }
    const ply = i - 1;
    thought.textContent = '读取中…';
    let rec = stepCache.get(ply);
    if (rec === undefined) {
      try {
        const res = await fetch(`/api/replays/${pkg.matchId}/ai/${ply}`);
        rec = res.ok ? ((await res.json()) as AiStep) : null;
      } catch {
        rec = null;
      }
      stepCache.set(ply, rec);
    }
    if (index !== i) return; // 用户已经拖到别的地方了
    if (!rec) {
      thought.textContent = '这一步没有留下 AI 记录。';
      if (promptWrap) promptWrap.classList.add('hidden');
      return;
    }
    const head = `第 ${ply + 1} 步 → ${rec.moveText ?? '（非法走法）'}`
      + ` · ${(rec.latencyMs / 1000).toFixed(1)}s`
      + ` · ${rec.inputTokens}+${rec.outputTokens} tokens`
      + (rec.attempts?.length ? ` · 重试 ${rec.attempts.length} 次` : '');
    thought.textContent = `${head}\n\n${rec.thought ?? rec.response ?? ''}`;
    if (promptWrap) promptWrap.classList.remove('hidden');
    if (promptEl) {
      promptEl.textContent = `${rec.prompt}\n\n===== 模型回复 =====\n${rec.response}`
        + (rec.attempts?.length
          ? `\n\n===== 被拒绝的尝试 =====\n${rec.attempts.map((a) => `${a.response}\n→ ${a.error}`).join('\n\n')}`
          : '');
    }
  }

  function stop(): void {
    if (timer) { clearInterval(timer); timer = undefined; }
    playBtn.textContent = '播放';
  }

  playBtn.addEventListener('click', () => {
    if (timer) { stop(); return; }
    if (index >= states.length - 1) show(0);
    playBtn.textContent = '暂停';
    timer = window.setInterval(() => {
      if (index >= states.length - 1) { stop(); return; }
      show(index + 1);
    }, isAi ? 700 : 260);
  });
  document.getElementById('rp-next')!.addEventListener('click', () => { stop(); show(index + 1); });
  document.getElementById('rp-prev')!.addEventListener('click', () => { stop(); show(index - 1); });
  document.getElementById('rp-first')!.addEventListener('click', () => { stop(); show(0); });
  slider.addEventListener('input', () => { stop(); show(Number(slider.value)); });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') { stop(); show(index + 1); }
    else if (e.key === 'ArrowLeft') { stop(); show(index - 1); }
    else if (e.key === ' ') { e.preventDefault(); playBtn.click(); }
  });

  show(0);
}

void main();

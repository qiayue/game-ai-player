/**
 * 浏览器验证：真的点开页面玩几步，顺便把截图存到 .shots/。
 *
 *   npx playwright install chromium   # 只需一次
 *   npm run dev                       # 另开一个终端
 *   npm run smoke:ui
 */
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:8787';
const OUT = process.env.SHOT_DIR ?? '.shots';
let pass = 0, fail = 0;
const check = (n, ok, extra = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${extra}`)); };

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] } : {},
);
const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

console.log('\n[首页]');
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
check('标题渲染', (await page.title()).includes('Game AI Player'));
check('11 个游戏卡片', (await page.locator('.game-card').count()) === 11);
await page.screenshot({ path: `${OUT}/shot-home.png`, fullPage: false });

console.log('\n[2048 实际可玩]');
await page.goto(`${BASE}/games/2048`, { waitUntil: 'networkidle' });
const jsBefore = await page.evaluate(() => performance.getEntriesByType('resource')
  .filter((r) => r.name.includes('/assets/')).map((r) => r.name.split('/assets/')[1]));
check('进页面时没有加载任何游戏代码', !jsBefore.some((n) => n.startsWith('games/')), JSON.stringify(jsBefore));

await page.click('#play-btn');
await page.waitForSelector('.board > div', { timeout: 10000 });
check('棋盘渲染出 16 格', (await page.locator('.board > div').count()) === 16);
const jsAfter = await page.evaluate(() => performance.getEntriesByType('resource')
  .filter((r) => r.name.includes('/assets/games/')).map((r) => r.name.split('/assets/')[1]));
check('点开始后才按需加载 2048 模块', jsAfter.some((n) => n.includes('2048')), JSON.stringify(jsAfter));

const before = await page.locator('#hud').textContent();
for (const key of ['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp']) {
  await page.keyboard.press(key);
  await page.waitForTimeout(90);
}
const after = await page.locator('#hud').textContent();
check('方向键能走子，步数在涨', before !== after, `${before} → ${after}`);
check('分数显示正常', /分数 \d+ · \d+ 步/.test(after ?? ''), after ?? '');
await page.screenshot({ path: `${OUT}/shot-2048.png` });

console.log('\n[井字棋点击落子]');
await page.goto(`${BASE}/games/tictactoe`, { waitUntil: 'networkidle' });
await page.click('#play-btn');
await page.waitForSelector('.board > div');
await page.locator('.board > div').nth(4).click();
await page.waitForTimeout(150);
check('点格子能落子', (await page.locator('.board > div').nth(4).textContent()) === 'X');
await page.screenshot({ path: `${OUT}/shot-tictactoe.png` });

console.log('\n[扫雷：逐步提交给服务端]');
await page.goto(`${BASE}/games/minesweeper`, { waitUntil: 'networkidle' });
await page.click('#play-btn');
await page.waitForSelector('.board > div');
await page.locator('.board > div').nth(40).click();
await page.waitForTimeout(800);
const opened = await page.locator('.ms-open').count();
check('点击后服务端返回了翻开的格子', opened > 0, `翻开 ${opened} 格`);
await page.screenshot({ path: `${OUT}/shot-minesweeper.png` });

console.log('\n[数独：选数字再点格]');
await page.goto(`${BASE}/games/sudoku`, { waitUntil: 'networkidle' });
await page.click('#play-btn');
await page.waitForSelector('.palette button');
check('数字选择面板渲染出来了', (await page.locator('.palette button').count()) === 10);
await page.screenshot({ path: `${OUT}/shot-sudoku.png` });

console.log('\n[回放页]');
const lb = await (await fetch(`${BASE}/api/leaderboards/tictactoe?track=ai`)).json();
const matchId = lb.rows?.[0]?.bestMatch;
if (matchId) {
  await page.goto(`${BASE}/replay/${matchId}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#replay-board .board > div', { timeout: 10000 });
  check('回放棋盘渲染', (await page.locator('#replay-board .board > div').count()) > 0);
  await page.click('#rp-next');
  await page.waitForTimeout(600);
  check('下一步按钮能推进', (await page.locator('#rp-label').textContent())?.startsWith('1 /'));
  const thought = await page.locator('#rp-thought').textContent();
  check('能看到 AI 那一步的推理', (thought ?? '').includes('第 1 步'), thought?.slice(0, 80) ?? '');
  await page.screenshot({ path: `${OUT}/shot-replay.png` });
} else {
  check('有 AI 回放可测', false);
}

console.log('\n[移动端]');
const m = await ctx.newPage();
await m.setViewportSize({ width: 390, height: 844 });
await m.goto(`${BASE}/games/2048`, { waitUntil: 'networkidle' });
const overflow = await m.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
check('手机宽度下没有横向溢出', overflow <= 0, `溢出 ${overflow}px`);
await m.screenshot({ path: `${OUT}/shot-mobile.png`, fullPage: false });

check('没有 JS 报错', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
console.log(`\n通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);

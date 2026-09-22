/**
 * 前端构建：
 *  1. 为每个游戏生成一个入口，单独打成一个 ES module，用户点「开始游戏」才加载
 *  2. app / play / replay / board 共享的部分由 esbuild 的 code splitting 抽成公共 chunk
 *  3. 产物进 apps/web/public/assets，和 Worker 一起部署
 */
import { build } from 'esbuild';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entriesDir = resolve(root, 'apps/web/.entries/games');
const outdir = resolve(root, 'apps/web/public/assets');

/** gameId -> [模块文件名, 导出名] */
const GAMES = {
  '2048': ['g2048', 'g2048'],
  tictactoe: ['tictactoe', 'tictactoe'],
  connect4: ['connect4', 'connect4'],
  gomoku: ['gomoku', 'gomoku'],
  othello: ['othello', 'othello'],
  snake: ['snake', 'snake'],
  minesweeper: ['minesweeper', 'minesweeper'],
  sudoku: ['sudoku', 'sudoku'],
  fifteen: ['fifteen', 'fifteen'],
  sokoban: ['sokoban', 'sokoban'],
  memory: ['memory', 'memory'],
};

await rm(outdir, { recursive: true, force: true });
await rm(resolve(root, 'apps/web/.entries'), { recursive: true, force: true });
await mkdir(entriesDir, { recursive: true });

const entryPoints = {
  app: resolve(root, 'apps/web/src/app.ts'),
  play: resolve(root, 'apps/web/src/play.ts'),
  replay: resolve(root, 'apps/web/src/replay.ts'),
  board: resolve(root, 'apps/web/src/board.ts'),
};

for (const [id, [file, exportName]] of Object.entries(GAMES)) {
  const path = resolve(entriesDir, `${id}.ts`);
  await writeFile(
    path,
    `// 自动生成，勿手改。由 scripts/build.mjs 产生。\n`
      + `export { ${exportName} as game } from '../../../../packages/games/src/games/${file}.js';\n`
      + `export { hashState } from '../../../../packages/games/src/core/hash.js';\n`
      + `export { frames, validate } from '../../../../packages/games/src/core/replay.js';\n`,
    'utf8',
  );
  entryPoints[`games/${id}`] = path;
}

const result = await build({
  entryPoints,
  outdir,
  bundle: true,
  splitting: true,
  format: 'esm',
  target: ['es2022'],
  platform: 'browser',
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  metafile: true,
  logLevel: 'info',
});

const sizes = Object.entries(result.metafile.outputs)
  .map(([f, o]) => [f.replace(/.*public\//, ''), o.bytes])
  .sort((a, b) => b[1] - a[1]);
console.log('\n产物大小：');
for (const [f, b] of sizes) console.log(`  ${(b / 1024).toFixed(1).padStart(7)} KB  ${f}`);
console.log(`  ${(sizes.reduce((n, [, b]) => n + b, 0) / 1024).toFixed(1).padStart(7)} KB  合计\n`);

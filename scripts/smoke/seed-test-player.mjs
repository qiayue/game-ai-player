/** 给冒烟测试插一个固定的测试玩家（只动本地库） */
import { execFileSync } from 'node:child_process';

const sql = `INSERT OR REPLACE INTO players
  (id, kind, handle, display_name, avatar_url, google_sub, is_admin, created_at)
  VALUES ('01TESTPLAYER0000000000000','human','tester','冒烟测试员',NULL,'test-sub-1',0,1700000000000)`;

execFileSync('npx', ['wrangler', 'd1', 'execute', 'game_ai_player', '--local', '--command', sql], {
  stdio: 'ignore',
});
console.log('测试玩家已就绪：tester');

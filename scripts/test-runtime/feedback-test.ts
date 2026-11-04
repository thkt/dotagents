import { spawn } from 'node:child_process';
import { withoutAutoMaintenance } from './runner.ts';

// `.feedback-loop.json`のbunArgsから、`bun <このファイル> test ...`の形で起動します。
// runtime.mjsは環境変数の指定を持たないため、runner.tsと同じ環境でbun testを起動します。
// Bunは起動時にCIを判定するので、--env-fileやpreloadでは1ファイル実行のtest.onlyを拒否できません。
const child = spawn(process.execPath, process.argv.slice(2), {
  stdio: 'inherit',
  env: { ...withoutAutoMaintenance(process.env), CI: 'true' },
});
// 取消はプロセスグループ全体へ届くため、bun testの終了を待って同じ結果を返します。
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {});
}
child.once('error', (error) => {
  console.error(error.message);
  process.exit(1);
});
child.once('close', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});

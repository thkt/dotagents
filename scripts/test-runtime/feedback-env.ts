// `.feedback-loop.json`のtestArgsから読みます。runtime.mjsは環境変数の指定を持たないため、
// runner.tsのwithoutAutoMaintenanceと同じくgitの自動maintenanceを止めます。
// 共通化しない理由: このファイルがimportしたモジュールはテストの所有者が決まる前に読まれ、依存記録から漏れます。
const count = Number(process.env.GIT_CONFIG_COUNT ?? 0);
const keys = Array.from({ length: count }, (_, index) => process.env[`GIT_CONFIG_KEY_${index}`]);
if (!keys.includes('maintenance.auto')) {
  process.env.GIT_CONFIG_COUNT = String(count + 2);
  process.env[`GIT_CONFIG_KEY_${count}`] = 'maintenance.auto';
  process.env[`GIT_CONFIG_VALUE_${count}`] = 'false';
  process.env[`GIT_CONFIG_KEY_${count + 1}`] = 'gc.auto';
  process.env[`GIT_CONFIG_VALUE_${count + 1}`] = '0';
}
export {};

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [root, trigger, role] = process.argv.slice(2);
assert(root && trigger);
if (role === 'descendant') {
  writeFileSync(join(root, 'descendant.pid'), String(process.pid));
  const beat = () => writeFileSync(join(root, 'heartbeat'), String(Date.now()));
  beat();
  setInterval(beat, 20);
} else {
  writeFileSync(join(root, 'group.pid'), String(process.pid));
  spawn(process.execPath, [import.meta.path, root, trigger, 'descendant'], { stdio: 'inherit' });
  while (!existsSync(join(root, 'heartbeat'))) {
    await Bun.sleep(10);
  }
  process.stdout.write('取得済みstdout\n');
  process.stderr.write('取得済みstderr\n');
  writeFileSync(join(root, 'ready'), 'ready');
  if (trigger === 'exit') {
    setTimeout(() => process.exit(7), 100);
  } else {
    setInterval(() => {}, 1000);
  }
}

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { nativeCommand } from '../light-native.ts';

export const lightNativeWorker = import.meta.path;

if (import.meta.main) {
  const [mode, ready] = process.argv.slice(2);
  assert(mode && ready);
  if (mode === 'operation') {
    const child = Bun.spawn(['/bin/sleep', '600'], { stdout: 'ignore', stderr: 'ignore' });
    await writeFile(ready, JSON.stringify([process.pid, child.pid]));
    console.log('SYNTHETIC_OPERATION_REACHED');
    await child.exited;
  } else {
    assert(mode === 'wrapper');
    const result = await nativeCommand(
      [process.execPath, import.meta.path, 'operation', ready],
      process.cwd(),
      '',
      10000,
      { PATH: '/usr/bin:/bin' },
    );
    console.log(JSON.stringify(result));
  }
}

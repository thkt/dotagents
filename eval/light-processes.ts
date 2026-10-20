import { spawnSync } from 'node:child_process';

type Identity = { pid: number; parent: number; group: number; birth: string };

function processTable() {
  const result = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart='], {
    encoding: 'utf8',
    timeout: 1000,
    maxBuffer: 8 * 1024 * 1024,
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
  });
  if (result.error || result.status !== 0) {
    throw new Error('通常の子処理を観測できません');
  }
  const table = new Map<number, Identity>();
  for (const line of result.stdout.split('\n').filter(Boolean)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match?.[1] || !match[2] || !match[3] || !match[4]) {
      throw new Error('プロセス観測の形式が不明です');
    }
    const pid = Number(match[1]);
    table.set(pid, {
      pid,
      parent: Number(match[2]),
      group: Number(match[3]),
      birth: match[4],
    });
  }
  return table;
}

// CLIの通常ツールも別sessionを作るため、CLIのgroupだけでは終了確認にならない。
// 観測した通常の子孫を開始時刻とともに保持する。敵対的なdaemonの捕捉は保証しない。
export class LightProcesses {
  private readonly known = new Map<number, Identity>();
  private failed = false;
  constructor(private readonly root: number | undefined) {
    this.observe();
  }
  private observe() {
    try {
      const table = processTable();
      if (this.root && this.known.size === 0) {
        const root = table.get(this.root);
        if (root) {
          this.known.set(root.pid, root);
        }
      }
      let changed = true;
      while (changed) {
        changed = false;
        for (const current of table.values()) {
          const parent = this.known.get(current.parent);
          if (
            parent &&
            table.get(parent.pid)?.birth === parent.birth &&
            !this.known.has(current.pid)
          ) {
            this.known.set(current.pid, current);
            changed = true;
          }
        }
      }
      return table;
    } catch {
      this.failed = true;
      return null;
    }
  }
  sample() {
    this.observe();
    return !this.failed;
  }
  kill() {
    const table = this.observe();
    for (const entry of this.known.values()) {
      // PID再利用後の別処理へシグナルを送らない。
      if (table?.get(entry.pid)?.birth !== entry.birth) {
        continue;
      }
      try {
        process.kill(entry.pid, 'SIGKILL');
      } catch (cause) {
        if (!(cause instanceof Error && 'code' in cause && cause.code === 'ESRCH')) {
          this.failed = true;
        }
      }
    }
  }
  result() {
    const table = this.observe();
    const records = [...this.known.values()].map((entry) => ({
      ...entry,
      stopped: table !== null && table.get(entry.pid)?.birth !== entry.birth,
    }));
    return {
      stopped: !this.failed && records.every((entry) => entry.stopped),
      records,
      observationFailed: this.failed,
    };
  }
}

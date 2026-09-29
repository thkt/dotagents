// 調査専用。GitHubとモデル応答は模擬し、送信だけ一時bare repoへ実行する。
import { expect } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { testDevelopment, git } from '../../../scripts/tests/support/development.ts';
import { develop } from '../../../scripts/implement/orchestrator.ts';
import { withInterrupts } from '../../../scripts/shared/process.ts';

for (const mode of ['unchanged', 'branchRace', 'pinnedCandidate'] as const) {
  testDevelopment(`quint ${mode}`, async (f) => {
    const originalCommand = f.io.command;
    let verified = '';
    let current = '';
    let received = '';
    let refspec = '';
    f.io.command = async (argv, cwd, input, timeout, prefix) => {
      if (argv[0] === 'git' && argv.includes('push')) {
        verified = await git(cwd, 'rev-parse', 'HEAD');
        if (mode !== 'unchanged') {
          await writeFile(join(cwd, 'result.txt'), 'unverified');
          await git(cwd, 'add', 'result.txt');
          await git(cwd, 'commit', '-m', '試行用の並行変更');
        }
        current = await git(cwd, 'rev-parse', 'HEAD');
        refspec = argv.at(-1)!;
        const bare = join(f.dir, 'receiver.git');
        await git(cwd, 'init', '--bare', bare);
        // 通信先をローカルへ置き換え、file転送だけを許可する。
        // 比較案だけ送信元を検証済みSHAへ置き換える。
        const localRefspec = mode === 'pinnedCandidate'
          ? `${verified}:${refspec.split(':')[1]}` : refspec;
        const local = argv.slice(1).map((arg) =>
          arg.replace(`https://github.com/${f.settings.repository}.git`, bare));
        local.splice(local.indexOf('push'), 0, '-c', 'protocol.file.allow=always');
        local[local.length - 1] = localRefspec;
        await git(cwd, ...local);
        received = await git(bare, 'rev-parse', refspec.split(':')[1]!);
        expect(await git(bare, 'show', `${received}:result.txt`))
          .toBe(mode === 'branchRace' ? 'unverified' : 'implemented');
      }
      return originalCommand(argv, cwd, input, timeout, prefix);
    };
    let failure: string | null = null;
    try {
      await withInterrupts(() => develop(f.args, f.io));
    } catch (error) {
      failure = String(error);
    }
    const result = JSON.parse(await readFile(join(f.dir, 'result.json'), 'utf8'));
    expect(verified).not.toBe('');
    expect(refspec).toBe('codex/development-99:refs/heads/codex/development-99');
    expect(received).toBe(mode === 'branchRace' ? current : verified);
    if (mode !== 'unchanged') expect(current).not.toBe(verified);
    if (mode === 'unchanged') {
      expect(failure).toBeNull();
      expect(result.status).toBe('published_draft');
    } else if (mode === 'branchRace') {
      expect(failure).toContain('target_changed');
      expect(result.status).toBe('stopped');
    }
    // pinnedCandidateではPRのheadを読む既存fixtureがローカルHEADを使う。
    // その後の停止は比較案の実GitHub挙動として評価しない。
    console.log(JSON.stringify({ mode, verified, current, received, refspec,
      status: result.status, reason: result.reasonCode, failure,
      pushes: f.calls.pushes, publications: f.calls.publications }));
  });
}

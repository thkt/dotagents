import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  editedMarkdownFiles,
  fixMarkdown,
  hasJapanese,
  JAPANESE_THRESHOLD,
} from '../../../.codex/hooks/textlint-fix.ts';

const AGENTS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HOOKS_CONFIG = path.resolve(AGENTS_ROOT, '../.codex/hooks.json');

test('resolves Markdown files from Codex edit payloads', () => {
  assert.deepEqual(editedMarkdownFiles({
    cwd: '/repo',
    tool_name: 'apply_patch',
    tool_input: {
      command: [
        '*** Begin Patch',
        '*** Update File: docs/guide.md',
        '*** Move to: docs/moved.md',
        '*** Update File: src/index.ts',
        '*** Delete File: docs/removed.md',
        '*** End Patch',
      ].join('\n'),
    },
  }), ['/repo/docs/guide.md', '/repo/docs/moved.md']);
  assert.deepEqual(editedMarkdownFiles({
    cwd: '/repo',
    tool_name: 'Write',
    tool_input: { file_path: 'README.md' },
  }), ['/repo/README.md']);
});

test('uses Claude Code Japanese detection threshold', () => {
  assert.equal(hasJapanese('日'.repeat(JAPANESE_THRESHOLD - 1)), false);
  assert.equal(hasJapanese('日'.repeat(JAPANESE_THRESHOLD)), true);
});

test('auto-fixes Japanese Markdown with the shared textlint config', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-textlint-'));
  const file = path.join(root, 'guide.md');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(file, `${'これは日本語の文章です。'.repeat(6)}APIを使用する。\n`);
  assert.equal(fixMarkdown(file), true);
  assert.match(fs.readFileSync(file, 'utf8'), /API を使用する。/);
});

test('registers only the TypeScript textlint hook for Markdown edits', () => {
  const config = JSON.parse(fs.readFileSync(HOOKS_CONFIG, 'utf8'));
  const commands: string[] = config.hooks.PostToolUse
    .flatMap((entry: { hooks: Array<{ command?: string }> }) => entry.hooks)
    .map((hook: { command?: string }) => hook.command || '')
    .filter((command: string) => command.includes('textlint-fix'));
  assert.deepEqual(commands, [
    'node "${CODEX_HOME:-$HOME/.codex}/hooks/textlint-fix.ts"',
  ]);
});

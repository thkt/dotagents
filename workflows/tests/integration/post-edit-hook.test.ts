/** @file Outcome: Post-edit checks safely fix supported files and return actionable diagnostics. */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { onTestFinished, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

import {
  editedFiles,
  fixMarkdown,
  hasJapanese,
  JAPANESE_THRESHOLD,
  postEdit,
} from '../../../hooks/post-edit.ts';

const AGENTS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const HOOKS_CONFIGS = [path.join(AGENTS_ROOT, 'hooks/hooks.json')];

test('resolves files from Codex edit payloads', () => {
  assert.deepEqual(
    editedFiles({
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
    }),
    ['/repo/docs/guide.md', '/repo/docs/moved.md', '/repo/src/index.ts'],
  );
  assert.deepEqual(
    editedFiles({
      cwd: '/repo',
      tool_name: 'Write',
      tool_input: { file_path: 'README.md' },
    }),
    ['/repo/README.md'],
  );
});

test('formats edited source and returns the changed file as feedback', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-post-edit-'));
  const file = path.join(root, 'index.ts');
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(file, 'export const value={message:"ok"}\n');

  const result = postEdit({
    cwd: root,
    tool_name: 'Write',
    tool_input: { file_path: file },
  });

  assert.match(fs.readFileSync(file, 'utf8'), /export const value = \{ message: 'ok' \};/u);
  assert.match(result.hookSpecificOutput?.additionalContext ?? '', /index\.ts/u);
});

test('uses Claude Code Japanese detection threshold', () => {
  assert.equal(hasJapanese('日'.repeat(JAPANESE_THRESHOLD - 1)), false);
  assert.equal(hasJapanese('日'.repeat(JAPANESE_THRESHOLD)), true);
});

test('auto-fixes Japanese Markdown with the shared textlint config', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-textlint-'));
  const file = path.join(root, 'guide.md');
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(file, `${'これは日本語の文章です。'.repeat(6)}APIを使用する。\n`);
  assert.equal(fixMarkdown(file), true);
  assert.match(fs.readFileSync(file, 'utf8'), /API を使用する。/);
}, 15_000);

test('fails when textlint exits non-zero', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-textlint-failure-'));
  const file = path.join(root, 'guide.md');
  const executable = path.join(root, 'textlint');
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(file, `${'これは日本語の文章です。'.repeat(6)}\n`);
  fs.writeFileSync(executable, '#!/bin/sh\necho "actionable textlint feedback"\nexit 1\n', {
    mode: 0o755,
  });
  assert.throws(() => fixMarkdown(file, executable), /actionable textlint feedback/u);
});

test('returns oxlint agent diagnostics when a source issue remains', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-oxlint-feedback-'));
  const file = path.join(root, 'index.ts');
  const oxlint = path.join(root, 'oxlint');
  const noOp = path.join(root, 'no-op');
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(file, 'export const value = 1;\n');
  fs.writeFileSync(oxlint, '#!/bin/sh\necho "index.ts:1:1 actionable oxlint feedback"\nexit 1\n', {
    mode: 0o755,
  });
  fs.writeFileSync(noOp, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  assert.throws(
    () =>
      postEdit(
        {
          cwd: root,
          tool_name: 'Write',
          tool_input: { file_path: file },
        },
        { oxlint, oxfmt: noOp, textlint: noOp },
      ),
    /actionable oxlint feedback/u,
  );
});

test('registers one post-edit hook for all supported edits', () => {
  for (const file of HOOKS_CONFIGS) {
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    const commands: string[] = config.hooks.PostToolUse.flatMap(
      (entry: { hooks: Array<{ command?: string }> }) => entry.hooks,
    )
      .map((hook: { command?: string }) => hook.command || '')
      .filter((command: string) => /post-edit|textlint-fix/u.test(command));
    assert.deepEqual(commands, ['codex-post-edit'], file);
  }
});

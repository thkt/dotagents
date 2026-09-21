import assert from 'node:assert/strict';
import { afterEach, expect, test } from 'bun:test';
import {
  mkdtemp,
  realpath,
  readFile,
  writeFile,
  rm,
  mkdir,
  symlink,
  readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateReviewReport } from '../review-report.ts';
import { reportFixture } from './support/review-report.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(mode: 'normal' | 'pending' | 'empty' | 'stopped' = 'normal') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'report-test-')));
  roots.push(root);
  return {
    root,
    output: join(root, 'report.html'),
    ...(await reportFixture(join(root, 'records'), mode)),
  };
}
async function contents(root: string): Promise<Record<string, string>> {
  const paths = await readdir(root, { recursive: true, withFileTypes: true });
  const pairs = await Promise.all(
    paths
      .filter((entry) => entry.isFile())
      .map(async (entry): Promise<[string, string]> => {
        const path = join(entry.parentPath, entry.name);
        return [path, await readFile(path, 'utf8')];
      }),
  );
  return Object.fromEntries(pairs);
}
async function select(html: string, selector: string) {
  const result: { count: number; text: string; attributes: Record<string, string>[] } = {
    count: 0,
    text: '',
    attributes: [],
  };
  await new HTMLRewriter()
    .on(selector, {
      element(element) {
        result.count++;
        result.attributes.push(Object.fromEntries(element.attributes));
      },
      text(text) {
        result.text += text.text;
      },
    })
    .transform(new Response(html))
    .text();
  return result;
}

test('CLI renders recorded requirements, observations and independent verdicts without touching inputs', async () => {
  const f = await fixture();
  const before = await contents(join(f.root, 'records'));
  const execution = spawnSync(
    process.execPath,
    [resolve('scripts/review-report.ts'), f.input, f.output],
    { encoding: 'utf8', timeout: 5000 },
  );
  expect(execution.status, execution.stderr).toBe(0);
  expect(await contents(join(f.root, 'records'))).toEqual(before);
  const html = await readFile(f.output, 'utf8');
  expect(html).not.toContain('CURRENT CHECKOUT IS NOT HISTORICAL EVIDENCE');
  const additions = (await select(html, '#targets')).text;
  expect(additions).toContain('保存時点の追加テスト');
  expect(additions).toContain('expect(page([10,20,30,40], 2, 2)).toEqual([30,40]);');
  expect(additions).toContain('symlinkの保存参照先');
  expect(additions).toContain('../checkout/page.ts');
  expect(additions).toContain('UTF-8テキストとして本文を表示できません');
  expect(additions).toContain(
    Bun.escapeHTML(await readFile(join(f.verification, 'review-1.additions.json'), 'utf8')),
  );
  expect((await select(html, '#requirements .markdown')).text).toContain(
    'offset から最大 limit 件',
  );
  expect((await select(html, '#reproduction')).text).toMatch(
    /期待値[\s\S]*30[\s\S]*40[\s\S]*実結果\[\]/,
  );
  expect((await select(html, '#finding-0')).text).toContain('open真偽の裁定demonstrated');
  expect((await select(html, '#finding-1')).text).toContain('fixed真偽の裁定false_positive');
  expect((await select(html, '#usage')).text).toContain('1234.5');
  expect((await select(html, '#usage')).text).toContain('入力トークン120');
  expect((await select(html, '#usage')).text).toContain('キャッシュ入力トークン20');
  expect((await select(html, '#usage')).text).toContain('出力トークン35');
  expect((await select(html, '#usage')).text).toContain(
    'delegated model totals remain unconfirmed',
  );
  const logs = (await select(html, '#logs')).text;
  expect(logs.indexOf('check —')).toBeLessThan(logs.indexOf('review —'));
  expect(logs.indexOf('item.started')).toBeLessThan(logs.indexOf('item.completed'));
  expect((await select(html, '.attention')).text).toContain('失敗の記録');
  expect((await select(html, '#finding-1')).text).toContain(
    '長い日本語の要求を確認するとき、境界条件と未計測の事項を省略すると誤解が起こり得る。'.repeat(
      12,
    ),
  );
  const ids = (await select(html, '[id]')).attributes.map((entry) => entry.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const entry of (await select(html, 'a[href^="#"]')).attributes) {
    expect(ids).toContain(entry.href?.slice(1));
  }
  expect((await select(html, 'details > summary')).count).toBeGreaterThan(0);
});

test('pending, no-findings and stopped records expose uncertainty before any details are opened', async () => {
  for (const mode of ['pending', 'empty', 'stopped'] as const) {
    const f = await fixture(mode);
    await generateReviewReport(f.input, f.output);
    const html = await readFile(f.output, 'utf8');
    const top = (await select(html, 'header, .attention')).text;
    if (mode === 'empty') {
      expect(top).toContain('accepted');
      expect(top).toContain('裁定待ち・未判定');
      expect((await select(html, '#review')).text).toContain('記録された指摘: 0件');
    } else {
      expect(top).toContain('使用量が未計測・欠落');
      expect(top).toContain('events.jsonl');
      expect((await select(html, '#usage')).text).toContain('入力トークン未記録・未確認');
    }
    if (mode === 'pending') {
      expect(top).toContain('fixed / 真偽の裁定: unconfirmed');
    }
    if (mode === 'stopped') {
      expect(top).toContain('review_failed');
      expect(top).toContain('レビュー未記録');
      expect(top).toContain('再現記録がありません');
    }
    expect(top).not.toContain('合格');
  }
});

test('unsafe Markdown and raw logs cannot create executable elements, URLs or remote images', async () => {
  const f = await fixture();
  f.issue.body +=
    '\n\n<a href="javascript:alert(2)">HTML</a><svg onload=alert(3)></svg>\n\n[entity](jav&#x61;script:alert(4))\n\n[control](java&#10;script:alert(5))\n\n[data](data:text/html,test)\n\n[local](file:///etc/passwd)\n\n![image](data:image/svg+xml,test)\n\n```html\n</pre><script>alert(6)</script>\n```';
  await writeFile(join(f.dir, 'issue.json'), JSON.stringify(f.issue));
  await generateReviewReport(f.input, f.output);
  const html = await readFile(f.output, 'utf8');
  expect(
    (await select(html, 'script, svg, iframe, object, embed, img, [onerror], [onload]')).count,
  ).toBe(0);
  expect((await select(html, '#targets')).text).toContain(
    '&lt;script&gt;globalThis.ADDITION_EXECUTED',
  );
  const hrefs = (await select(html, 'a[href]')).attributes.map((entry) => entry.href);
  expect(hrefs).toContain('https://example.com/reference');
  expect(hrefs.every((href) => href?.startsWith('#') || href?.startsWith('https://'))).toBe(true);
  expect((await select(html, '#requirements .markdown')).text).toContain(
    '&lt;script&gt;globalThis.REPORT_EXECUTED',
  );
  expect((await select(html, '.markdown table')).count).toBe(1);
  expect((await select(html, '.markdown pre code')).count).toBeGreaterThan(0);
  expect(
    (await select(html, 'meta[http-equiv="Content-Security-Policy"]')).attributes[0]?.content,
  ).toContain("default-src 'none'");
});

test('invalid JSON and unsupported result fields reject with input and reason before writing output', async () => {
  const f = await fixture();
  for (const [content, reason] of [
    ['{broken', 'JSON'],
    [JSON.stringify({ status: 'accepted' }), 'case id'],
    [
      JSON.stringify({
        ...f.result,
        usage: {
          totals: { input_tokens: -1, cached_input_tokens: 0, output_tokens: 0 },
          completedTurns: 1,
          scope: 'test',
        },
      }),
      'usage.totals',
    ],
    [
      JSON.stringify({
        ...f.result,
        usage: { totals: { input_tokens: 1 }, completedTurns: 1, scope: 'test' },
      }),
      'usage.totals',
    ],
    [JSON.stringify({ ...f.result, review: { status: 'accepted' } }), 'review format'],
    [JSON.stringify({ ...f.result, id: 'case-other' }), 'directory'],
  ]) {
    assert(content && reason);
    await writeFile(f.input, content);
    try {
      await generateReviewReport(f.input, f.output);
      throw Error('Unexpected generation');
    } catch (error) {
      expect(String(error)).toContain(f.input);
      expect(String(error)).toContain(reason);
    }
    expect(await Bun.file(f.output).exists()).toBe(false);
    expect(await readFile(f.input, 'utf8')).toBe(content);
  }
});

test('output boundaries preserve existing files and refuse checkout, source and symlink destinations', async () => {
  const f = await fixture();
  await writeFile(f.output, 'keep existing');
  await assert.rejects(generateReviewReport(f.input, f.output), /EEXIST/);
  expect(await readFile(f.output, 'utf8')).toBe('keep existing');
  const checkout = join(f.root, 'other-checkout');
  await mkdir(checkout);
  await writeFile(join(checkout, '.git'), 'gitdir: /unused-worktree');
  const alias = join(f.root, 'alias');
  await symlink(checkout, alias);
  for (const path of [
    join(checkout, 'report.html'),
    join(alias, 'report.html'),
    resolve('report.html'),
  ]) {
    await assert.rejects(generateReviewReport(f.input, path), /checkout外/);
    expect(await Bun.file(path).exists()).toBe(false);
  }
  await assert.rejects(
    generateReviewReport(f.input, join(f.dir, 'report.html')),
    /入力記録の保存先外/,
  );
  const symlinkOutput = join(f.root, 'symlink.html');
  await symlink(f.input, symlinkOutput);
  const before = await readFile(f.input, 'utf8');
  await assert.rejects(generateReviewReport(f.input, symlinkOutput), /EEXIST/);
  expect(await readFile(f.input, 'utf8')).toBe(before);
});

test('missing targets, malformed related records and escaped symlinks remain visible without borrowing other evidence', async () => {
  const f = await fixture();
  const finalPath = join(f.actor, 'final.json');
  const savedFinal = await readFile(finalPath, 'utf8');
  await writeFile(finalPath, '{truncated');
  const malformed = await generateReviewReport(f.input, join(f.root, 'malformed-final.html'));
  const malformedHtml = await readFile(malformed.output, 'utf8');
  expect(malformed.warnings.filter((warning) => warning.includes('final.json'))).toHaveLength(1);
  expect((await select(malformedHtml, '.attention')).text).toMatch(/final\.json.*SyntaxError/);
  expect((await select(malformedHtml, '#logs')).text).toMatch(
    /final\.json[\s\S]*記録欠落・読取不能/,
  );
  expect((await select(malformedHtml, '#finding-0')).text).toContain('open真偽の裁定demonstrated');
  expect((await select(malformedHtml, '#logs')).text).toContain('item.completed');
  await writeFile(finalPath, savedFinal);
  await writeFile(
    join(f.dir, 'issue.json'),
    JSON.stringify({ ...f.issue, body: 'Changed after the recorded review' }),
  );
  const changed = await generateReviewReport(f.input, join(f.root, 'changed.html'));
  expect(changed.warnings.join('\n')).toContain('issue.jsonとレビュー時点の要求が不一致');
  await rm(join(f.verification, 'review-1.target.json'));
  await writeFile(join(f.actor, 'events.jsonl'), '{truncated\n');
  await writeFile(
    join(f.root, 'secret.json'),
    JSON.stringify({ body: 'EXTERNAL_SECRET_MUST_NOT_APPEAR' }),
  );
  await rm(join(f.dir, 'issue.json'));
  await symlink(join(f.root, 'secret.json'), join(f.dir, 'issue.json'));
  const result = await generateReviewReport(f.input, f.output);
  const html = await readFile(f.output, 'utf8');
  expect(result.warnings.join('\n')).toContain('レビュー対象IDに一致する保存対象記録がありません');
  expect((await select(html, '.attention')).text).toContain('JSONL不正・未完');
  expect((await select(html, '.attention')).text).toContain('symlink');
  expect(html).not.toContain('EXTERNAL_SECRET_MUST_NOT_APPEAR');
  expect(html).not.toContain('CURRENT CHECKOUT IS NOT HISTORICAL EVIDENCE');
});

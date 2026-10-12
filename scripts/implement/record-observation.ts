import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';

export const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');

// 一回の照合境界だけで共有する。各期待値との比較は呼出側で必ず行う。
export class RecordObservation {
  private readonly contents = new Map<string, { content: Buffer; sha256: string }>();
  private readonly regular = new Set<string>();

  async read(path: string, requireRegular = false) {
    // runtime原記録と保存済み評価対象に限定し、大きな生ログは保持しない。
    const reusable = path.endsWith('/actor.json') || path.endsWith('.target.json');
    if (requireRegular && !this.regular.has(path)) {
      assert((await lstat(path)).isFile(), '通常ファイルではありません');
      if (reusable) {
        this.regular.add(path);
      }
    }
    let observed = this.contents.get(path);
    if (!observed) {
      const content = await readFile(path);
      observed = { content, sha256: hash(content) };
      if (reusable) {
        this.contents.set(path, observed);
      }
    }
    return observed;
  }
}

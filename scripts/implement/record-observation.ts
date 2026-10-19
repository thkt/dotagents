import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';

export const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');

// 一回の照合境界だけで共有する。各期待値との比較は呼出側で必ず行う。
export class RecordObservation {
  private readonly contents = new Map<string, Promise<{ content: Buffer; sha256: string }>>();
  private readonly regular = new Map<string, Promise<void>>();
  private readonly retained = new Set<string>();

  retain(paths: readonly string[]) {
    for (const path of paths) {
      this.retained.add(path);
    }
  }

  async read(path: string, requireRegular = false) {
    // 明示した検証原記録・runtime・評価対象だけを保持し、大きなcheckログは保持しない。
    const reusable =
      this.retained.has(path) || path.endsWith('/actor.json') || path.endsWith('.target.json');
    if (requireRegular) {
      let regular = this.regular.get(path);
      if (!regular) {
        regular = lstat(path).then((info) => {
          assert(info.isFile(), '通常ファイルではありません');
        });
        if (reusable) {
          this.regular.set(path, regular);
        }
      }
      await regular;
    }
    let observed = this.contents.get(path);
    if (!observed) {
      observed = readFile(path).then((content) => ({ content, sha256: hash(content) }));
      if (reusable) {
        this.contents.set(path, observed);
      }
    }
    return observed;
  }
}

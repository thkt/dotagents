import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { generate, type Variant } from '../../feedback-loop/build.ts';

const built = new Map<Variant, Promise<string>>();
const roots: string[] = [];
process.on('exit', () => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * 正本から生成したスキルを、dotagentsのcheckout外の一時ディレクトリへ置く。
 * 返すのはそのスキルディレクトリの絶対パスで、CLIは`scripts/setup.mjs`にある。
 */
export function skillDir(variant: Variant) {
  let dir = built.get(variant);
  if (!dir) {
    dir = (async () => {
      const root = mkdtempSync(join(tmpdir(), `feedback-loop-skill-${variant}-`));
      roots.push(root);
      for (const [path, body] of await generate(variant)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), body);
      }
      return root;
    })();
    built.set(variant, dir);
  }
  return dir;
}

export async function skillSetup(variant: Variant = 'private') {
  return join(await skillDir(variant), 'scripts/setup.mjs');
}

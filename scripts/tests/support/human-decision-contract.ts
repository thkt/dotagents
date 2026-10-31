import publicContract from '../fixtures/human-decision-recovery/public-contract.json';

// 公開手順のargvから実行ファイルとスクリプトのパスを除き、プレースホルダーを値へ置き換える。
export function contractArgs(values: Record<string, string>) {
  return publicContract.argvShape.slice(2).map((value) => values[value] ?? value);
}

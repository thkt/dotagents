import publicContract from '../fixtures/human-decision-recovery/public-contract.json';

// argvShapeの先頭2要素は実行ファイルとスクリプトのパス。
export function contractArgs(values: Record<string, string>) {
  return publicContract.argvShape.slice(2).map((value) => values[value] ?? value);
}

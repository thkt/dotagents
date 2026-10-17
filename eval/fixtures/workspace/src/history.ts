import { checkHistory } from './check-history.ts';
type History = { id: string; status: 'success' | 'failure'; artifact?: string; reason?: string };
// 保存前に、成功の成果物参照と失敗の理由を人が確認する。
export function appendHistory(value: History, write: (value: History) => void) {
  checkHistory(value);
  write(value);
}
export function importHistory(text: string, write: (value: History) => void) {
  appendHistory(JSON.parse(text), write);
}

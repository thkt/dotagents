export type State = 'queued' | 'running' | 'completed' | 'failed';
export function advance(state: State, event: string, notify: (message: string) => void): State {
  if (state === 'queued' && event === 'start') return 'running';
  if (state === 'running' && event === 'complete') {
    notify('処理が完了しました。');
    return 'completed';
  }
  if (state === 'running' && event === 'fail') return 'failed';
  return state;
}

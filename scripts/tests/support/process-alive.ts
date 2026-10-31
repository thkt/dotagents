import { isRecord } from '../../shared/values.ts';

// 存在しないPIDだけをfalseにし、権限不足など別のエラーは隠さず投げる。
export function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isRecord(error) && error.code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}

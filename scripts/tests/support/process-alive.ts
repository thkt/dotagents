import { isRecord } from '../../shared/values.ts';

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

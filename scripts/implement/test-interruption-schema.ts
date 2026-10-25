import { z } from 'zod';

export const testInterruptionShape = z.strictObject({
  previousRun: z.string().min(1),
  branch: z.string().min(1),
  head: z.string().regex(/^[a-f0-9]{40}$/),
  baseline: z.string().min(1),
  host: z.strictObject({ cwd: z.string().min(1), issue: z.string().regex(/^[1-9]\d*$/) }),
  remoteUrl: z.string().min(1),
  retained: z.string().regex(/^[a-f0-9]{64}$/),
  config: z.object({ cwd: z.string(), targetText: z.string(), review: z.array(z.string()) }),
  // ホストが保存していない終了code・時間をactor応答から補完しない。
  observations: z.string().min(1),
  execution: z.strictObject({ code: z.null(), ms: z.null(), usage: z.literal('unknown') }),
});
export type TestInterruption = z.infer<typeof testInterruptionShape>;

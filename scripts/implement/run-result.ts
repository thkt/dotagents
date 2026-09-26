import assert from 'node:assert/strict';
import { z } from 'zod';

const resultShape = z.object({
  status: z.enum(['stopped', 'verified_local', 'published_draft']),
  phase: z.string(),
  operation: z.string(),
  reason: z.string(),
  nextAction: z.string(),
  repository: z.string(),
  issue: z.string(),
  startCommit: z.string(),
  details: z.string().optional(),
  remaining: z.array(z.string()),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  terminal: z.literal(true),
  publication: z.string().optional(),
  commit: z.string().optional(),
  url: z.string().optional(),
  ci: z.string().optional(),
  ciDetails: z.unknown().optional(),
});
export type RunResult = z.infer<typeof resultShape>;

export function parseRunResult(value: unknown) {
  const parsed = resultShape.safeParse(value);
  assert(parsed.success, 'Invalid result.json');
  assert(
    Date.parse(parsed.data.finishedAt) >= Date.parse(parsed.data.startedAt),
    'Invalid run interval',
  );
  if (parsed.data.status === 'published_draft') {
    assert(
      parsed.data.publication === 'published' &&
        parsed.data.commit &&
        parsed.data.url &&
        parsed.data.ci === 'passed',
      'Incomplete published draft record',
    );
  }
  return parsed.data;
}

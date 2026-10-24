import { z } from 'zod';
import { isAbsolute } from 'node:path';

const text = z.string().regex(/\S/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const path = text.refine(isAbsolute);
export const supplementShape = z.strictObject({
  format: z.literal(1),
  issue: text,
  issueUpdatedAt: text,
  issueSha256: sha256,
  source: text,
  content: text,
  decision: text,
});
export const fixedSupplementShape = z.strictObject({
  path,
  sha256,
  agreement: supplementShape,
});
export type FixedSupplement = z.infer<typeof fixedSupplementShape>;
export const preservedShape = z
  .array(
    z.strictObject({
      path,
      mode: z.number().int(),
      kind: z.enum(['file', 'directory', 'symlink']),
      value: z.string(),
    }),
  )
  .min(1);
export const humanDecisionShape = z.strictObject({
  previousRun: path,
  roots: z.array(path).min(1),
  source: sha256,
  head: text,
  branch: text,
  records: preservedShape,
  supplement: fixedSupplementShape,
});
export type HumanDecision = z.infer<typeof humanDecisionShape>;

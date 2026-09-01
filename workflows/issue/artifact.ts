/** @file Outcome: Every issue preview is an immutable JSON contract paired with its exact Markdown body. */

import { atomicWrite, atomicWriteText, issueArtifactDirectory } from '../shared/storage.ts';
import { artifactPaths } from '../shared/artifacts.ts';
import type { IssueDraft } from './contracts.ts';

/** Writes the exact body first, then seals its path and digest in the draft JSON. */
export function persistIssueDraft(
  draft: Omit<IssueDraft, 'body_file'>,
  body: string,
): { draft: IssueDraft; draft_json: string; body_markdown: string } {
  const paths = artifactPaths(
    issueArtifactDirectory(draft.repo),
    draft.title,
    new Date(draft.generated_at),
    'issue',
  );
  const value: IssueDraft = { ...draft, body_file: paths.markdown };
  atomicWriteText(paths.markdown, body);
  atomicWrite(paths.json, value);
  return { draft: value, draft_json: paths.json, body_markdown: paths.markdown };
}

export function receiptPath(draftFile: string): string {
  return `${draftFile}.published.json`;
}

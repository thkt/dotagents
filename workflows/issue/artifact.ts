/** @file Outcome: Every Issue write uses an inspectable Markdown preview. */

import { atomicWriteText, issueArtifactDirectory } from '../shared/storage.ts';
import { artifactPaths } from '../shared/artifacts.ts';

export function persistIssuePreview(
  repo: string,
  title: string,
  generatedAt: Date,
  body: string,
): string {
  const paths = artifactPaths(issueArtifactDirectory(repo), title, generatedAt, 'issue');
  atomicWriteText(paths.markdown, body);
  return paths.markdown;
}

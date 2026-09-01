/** @file Outcome: Research, think, and issue artifacts use one collision-safe naming contract. */

import crypto from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';

export function artifactPaths(
  directory: string,
  seed: string,
  generatedAt: Date,
  fallback: string,
): { json: string; markdown: string } {
  const timestamp = generatedAt
    .toISOString()
    .replace(/[-:]/gu, '')
    .replace(/\.\d{3}Z$/u, 'Z');
  const slug =
    seed
      .toLowerCase()
      .match(/[a-z0-9]+/gu)
      ?.slice(0, 6)
      .join('-') || fallback;
  const digest = crypto.createHash('sha256').update(seed).digest('hex').slice(0, 8);
  const base = `${timestamp}-${slug}-${digest}`;
  for (let suffix = 1; ; suffix += 1) {
    const name = suffix === 1 ? base : `${base}-${suffix}`;
    const json = path.join(directory, `${name}.json`);
    const markdown = path.join(directory, `${name}.md`);
    if (!fs.existsSync(json) && !fs.existsSync(markdown)) return { json, markdown };
  }
}

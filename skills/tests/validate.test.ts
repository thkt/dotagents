/** @file Outcome: Skill validation accepts complete skills and rejects malformed or unfinished ones. */

import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, onTestFinished, test } from 'bun:test';

import { validateSkill } from '../validate.ts';

function fixture(content?: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-validation-'));
  onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  if (content !== undefined) fs.writeFileSync(path.join(directory, 'SKILL.md'), content);
  return directory;
}

test('accepts valid skill frontmatter and ignores TODO examples inside fences', () => {
  const directory = fixture(
    `---
name: valid-skill
description: A valid skill.
metadata:
  owner: test
---

# Valid

\`\`\`text
[TODO: example]
\`\`\`
`,
  );
  expect(validateSkill(directory)).toEqual({ valid: true, message: 'Skill is valid!' });
});

test.each([
  ['missing SKILL.md', undefined, /^SKILL\.md not found$/u],
  ['missing frontmatter', '# Missing', /^No YAML frontmatter found$/u],
  ['list frontmatter', '---\n- list\n---\n', /^Frontmatter must be a YAML dictionary$/u],
  ['invalid YAML', '---\nname: [\n---\n', /^Invalid YAML in frontmatter:/u],
  ['unknown keys', '---\nname: test\ndescription: ok\nextra: true\n---\n', /^Unexpected key\(s\)/u],
  ['missing name', '---\ndescription: ok\n---\n', /^Missing 'name' in frontmatter$/u],
  ['missing description', '---\nname: test\n---\n', /^Missing 'description' in frontmatter$/u],
  ['empty name', '---\nname: ""\ndescription: ok\n---\n', /must not be empty/u],
  ['empty description', '---\nname: test\ndescription: ""\n---\n', /must not be empty/u],
  ['non-hyphen name', '---\nname: Bad_Name\ndescription: ok\n---\n', /hyphen-case/u],
  ['invalid hyphen placement', '---\nname: -bad\ndescription: ok\n---\n', /hyphen placement/u],
  ['long name', `---\nname: ${'a'.repeat(65)}\ndescription: ok\n---\n`, /too long/u],
  ['angle brackets', '---\nname: test\ndescription: "<value>"\n---\n', /angle brackets/u],
  [
    'unfinished TODO',
    '---\nname: test\ndescription: ok\n---\n\n[TODO: finish this]\n',
    /^Skill instructions contain an unfinished TODO placeholder$/u,
  ],
] as const)('rejects %s', (_name, content, message) => {
  expect(validateSkill(fixture(content)).message).toMatch(message);
});

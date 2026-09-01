/** @file Outcome: Skill validation accepts complete skills and rejects malformed or unfinished ones. */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { validateSkill } from '../validate.ts';

function fixture(t: test.TestContext, content?: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-validation-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  if (content !== undefined) fs.writeFileSync(path.join(directory, 'SKILL.md'), content);
  return directory;
}

test('accepts valid skill frontmatter and ignores TODO examples inside fences', (t) => {
  const directory = fixture(
    t,
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
  assert.deepEqual(validateSkill(directory), { valid: true, message: 'Skill is valid!' });
});

test('requires a SKILL.md with closed mapping frontmatter', (t) => {
  assert.equal(validateSkill(fixture(t)).message, 'SKILL.md not found');
  assert.equal(validateSkill(fixture(t, '# Missing')).message, 'No YAML frontmatter found');
  assert.equal(
    validateSkill(fixture(t, '---\n- list\n---\n')).message,
    'Frontmatter must be a YAML dictionary',
  );
  assert.match(
    validateSkill(fixture(t, '---\nname: [\n---\n')).message,
    /^Invalid YAML in frontmatter:/u,
  );
});

test('rejects unknown keys and missing required fields', (t) => {
  assert.match(
    validateSkill(fixture(t, '---\nname: test\ndescription: ok\nextra: true\n---\n')).message,
    /^Unexpected key\(s\)/u,
  );
  assert.equal(
    validateSkill(fixture(t, '---\ndescription: ok\n---\n')).message,
    "Missing 'name' in frontmatter",
  );
  assert.equal(
    validateSkill(fixture(t, '---\nname: test\n---\n')).message,
    "Missing 'description' in frontmatter",
  );
});

test('validates names and descriptions', (t) => {
  assert.match(
    validateSkill(fixture(t, '---\nname: ""\ndescription: ok\n---\n')).message,
    /must not be empty/u,
  );
  assert.match(
    validateSkill(fixture(t, '---\nname: test\ndescription: ""\n---\n')).message,
    /must not be empty/u,
  );
  assert.match(
    validateSkill(fixture(t, '---\nname: Bad_Name\ndescription: ok\n---\n')).message,
    /hyphen-case/u,
  );
  assert.match(
    validateSkill(fixture(t, '---\nname: -bad\ndescription: ok\n---\n')).message,
    /hyphen placement/u,
  );
  assert.match(
    validateSkill(fixture(t, `---\nname: ${'a'.repeat(65)}\ndescription: ok\n---\n`)).message,
    /too long/u,
  );
  assert.match(
    validateSkill(fixture(t, '---\nname: test\ndescription: "<value>"\n---\n')).message,
    /angle brackets/u,
  );
});

test('rejects unfinished TODO placeholders outside code fences', (t) => {
  const directory = fixture(t, '---\nname: test\ndescription: ok\n---\n\n[TODO: finish this]\n');
  assert.equal(
    validateSkill(directory).message,
    'Skill instructions contain an unfinished TODO placeholder',
  );
});

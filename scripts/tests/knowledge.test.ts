import assert from 'node:assert/strict';
import { test, expect, spyOn } from 'bun:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  knowledgeReferences,
  selectKnowledge,
  renderKnowledge,
  generateKnowledge,
  parseKnowledge,
} from '../knowledge.ts';
import * as knowledge from '../knowledge.ts';
import { develop } from '../development.ts';
import { run } from '../correction.ts';
import { command } from '../process.ts';
import { isRecord, isArray } from '../values.ts';
import type { Config } from '../input.ts';
import { initializeTarget, githubTarget, git, targetConfig } from './support/target.ts';
import { reviewReplySource } from './support/correction.ts';

// Handwritten inputs keep format/selection behavior independent of repository prose.
const model = () => ({
  schemaVersion: 1,
  title: 'Example knowledge',
  scope: 'Synthetic test only',
  sources: [
    {
      id: 'agreement',
      url: 'https://example.com/agreement',
      version: 'revision-1',
      scope: 'Example rule and hypothesis',
      status: 'agreed',
    },
    {
      id: 'draft',
      url: 'https://example.com/draft',
      version: 'draft-2',
      scope: 'Example proposal only',
      status: 'proposed',
    },
  ],
  nodes: [
    {
      id: 'rule',
      facet: 'nomology',
      kind: 'rule',
      status: 'agreed',
      statement: 'Keep the reviewed input.',
      question: 'Which input was reviewed?',
      scope: 'Before starting',
      sources: ['agreement'],
      relations: [{ to: 'proposal', meaning: 'Possible revision' }],
    },
    {
      id: 'hypothesis',
      facet: 'teleology',
      kind: 'hypothesis',
      status: 'unverified',
      statement: 'Review may reduce rework.',
      question: 'Has rework been measured?',
      scope: 'No measured effect',
      sources: ['agreement'],
      relations: [{ to: 'rule', meaning: 'Expected benefit' }],
    },
    {
      id: 'proposal',
      facet: 'nomology',
      kind: 'proposal',
      status: 'proposed',
      statement: 'Consider another review.',
      question: 'Is another review needed?',
      scope: 'Requires agreement',
      sources: ['draft'],
      relations: [],
    },
  ],
});
const reference = {
  path: 'docs/example.json',
  blob: 'a'.repeat(40),
  ids: ['hypothesis', 'rule'], // Deliberately differs from model order.
};
const issueBody = (references: unknown) =>
  `Required behavior: preserve work.\n\n\`\`\`dotagents-knowledge\n${JSON.stringify(references)}\n\`\`\``;

test('one model produces human and AI definitions while preserving selection and unverified status', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-render-'));
  try {
    const path = join(root, 'model.json');
    const input = model();
    expect(parseKnowledge(input)).toEqual(input);
    await writeFile(path, JSON.stringify(input));
    await generateKnowledge(path, false);
    const original = await readFile(join(root, 'model.md'), 'utf8');
    const changed = model();
    const rule = changed.nodes[0];
    assert(rule);
    rule.statement = 'Keep the reviewed input and its version.';
    await writeFile(path, JSON.stringify(changed));
    await assert.rejects(() => generateKnowledge(path, true), /Knowledge Markdown is stale/);
    await generateKnowledge(path, false);
    await generateKnowledge(path, true);
    const explanation = await readFile(join(root, 'model.md'), 'utf8');
    const selected = selectKnowledge(changed, reference);
    const ai = renderKnowledge(selected);
    expect(original).not.toContain(rule.statement);
    expect(explanation).toContain(rule.statement);
    expect(ai).toContain(rule.statement);
    expect(ai).toContain('teleology / hypothesis / unverified');
    expect(ai).toContain('問い直す前提: Which input was reviewed?');
    expect(ai).toContain('適用条件: Before starting');
    expect(ai).toContain('根拠: agreement');
    expect(ai).toContain(
      '[出典](https://example.com/agreement) / 版: revision-1 / agreed / 適用: Example rule and hypothesis',
    );
    expect(selected.nodes.map(({ id }) => id)).toEqual(['hypothesis', 'rule']);
    expect(selected.sources.map(({ id }) => id)).toEqual(['agreement']);
    expect(ai.indexOf('## hypothesis')).toBeLessThan(ai.indexOf('## rule'));
    expect(ai).not.toContain('## proposal');
    expect(ai).not.toContain('Consider another review.');
    expect(ai).not.toContain('https://example.com/draft');
    expect(ai).toContain('関係: rule → proposal: Possible revision');
    const proposed = renderKnowledge(selectKnowledge(changed, { ...reference, ids: ['proposal'] }));
    expect(proposed).toContain('nomology / proposal / proposed');
    expect(proposed).toContain('Consider another review.');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Issue selection is optional but malformed, duplicate and unsafe selections are rejected', () => {
  const table = '| Rule | Scope |\n| --- | --- |\n| preserve | work |';
  expect(knowledgeReferences(`Existing Issue without a model\n\n${table}`)).toEqual([]);
  expect(
    knowledgeReferences(
      JSON.stringify({ body: `${table}\n\n${issueBody([reference])}\n\n${table}` }),
    ),
  ).toEqual([reference]);
  for (const [selection, error] of [
    [[{ ...reference, ids: ['rule', 'rule'] }], 'Duplicate knowledge'],
    [[reference, reference], 'Duplicate knowledge'],
    [[{ ...reference, path: '../model.json' }], 'repo-relative'],
    [[{ ...reference, blob: 'latest' }], 'Git blob'],
    [[{ ...reference, ids: [] }], 'nonempty knowledge list'],
  ] as const) {
    expect(() => knowledgeReferences(issueBody(selection))).toThrow(error);
  }
  expect(() => knowledgeReferences('```dotagents-knowledge\n[]')).toThrow('complete');
  for (const fence of [
    ' ```dotagents-knowledge',
    '````dotagents-knowledge',
    '~~~dotagents-knowledge',
  ]) {
    expect(
      knowledgeReferences(
        `${fence}\n${JSON.stringify([reference])}\n${fence.split('dotagents')[0]}`,
      ),
    ).toEqual([reference]);
  }
  expect(() => knowledgeReferences(issueBody([reference]) + '\n' + issueBody([reference]))).toThrow(
    'one complete',
  );
});

test('only an active selection is used; examples, quotations and HTML are not selections', () => {
  const block = issueBody([reference]).split('\n\n')[1] ?? assert.fail();
  const examples = [
    `\`\`\`\`markdown\n${block}\n\`\`\`\``,
    `~~~markdown\n${block}\n~~~`,
    `<!--\n${block}\n-->`,
    `<!--\n${block}`, // An unfinished comment still hides its contents.
    `<pre>\n${block}\n</pre>`,
    block
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n'),
    block
      .split('\n')
      .map((line) => `    ${line}`)
      .join('\n'),
    block
      .split('\n')
      .map((line, index) => `${index === 0 ? '- ' : '  '}${line}`)
      .join('\n'),
  ];
  for (const example of examples) {
    expect(knowledgeReferences(example)).toEqual([]);
    expect(knowledgeReferences(`${block}\n\n${example}`)).toEqual([reference]);
  }
  expect(knowledgeReferences(`<!-- example -->\n\n${block}`)).toEqual([reference]);
  expect(() => knowledgeReferences(block.replace(/\n```$/, ''))).toThrow('complete');
  const literal = { ...reference, path: 'docs/<!--literal-->.json' };
  expect(() => knowledgeReferences(issueBody([literal]))).toThrow('repo-relative');
});

test('model structure rejects unresolved identities, references and promotion of unverified effects', () => {
  expect(() => selectKnowledge(model(), { ...reference, ids: ['missing'] })).toThrow(
    'Unknown selected',
  );
  expect(() => selectKnowledge(model(), { ...reference, ids: ['rule', 'rule'] })).toThrow(
    'Duplicate knowledge',
  );
  for (const [mutate, reason] of [
    [
      (value: ReturnType<typeof model>) => value.nodes.push(value.nodes[0] ?? assert.fail()),
      'Duplicate knowledge',
    ],
    [
      (value: ReturnType<typeof model>) => {
        value.sources = [];
      },
      'nonempty knowledge list',
    ],
    [
      (value: ReturnType<typeof model>) => {
        value.sources.pop();
      },
      'Missing knowledge source',
    ],
    [
      (value: ReturnType<typeof model>) => {
        value.nodes[0]?.relations.push({ to: 'missing', meaning: 'invalid reference' });
      },
      'Unknown knowledge relation',
    ],
    [
      (value: ReturnType<typeof model>) => {
        const node = value.nodes[0];
        assert(node);
        node.status = 'invalid';
      },
      'Invalid knowledge value',
    ],
    [
      (value: ReturnType<typeof model>) => {
        const node = value.nodes.find(({ kind }) => kind === 'proposal');
        assert(node);
        node.status = 'agreed';
      },
      'not an agreed requirement',
    ],
    [
      (value: ReturnType<typeof model>) => {
        const node = value.nodes.find(({ kind }) => kind === 'hypothesis');
        assert(node);
        node.status = 'observed';
      },
      'not a verified effect',
    ],
  ] as const) {
    const value = model();
    mutate(value);
    expect(() => selectKnowledge(value, reference)).toThrow(reason);
  }
});

test('Issue-selected #85 knowledge reaches implementation, correction and independent review at the same base version', async () => {
  const modelPath = 'docs/knowledge/implementation-start.json';
  const content = await readFile(resolve(import.meta.dir, '../..', modelPath), 'utf8');
  const ids = [
    'preserve-work',
    'start-objects',
    'start-identity',
    'index-counterexample',
    'less-rework',
  ];
  const reference = { path: modelPath, blob: 'a'.repeat(40), ids };
  // Transport expectations come from the real input, without select/render transformations.
  const original: unknown = JSON.parse(content);
  assert(isRecord(original) && isArray(original.nodes) && isArray(original.sources));
  const nodes = original.nodes;
  const expectedNodes = ids.map((id) => {
    const node = nodes.find((node) => isRecord(node) && node.id === id);
    assert(isRecord(node));
    return node;
  });
  const expectedSources = original.sources.filter((source) => {
    assert(isRecord(source));
    return expectedNodes.some((node) => isArray(node.sources) && node.sources.includes(source.id));
  });
  const root = await mkdtemp(join(tmpdir(), 'knowledge-flow-'));
  const repo = join(root, 'repo');
  const dir = join(root, 'run');
  const ok = (stdout = '') => ({ code: 0, timedOut: false, ms: 1, stdout, stderr: '' });
  try {
    await mkdir(repo);
    await initializeTarget(repo);
    await mkdir(join(repo, 'docs/knowledge'), { recursive: true });
    await writeFile(join(repo, modelPath), content);
    git(repo, 'add', modelPath);
    git(repo, 'commit', '-m', 'reviewed knowledge');
    const base = git(repo, 'rev-parse', 'HEAD');
    const blob = git(repo, 'rev-parse', `HEAD:${modelPath}`);
    const issue = JSON.stringify({
      title: 'Preserve work',
      body: issueBody([{ ...reference, blob }]),
      state: 'OPEN',
    });
    const issueFile = join(root, 'issue.json');
    await writeFile(issueFile, issue);
    await writeFile(join(repo, 'result.txt'), 'Unrelated work must survive');
    await writeFile(join(repo, 'untracked.txt'), 'Other developer’s notes');
    const helper = join(root, 'actor.js');
    await writeFile(
      helper,
      `
import {readFileSync, writeFileSync} from 'node:fs';
const role = process.argv[2];
${reviewReplySource}
if(role === 'repair') {
  writeFileSync('result.txt', 'implemented');
  const model = JSON.parse(readFileSync(${JSON.stringify(modelPath)}, 'utf8'));
  model.nodes[0].statement = 'Proposed revision during repair';
  writeFileSync(${JSON.stringify(modelPath)}, JSON.stringify(model));
  console.log(JSON.stringify({status:'repaired',findings:'Index observation affects start-identity; investigate before adopting changes.'}));
}
if(role === 'review') {
  const response = reviewReply('accepted', 'Simulated transport only; no semantic review claim.');
  response.documents = [{path:${JSON.stringify(modelPath)},role:'current',reason:'Compare base rule with current proposed revision'}];
  console.log(JSON.stringify(response));
}
`,
    );
    let verification: Config | undefined;
    const io: Parameters<typeof develop>[1] = {
      command: async (argv, cwd, input, timeout) => {
        const target = githubTarget(argv, targetConfig);
        if (target !== undefined) {
          return ok(target);
        }
        if (argv[0] === 'git') {
          return command(argv, cwd, input, timeout);
        }
        if (argv[0] === 'gh' && argv[1] === 'issue') {
          return ok(issue);
        }
        expect(input).toContain(`Git blob: ${blob}`);
        expect(input).toContain('## start-identity');
        expect(await readFile(join(cwd, 'result.txt'), 'utf8')).toBe('old');
        return ok(
          JSON.stringify({ status: 'repaired', findings: 'Prepared for host verification' }),
        );
      },
      verify: async (config: Config) => {
        verification = {
          ...config,
          issue: [
            process.execPath,
            '-e',
            `process.stdout.write(require('fs').readFileSync(${JSON.stringify(issueFile)}, 'utf8'))`,
          ],
          check: [
            process.execPath,
            '-e',
            "process.exit(require('fs').readFileSync('result.txt','utf8') === 'implemented' ? 0 : 1)",
          ],
          repair: [process.execPath, helper, 'repair'],
          review: [process.execPath, helper, 'review'],
        };
        return run(verification);
      },
      publish: async () => assert.fail('No publication authorized'),
    };
    await develop(['99', '--repo', repo, '--run-dir', dir, '--no-publish'], io);
    const initial = await readFile(join(dir, 'implementation.prompt'), 'utf8');
    const repaired = await readFile(join(dir, 'verification/repair-1.prompt'), 'utf8');
    const reviewed = await readFile(join(dir, 'verification/review-1.prompt'), 'utf8');
    for (const prompt of [initial, repaired, reviewed]) {
      expect(prompt).toContain(base);
      expect(prompt).toContain(`Git blob: ${blob}`);
      for (const node of expectedNodes) {
        assert(typeof node.id === 'string' && typeof node.facet === 'string');
        assert(typeof node.kind === 'string' && typeof node.status === 'string');
        expect(prompt).toContain(`## ${node.id} (${node.facet} / ${node.kind} / ${node.status})`);
        assert(typeof node.statement === 'string');
        assert(typeof node.question === 'string');
        assert(typeof node.scope === 'string');
        expect(prompt).toContain(node.statement);
        expect(prompt).toContain(node.question);
        expect(prompt).toContain(node.scope);
      }
      for (const source of expectedSources) {
        assert(isRecord(source));
        assert(typeof source.url === 'string' && typeof source.version === 'string');
        assert(typeof source.status === 'string' && typeof source.scope === 'string');
        expect(prompt).toContain(
          `[出典](${source.url}) / 版: ${source.version} / ${source.status} / 適用: ${source.scope}`,
        );
      }
      expect(prompt).toContain('teleology / hypothesis / unverified');
      expect(prompt).not.toContain('Proposed revision during repair');
      expect(prompt).not.toContain('## revisit-identity');
    }
    const target: unknown = JSON.parse(
      await readFile(join(dir, 'verification/review-1.target.json'), 'utf8'),
    );
    assert(isRecord(target));
    assert(isArray(target.knowledge) && target.knowledge.length === 1);
    const snapshot = target.knowledge[0];
    assert(isRecord(snapshot));
    expect({ path: snapshot.path, blob: snapshot.blob, ids: snapshot.ids }).toEqual({
      path: modelPath,
      blob,
      ids,
    });
    expect(snapshot.nodes).toEqual(expectedNodes);
    expect(snapshot.sources).toEqual(expectedSources);
    expect(await readFile(join(repo, 'result.txt'), 'utf8')).toBe('Unrelated work must survive');
    expect(await readFile(join(repo, 'untracked.txt'), 'utf8')).toBe('Other developer’s notes');
    assert(verification);
    const stateFile = join(verification.runDir, 'state.json');
    const saved = await readFile(stateFile, 'utf8');
    const extraction = spyOn(knowledge, 'readKnowledge');
    try {
      expect((await run(verification)).result).toBe('ready_for_human_review');
      expect(extraction).not.toHaveBeenCalled();
      expect(await readFile(stateFile, 'utf8')).toBe(saved);
    } finally {
      extraction.mockRestore();
    }

    // A tree entry can survive loss of its object. The checkout still has the model,
    // so source identity alone cannot protect the selected base-version reference.
    const blobPath = join(repo, '.git/objects', blob.slice(0, 2), blob.slice(2));
    const heldBlob = join(root, 'held-knowledge-blob');
    await rename(blobPath, heldBlob);
    try {
      expect(git(repo, 'ls-tree', base, '--', modelPath)).toContain(blob);
      await assert.rejects(run(verification), /Cannot verify report base/);
      expect(await readFile(stateFile, 'utf8')).toBe(saved);
    } finally {
      await rename(heldBlob, blobPath);
    }

    for (const [selection, reason] of [
      [{ ...reference, blob: 'invalid' }, 'Expected reviewed knowledge Git blob'],
      [{ ...reference, blob: 'a'.repeat(40) }, 'Required report differs from reviewed version'],
      [{ ...reference, blob, path: 'absent.json' }, 'Required report is missing from start commit'],
    ] as const) {
      await writeFile(issueFile, issueBody([selection]));
      await assert.rejects(run(verification), new RegExp(reason));
      expect(await readFile(stateFile, 'utf8')).toBe(saved);
    }
    // Unknown IDs are rejected initially by extraction. At a terminal run the
    // changed Issue is enough to refuse the old result without reconstructing it.
    await writeFile(issueFile, issueBody([{ ...reference, blob, ids: ['missing'] }]));
    expect((await run(verification)).result).toBe('target_changed_after_stop');
    expect(await readFile(stateFile, 'utf8')).toBe(saved);
    await writeFile(issueFile, issue);
    await writeFile(join(verification.cwd, modelPath), content + '\n');
    expect((await run(verification)).result).toBe('target_changed_after_stop');
    expect(await readFile(stateFile, 'utf8')).toBe(saved);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20000);

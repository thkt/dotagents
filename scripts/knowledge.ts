import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { isArray, isRecord, relativeDirectory } from './values.ts';
import type { ReportReference } from './input.ts';

type Git = (...args: string[]) => Promise<string>;
export interface KnowledgeReference extends ReportReference {
  ids: string[];
}

function record(value: unknown, keys: string[]) {
  assert(isRecord(value), 'Expected knowledge object');
  assert(
    Object.keys(value).length === keys.length && keys.every((key) => key in value),
    `Expected knowledge fields: ${keys.join(', ')}`,
  );
  return value;
}
function text(value: unknown): string {
  assert(typeof value === 'string' && value.trim(), 'Expected nonempty knowledge text');
  return value;
}
function list(value: unknown): unknown[] {
  assert(isArray(value) && value.length > 0, 'Expected nonempty knowledge list');
  return value;
}
function id(value: unknown) {
  const result = text(value);
  assert(/^[a-z][a-z0-9-]*$/.test(result), `Invalid knowledge ID: ${result}`);
  return result;
}
function unique(values: string[]) {
  assert(new Set(values).size === values.length, 'Duplicate knowledge ID or reference');
  return values;
}
function choice(value: unknown, choices: string[]) {
  const result = text(value);
  assert(choices.includes(result), `Invalid knowledge value: ${result}`);
  return result;
}
function source(value: unknown) {
  const entry = record(value, ['id', 'url', 'version', 'scope', 'status']);
  const url = text(entry.url);
  assert(new URL(url).protocol === 'https:', 'Knowledge source requires HTTPS');
  return {
    id: id(entry.id),
    url,
    version: text(entry.version),
    scope: text(entry.scope),
    status: choice(entry.status, ['agreed', 'observed', 'unverified', 'proposed']),
  };
}
function node(value: unknown) {
  const entry = record(value, [
    'id',
    'facet',
    'kind',
    'status',
    'statement',
    'question',
    'scope',
    'sources',
    'relations',
  ]);
  const kind = choice(entry.kind, [
    'purpose',
    'concept',
    'rule',
    'hypothesis',
    'observation',
    'proposal',
  ]);
  const status = choice(entry.status, ['agreed', 'observed', 'unverified', 'proposed']);
  assert(kind !== 'hypothesis' || status === 'unverified', 'Hypothesis is not a verified effect');
  assert(kind !== 'proposal' || status === 'proposed', 'Proposal is not an agreed requirement');
  assert(isArray(entry.relations), 'Expected knowledge relations');
  const relations = entry.relations.map((value) => {
    const relation = record(value, ['to', 'meaning']);
    return { to: id(relation.to), meaning: text(relation.meaning) };
  });
  unique(relations.map(({ to }) => to));
  return {
    id: id(entry.id),
    facet: choice(entry.facet, ['teleology', 'ontology', 'nomology']),
    kind,
    status,
    statement: text(entry.statement),
    question: text(entry.question),
    scope: text(entry.scope),
    sources: unique(list(entry.sources).map(id)),
    relations,
  };
}
export function parseKnowledge(value: unknown) {
  const model = record(value, ['schemaVersion', 'title', 'scope', 'sources', 'nodes']);
  assert(model.schemaVersion === 1, 'Unsupported knowledge schemaVersion');
  const sources = list(model.sources).map(source);
  const nodes = list(model.nodes).map(node);
  const ids = new Set(unique([...sources.map(({ id }) => id), ...nodes.map(({ id }) => id)]));
  for (const node of nodes) {
    assert(
      node.sources.every((id) => sources.some((source) => source.id === id)),
      `Missing knowledge source: ${node.id}`,
    );
    assert(
      node.relations.every(({ to }) => ids.has(to)),
      `Unknown knowledge relation: ${node.id}`,
    );
  }
  return { schemaVersion: 1, title: text(model.title), scope: text(model.scope), sources, nodes };
}

function selectionBlock(body: string) {
  // Bun owns Markdown boundaries. The suffix makes an unclosed fence fail JSON parsing.
  const blocks = Bun.markdown
    .render(`${body}\n\nDOTAGENTS_UNCLOSED_FENCE`, {
      paragraph: () => '',
      heading: () => '',
      html: () => '',
      blockquote: () => '',
      list: () => '',
      table: () => '',
      code: (content, meta) =>
        meta?.language === 'dotagents-knowledge' ? `${JSON.stringify(content)}\n` : '',
    })
    .trim();
  if (!blocks) {
    return undefined;
  }
  const selected = blocks.split('\n');
  assert(selected.length === 1, 'Expected one complete dotagents-knowledge block');
  const content: unknown = JSON.parse(selected[0] ?? '');
  assert(typeof content === 'string', 'Expected knowledge code block');
  assert(!content.endsWith('DOTAGENTS_UNCLOSED_FENCE\n'), 'Expected complete knowledge block');
  return content;
}

// Selection belongs to the Issue, not another CLI argument or workflow ledger.
export function knowledgeReferences(issue: string): KnowledgeReference[] {
  let body = issue;
  try {
    const value: unknown = JSON.parse(issue);
    if (isRecord(value) && typeof value.body === 'string') {
      body = value.body;
    }
  } catch {
    /* correction also accepts plain Issue text */
  }
  const block = selectionBlock(body);
  if (block === undefined) {
    return [];
  }
  const value: unknown = JSON.parse(block);
  const references = list(value).map((value) => {
    const entry = record(value, ['path', 'blob', 'ids']);
    assert(
      relativeDirectory(entry.path) && entry.path.endsWith('.json'),
      'Expected repo-relative knowledge JSON path',
    );
    const blob = text(entry.blob);
    assert(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(blob), 'Expected reviewed knowledge Git blob');
    return { path: entry.path, blob, ids: unique(list(entry.ids).map(id)) };
  });
  unique(references.map(({ path }) => path));
  return references;
}

function selectModel(model: ReturnType<typeof parseKnowledge>, reference: KnowledgeReference) {
  unique(reference.ids);
  const nodes = reference.ids.map((id) => {
    const node = model.nodes.find((node) => node.id === id);
    assert(node, `Unknown selected knowledge ID: ${id}`);
    return node;
  });
  return {
    ...reference,
    title: model.title,
    scope: model.scope,
    nodes,
    sources: model.sources.filter((source) =>
      nodes.some((node) => node.sources.includes(source.id)),
    ),
  };
}
export function selectKnowledge(value: unknown, reference: KnowledgeReference) {
  return selectModel(parseKnowledge(value), reference);
}
export type SelectedKnowledge = ReturnType<typeof selectKnowledge>;

// Callers reuse verifyReportBase / verifyStartInputs before reading immutable Git blobs.
export async function readKnowledge(references: KnowledgeReference[], git: Git) {
  const selected: SelectedKnowledge[] = [];
  for (const reference of references) {
    const value: unknown = JSON.parse(await git('cat-file', 'blob', reference.blob));
    selected.push(selectKnowledge(value, reference));
  }
  return selected;
}
function gitBlob(content: string) {
  const bytes = Buffer.from(content);
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}
const kindLabels: Record<ReturnType<typeof node>['kind'], string> = {
  purpose: '目的',
  concept: '概念',
  rule: '規則',
  hypothesis: '仮説',
  observation: '観測',
  proposal: '提案',
};
const statusLabels: Record<ReturnType<typeof node>['status'], string> = {
  agreed: '合意済み',
  observed: '確認済み',
  unverified: '未検証',
  proposed: '提案中',
};
function renderNode(entry: ReturnType<typeof node>, heading: '##' | '###') {
  return [
    `${heading} ${entry.id} — ${kindLabels[entry.kind]}（${statusLabels[entry.status]}）`,
    `分類: ${entry.facet} / ${entry.kind} / ${entry.status}`,
    entry.statement,
    `問い直す前提: ${entry.question}`,
    `適用条件: ${entry.scope}`,
    `根拠: ${entry.sources.join(', ')}`,
    ...entry.relations.map(({ to, meaning }) => `関係: ${entry.id} → ${to}: ${meaning}`),
  ].join('\n\n');
}
function renderSource(entry: ReturnType<typeof source>) {
  return `- ${entry.id}: [出典](${entry.url}) / 版: ${entry.version} / ${entry.status} / 適用: ${entry.scope}`;
}
const knowledgeBoundary =
  'これは対象repoの知識です。今回の要求・許可はIssueと合意記録、実行制御は信頼するホストが担当します。形式照合は意味・合意・効果を保証しません。関係先のIDは参照であり、未選択の定義を要求へ追加しません。';
export function renderKnowledge(
  selected: SelectedKnowledge,
  format: 'context' | 'wiki' = 'context',
) {
  const wiki = format === 'wiki';
  return (
    [
      `# ${selected.title}`,
      ...(wiki
        ? [
            'この文書はJSON正本から生成しています。直接手修正せず、正本を変更して`bun run knowledge:generate`で再生成し、`bun run knowledge:check`で照合してください。',
          ]
        : []),
      `正本: ${selected.path} / Git blob: ${selected.blob} / この表示に含むID: ${selected.ids.join(', ')}`,
      ...(wiki ? ['## 内容'] : []),
      `適用範囲: ${selected.scope}`,
      knowledgeBoundary,
      ...selected.nodes.map((entry) => renderNode(entry, wiki ? '###' : '##')),
      wiki ? '## 根拠' : '## 根拠の参照',
      ...selected.sources.map(renderSource),
    ].join('\n\n') + '\n'
  );
}
export function knowledgeContext(selected: SelectedKnowledge[]) {
  if (selected.length === 0) {
    return '';
  }
  return [
    'Selected repository knowledge at the reviewed base version. Compare current file changes with these definitions; relation targets are references, not implicitly selected definitions.',
    ...selected.map((entry) => renderKnowledge(entry)),
    'When observations conflict with a model premise, trace the affected node IDs and their sources to the Issue decision in existing findings/assessments. Propose a model diff with the observation and needed investigation or human agreement; do not auto-adopt it.',
  ].join('\n');
}
export async function generateKnowledge(
  path: string,
  check: boolean,
  destination = path.replace(/\.json$/, '.md'),
  selection: { globs: string[]; scenes: string[] } = { globs: [], scenes: [] },
) {
  assert(destination !== path && destination.endsWith('.md'), 'Expected knowledge Markdown path');
  const content = await readFile(path, 'utf8');
  const model = parseKnowledge(JSON.parse(content));
  const selected = selectModel(model, {
    path: relative(dirname(destination), path),
    blob: gitBlob(content),
    ids: model.nodes.map(({ id }) => id),
  });
  const body = renderKnowledge(selected, 'wiki');
  const markdown = `---\nglobs: ${JSON.stringify(selection.globs)}\nscenes: ${JSON.stringify(selection.scenes)}\n---\n\n${body}`;
  if (check) {
    assert(
      (await readFile(destination, 'utf8')) === markdown,
      'Knowledge Markdown is stale; run bun run knowledge:generate',
    );
  } else {
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, markdown);
  }
}
if (import.meta.main) {
  assert(
    process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === '--check'),
    'Usage: knowledge.ts [--check]',
  );
  await generateKnowledge(
    resolve(import.meta.dir, '../docs/knowledge/implementation-start.json'),
    process.argv[2] === '--check',
    resolve(import.meta.dir, '../docs/wiki/implementation-start.md'),
    {
      globs: ['scripts/development.ts', 'scripts/research-handoff.ts', 'scripts/knowledge.ts'],
      scenes: ['plan', 'implement'],
    },
  );
}

import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dir, '../..');

async function fixture(scope: 'graph' | 'lint' | 'format') {
  const cwd = await mkdtemp(join(tmpdir(), 'codebase-checks-'));
  const inputs = {
    // Fallow needs the real reference graph, entry points and tool configuration.
    graph: [
      'scripts',
      '.fallowrc.json',
      '.oxfmtrc.json',
      '.oxlintrc.json',
      'biome.json',
      'tsconfig.json',
    ],
    // Local checks use the production configuration and plugin, plus each test's probes.
    lint: ['scripts/lint/local', '.oxlintrc.json', 'tsconfig.json'],
    format: ['.oxfmtrc.json'],
  };
  for (const path of ['package.json', '.gitignore', ...inputs[scope]]) {
    await cp(join(repo, path), join(cwd, path), { recursive: true });
  }
  await symlink(join(repo, 'node_modules'), join(cwd, 'node_modules'), 'dir');
  return cwd;
}

function run(cwd: string, script: string, ...args: string[]) {
  const result = spawnSync(process.execPath, ['run', script, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 15000,
  });
  expect(result.error).toBeUndefined();
  return result;
}

test('lint rejects unsafe assertions and accumulator copies while preserving checked inputs and local mutation', async () => {
  const cwd = await fixture('lint');
  try {
    await mkdir(join(cwd, 'scripts/tests'), { recursive: true });
    await writeFile(
      join(cwd, 'scripts/tests/trial-allowed.ts'),
      `export function checked(input: unknown) {
        if (typeof input !== 'string') { throw new Error('Expected string'); }
        return input.toUpperCase();
      }
      function isNumber(input: unknown): input is number { return typeof input === 'number'; }
      export function guarded(input: unknown) { return isNumber(input) ? input + 1 : 0; }
      export const literal = { mode: 'safe' } as const;
      export const widened = 1 as number | string;
      export const local = [1, 2].reduce<number[]>((acc, item) => {
        acc.push(item); return acc;
      }, []);
      export const copies = [{ id: 1 }].reduce<{ id: number }[]>((acc, item) => {
        acc.push({ ...item }, Object.assign({}, item)); return acc;
      }, []);
      export const joined = ['a', 'b'].reduce((acc, item) => acc.concat(item), '');
      const textSeed = '';
      export const joinedFromConst = ['a', 'b'].reduce((acc, item) => acc.concat(item), textSeed);
      export const assigned = [{ id: 1 }].reduce<Record<string, number>>((acc, item) =>
        Object.assign(acc, item), {});
      export const shadowed = [{ id: 1 }].reduce((acc, item) => {
        { const acc = item; Object.assign({}, acc); }
        return acc;
      }, {});
      export const reassigned = [{ id: 1 }].reduce((acc, item) => {
        acc = item;
        return Object.assign({}, acc);
      }, { id: 0 });
      export function custom(Object: { assign: (target: object, source: object, item: object) => object }) {
        return [{ id: 1 }].reduce((acc, item) => Object.assign({}, acc, item), {});
      }
      `,
    );
    const allowed = run(cwd, 'lint');
    expect(allowed.status, allowed.stdout + allowed.stderr).toBe(0);

    const cases = [
      {
        path: 'scripts/trial-chain.ts',
        source: "export const value = { id: 'text' } as unknown as { id: number };",
        code: 'typescript(no-unsafe-type-assertion)',
      },
      {
        path: 'scripts/tests/trial-widen.ts',
        source:
          "const value: unknown = { id: 'text' }; export const result = value as { id: number };",
        code: 'typescript(no-unsafe-type-assertion)',
      },
      {
        path: 'scripts/trial-concat.ts',
        source:
          'export const result = [1, 2].reduce<number[]>((acc, item) => acc.concat(item), []);',
        code: 'local(no-reduce-accumulator-copy)',
      },
      {
        path: 'scripts/tests/trial-const-initial.ts',
        source: `const seed = [0]; const initial = seed;
          export const result = [1, 2].reduce((acc, item) => acc.concat(item), initial);`,
        code: 'local(no-reduce-accumulator-copy)',
      },
      {
        path: 'scripts/tests/trial-assign-concat.ts',
        source: `export const result = [1, 2].reduce<number[]>((acc, item) => {
          acc = acc.concat(item); return acc;
        }, []);`,
        code: 'local(no-reduce-accumulator-copy)',
      },
      {
        path: 'scripts/tests/trial-assign.ts',
        source: `export const result = [{ id: 1 }].reduce<Record<string, number>>((acc, item) =>
          Object.assign({}, acc, item), {});`,
        code: 'local(no-reduce-accumulator-copy)',
      },
      {
        path: 'scripts/tests/trial-assign-self.ts',
        source: `export const result = [{ id: 1 }].reduce<Record<string, number>>((acc, item) => {
          acc = Object.assign({}, acc, item); return acc;
        }, {});`,
        code: 'local(no-reduce-accumulator-copy)',
      },
      {
        path: 'scripts/trial-spread.ts',
        source: 'export const result = [1, 2].reduce<number[]>((acc, item) => [...acc, item], []);',
        code: 'oxc(no-accumulating-spread)',
      },
      {
        path: 'scripts/tests/trial-object-spread.ts',
        source: `export const result = [{ id: 1 }].reduce<Record<string, number>>((acc, item) =>
          ({ ...acc, ...item }), {});`,
        code: 'oxc(no-accumulating-spread)',
      },
      {
        path: 'scripts/tests/trial-alias.ts',
        source: `export const result = [1, 2].reduceRight<number[]>((acc, item) => {
          const alias = acc; const next = Array.from(alias); next.push(item); return next;
        }, []);`,
        code: 'local(no-reduce-accumulator-copy)',
      },
    ];
    for (const { path, source } of cases) {
      await writeFile(join(cwd, path), source);
    }
    // Every probe must typecheck: a parser/type failure must not stand in for the lint rule.
    const types = run(cwd, 'typecheck');
    expect(types.status, types.stdout + types.stderr).toBe(0);
    const result = run(cwd, 'lint', '--format', 'json');
    expect(result.status).toBe(1);
    const report: unknown = JSON.parse(result.stdout);
    expect(report).toHaveProperty(
      'diagnostics',
      expect.arrayContaining(
        cases.map(({ path, code }): unknown =>
          expect.objectContaining({ filename: path, code, severity: 'error' }),
        ),
      ),
    );
    expect(report).toHaveProperty('diagnostics.length', cases.length);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('unused check detects unreachable code but preserves real entries and imported exports', async () => {
  const cwd = await fixture('graph');
  try {
    expect(run(cwd, 'check:unused').status).toBe(0);
    // Reuse Issue #174's file/export controls; add the entry-export and type boundaries.
    await writeFile(join(cwd, 'scripts/trial-unused.ts'), 'export const trialUnusedFile = 712;\n');
    await writeFile(join(cwd, 'scripts/trial-used.ts'), 'export const trialUsedExport = 421;\n');
    await appendFile(
      join(cwd, 'scripts/shared/values.ts'),
      '\nexport const trialUnusedExport = 913;\nexport type TrialUnusedType = { marker: string };\n',
    );
    await appendFile(
      join(cwd, 'scripts/tests/review.test.ts'),
      '\nimport { trialUsedExport } from "../trial-used.ts"; console.log(trialUsedExport);\n' +
        'export const trialEntryUnused = 17;\n',
    );
    const result = run(cwd, 'check:unused');
    expect(result.status).toBe(1);
    const report: unknown = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      total_issues: 4,
      unused_files: [{ path: 'scripts/trial-unused.ts' }],
      unused_types: [{ path: 'scripts/shared/values.ts', export_name: 'TrialUnusedType' }],
    });
    expect(report).toHaveProperty(
      'unused_exports',
      expect.arrayContaining([
        expect.objectContaining({
          path: 'scripts/shared/values.ts',
          export_name: 'trialUnusedExport',
        }),
        expect.objectContaining({
          path: 'scripts/tests/review.test.ts',
          export_name: 'trialEntryUnused',
        }),
      ]),
    );
    expect(result.stdout).not.toContain('"export_name":"trialUsedExport"');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('unused check rejects runtime import cycles but allows type-only references', async () => {
  const cwd = await fixture('graph');
  try {
    await writeFile(
      join(cwd, 'scripts/tests/trial-cycle.test.ts'),
      `import { readMarker } from '../trial-cycle.ts';
      export function marker() { return 1; }
      console.log(readMarker());`,
    );
    const module = join(cwd, 'scripts/trial-cycle.ts');
    await writeFile(
      module,
      `import type { marker } from './tests/trial-cycle.test.ts';
      export function readMarker(): ReturnType<typeof marker> { return 1; }`,
    );
    const allowed = run(cwd, 'check:unused');
    expect(allowed.status, allowed.stdout + allowed.stderr).toBe(0);

    await writeFile(
      module,
      `import { marker } from './tests/trial-cycle.test.ts';
      export function readMarker() { return marker(); }`,
    );
    const result = run(cwd, 'check:unused');
    expect(result.status).toBe(1);
    const report: unknown = JSON.parse(result.stdout);
    expect(report).toMatchObject({ total_issues: 1 });
    expect(report).toHaveProperty('circular_dependencies.length', 1);
    expect(report).toHaveProperty(
      'circular_dependencies.0.files',
      expect.arrayContaining(['scripts/trial-cycle.ts', 'scripts/tests/trial-cycle.test.ts']),
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('unused check fails for a dependency alone, degraded parsing, and invalid configuration', async () => {
  const cwd = await fixture('graph');
  try {
    const manifest = await readFile(join(cwd, 'package.json'), 'utf8');
    await writeFile(
      join(cwd, 'package.json'),
      manifest.replace(
        '"devDependencies": {',
        '"devDependencies": {"trial-unused-dependency":"1.0.0",',
      ),
    );
    const dependency = run(cwd, 'check:unused');
    expect(dependency.status).toBe(1);
    const report: unknown = JSON.parse(dependency.stdout);
    expect(report).toMatchObject({
      total_issues: 1,
      unused_dev_dependencies: [{ package_name: 'trial-unused-dependency' }],
    });
    await writeFile(join(cwd, 'package.json'), manifest);

    // Isolate the parse error from real imports so it cannot create unused findings.
    // Fallow itself exits zero; the wrapper must still reject the incomplete analysis.
    const brokenSource = join(cwd, 'scripts/tests/trial-parse.test.ts');
    await writeFile(brokenSource, 'const broken = ;\n');
    const parsing = run(cwd, 'check:unused');
    expect(parsing.status).toBe(1);
    expect(parsing.stderr).toContain('Incomplete fallow analysis');
    const partial: unknown = JSON.parse(parsing.stdout);
    expect(partial).toMatchObject({ total_issues: 0 });
    expect(partial).toHaveProperty(
      'workspace_diagnostics',
      expect.arrayContaining([
        expect.objectContaining({
          path: 'scripts/tests/trial-parse.test.ts',
          kind: 'source-parse-degraded',
          degrades_analysis: true,
        }),
      ]),
    );
    await rm(brokenSource);

    await writeFile(join(cwd, '.fallowrc.json'), '{broken');
    const config = run(cwd, 'check:unused');
    expect(config.status).toBe(1);
    expect(config.stderr).toContain('fallow failed (2)');
    expect(config.stdout).toContain('Failed to parse config file');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('format checks and writes root and nested TS without changing other scripts files', async () => {
  const cwd = await fixture('format');
  try {
    await mkdir(join(cwd, 'scripts/nested'), { recursive: true });
    const typescript = ['scripts/trial-format.ts', 'scripts/nested/trial-format.ts'];
    const excluded = ['scripts/trial-format.md', 'scripts/nested/trial-format.js'];
    const source = 'const probe={value:"unformatted"}\n';
    for (const path of [...typescript, ...excluded]) {
      await writeFile(join(cwd, path), source);
    }
    const check = run(cwd, 'format:check');
    expect(check.status).toBe(1);
    for (const path of typescript) {
      expect(check.stdout + check.stderr).toContain(path);
    }
    expect(run(cwd, 'format').status).toBe(0);
    expect(run(cwd, 'format:check').status).toBe(0);
    for (const path of typescript) {
      expect(await readFile(join(cwd, path), 'utf8')).toBe(
        "const probe = { value: 'unformatted' };\n",
      );
    }
    for (const path of excluded) {
      expect(await readFile(join(cwd, path), 'utf8')).toBe(source);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

/** @file Outcome: Production standalone publication requires two distinct genuine audits and rejects unsafe evidence before creation. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'bun:test';
import { armIntent } from '../../runtime/invocation.ts';
import { runResearchWorkflow } from '../../research/runner.ts';
import { CodexResearchAgent, type ResearchAgent } from '../../research/agent.ts';
import { validatePublicSafety, type PublicSafetyAudit } from '../../research/public-safety.ts';
import { draft, reproduced, sourceFixture, reportContext } from './public-safety-fixtures.ts';
import {
  loadResearchState,
  saveResearchState,
  researchSnapshotPath,
} from '../../research/state.ts';
import { readCorpusReport } from '../../research/corpus.ts';
import { temporaryDirectory, useTemporaryWorkflowStorage } from '../shared/fixtures.ts';
useTemporaryWorkflowStorage('public-safety-');
function fixture(tracked = true) {
  const repo = sourceFixture(tracked);
  const runId = crypto.randomUUID(),
    input = armIntent({ runId, workflow: 'research', cwd: repo }).input_path;
  fs.writeFileSync(
    input,
    JSON.stringify({
      repo,
      question: 'What is exported?',
      scope_paths: [],
      allow_external_sources: false,
    }),
  );
  return { repo, runId, input };
}
const safe: ResearchAgent = {
  async investigate() {
    return draft;
  },
  async audit() {
    return { summary: 'Source checked.', findings: [] };
  },
  async auditPublicSafety(_input, context) {
    return { verdict: 'safe', coverage: context.strings.map((item) => item.path), findings: [] };
  },
};
const run = (f: ReturnType<typeof fixture>, agent: ResearchAgent = safe) =>
  runResearchWorkflow(f.runId, f.input, agent);
function noPair(repo: string) {
  for (const directory of ['records', 'reports'])
    assert.equal(fs.existsSync(path.join(repo, 'research', directory)), false);
}
test('source and safety audits are distinct and preserve all meaning-bearing values without Git mutation', async () => {
  const f = fixture();
  const before = execFileSync('git', ['-C', f.repo, 'ls-files', '--stage']).toString();
  const refs = execFileSync('git', ['-C', f.repo, 'for-each-ref']).toString();
  const calls: string[] = [];
  const result = await run(f, {
    ...safe,
    async audit() {
      calls.push('source');
      return { summary: 'Accepted source.', findings: [] };
    },
    async auditPublicSafety(input, context, snapshot) {
      calls.push('safety');
      assert.equal(input.allow_external_sources, false);
      assert.equal(snapshot, researchSnapshotPath(f.runId, loadResearchState(f.runId)!));
      assert.deepEqual(context.report.rejected, draft.rejected);
      assert(context.strings.some((item) => item.path === '/findings/0/qualification'));
      return safe.auditPublicSafety!(input, context, snapshot);
    },
  });
  assert(result.status === 'completed');
  assert.deepEqual(calls, ['source', 'safety']);
  const report = readCorpusReport(f.repo, result.report_json);
  for (const key of ['answer', 'rejected', 'unknowns', 'limitations'] as const)
    assert.deepEqual(report[key], draft[key]);
  assert.equal(path.basename(result.report_markdown), `${report.research_id}.md`);
  assert.equal(execFileSync('git', ['-C', f.repo, 'ls-files', '--stage']).toString(), before);
  assert.equal(execFileSync('git', ['-C', f.repo, 'for-each-ref']).toString(), refs);
});
const hazards = [
  'password=do-not-publish',
  '{"password": "do-not-publish"}',
  '{"refresh_token": "do-not-publish"}',
  '{"SecretAccessKey":"synthetic-private-key"}',
  '{"region":"public","credentials":{"apiToken":"synthetic-private-token"}}',
  'region=public,apiToken=synthetic-private-token',
  'https://openai.com/?region=public&apiToken=synthetic-private-token',
  'apiToken=synthetic-private-token',
  '{"secretAccessKey": "synthetic-private-key"}',
  'SECRETACCESSKEY=synthetic-private-key',
  'serviceSecretAccessKey: synthetic-private-key',
  'service_api_token=synthetic-private-token',
  "SERVICE-API-TOKEN='synthetic-private-token'",
  '{"ApiToken": "synthetic-private-token"}',
  'APITOKEN=synthetic-private-token',
  'sessionToken=synthetic-private-token',
  'bearerToken=synthetic-private-token',
  'clientSecret=synthetic-private-secret',
  'serviceClientSecret=synthetic-private-secret',
  'apiKey=synthetic-private-key',
  'secretKey=synthetic-private-key',
  'accessKeyId=synthetic-private-identifier',
  'dbPass=synthetic-private-password',
  'ａｐｉＴｏｋｅｎ＝synthetic-private-token',
  'https://openai.com/?api%54oken=synthetic-private-token',
  'https://openai.com/#Secret%41ccessKey=synthetic-private-key',
  'DB_PASSWORD=synthetic-private-password',
  'PGPASSWORD=synthetic-private-password',
  'export PGPASSWORD = "synthetic-private-password"',
  '{"pgpassword": "synthetic-private-password"}',
  'MYSQLPWD=synthetic-private-password',
  'servicePassword: synthetic-private-password',
  'APP_DB2PASSWD=synthetic-private-password',
  'DB_PASS=synthetic-private-password',
  'PASS=synthetic-private-password',
  "SERVICE-DB-PASS='synthetic-private-password'",
  '{"db_pass": "synthetic-private-password"}',
  'PASSPHRASE=synthetic-private-passphrase',
  'SSH_KEY_PASSPHRASE=synthetic-private-passphrase',
  'keyPassphrase: synthetic-private-passphrase',
  'ＰＧＰＡＳＳＷＯＲＤ＝synthetic-private-password',
  'https://openai.com/?PGPASSWORD=synthetic-private-password',
  'https://openai.com/?DB%5FPASS=synthetic-private-password',
  'https://openai.com/#PG%50ASSWORD=synthetic-private-password',
  '_PASSWORD=synthetic-private-password',
  '__SERVICE2_DB_PASSWORD=synthetic-private-password',
  'export AWS_SECRET_ACCESS_KEY=synthetic-private-key',
  'APP_DATABASE_PASSWORD = "synthetic-private-password"',
  'db_password: synthetic-private-password',
  '{"AWS_SECRET_ACCESS_KEY": "synthetic-private-key"}',
  "SERVICE-API-KEY='synthetic-private-key'",
  'DATABASE_PASSWD=synthetic-private-password',
  'DB_PWD=synthetic-private-password',
  'SERVICE_AUTH_TOKEN=synthetic-private-token',
  'CI_JOB_TOKEN=synthetic-private-token',
  'APP_SIGNING_KEY=synthetic-private-key',
  'DJANGO_SECRET_KEY=synthetic-private-key',
  'AWS_ACCESS_KEY_ID=synthetic-private-identifier',
  'AWS_SESSION_TOKEN=synthetic-private-token',
  'TLS_PRIVATE_KEY=synthetic-private-key',
  'ＤＢ＿ＰＡＳＳＷＯＲＤ＝synthetic-private-password',
  'https://openai.com/?AWS%5FSECRET%5FACCESS%5FKEY=synthetic-private-key',
  'https://openai.com/#DB_PASSWORD=synthetic-private-password',
  '090-1234-5678',
  '080 1234 5678',
  '070.1234.5678',
  '０９０－１２３４－５６７８',
  '09012345678',
  '03-1234-5678',
  '(03) 1234-5678',
  '090(1234)5678',
  '045-123-4567',
  '0120-123-456',
  '020 7946 0958',
  '01 23 45 67 89',
  'c:\\users\\alice\\secret',
  '415-555-2671',
  '(415) 555-2671',
  'Contact number: (415)555-2671',
  '(415)5552671',
  'https://openai.com/?access%5Ftoken=synthetic-test-credential',
  'https://openai.com/?%70assword=synthetic-test-credential',
  'https://openai.com/?API%2DKEY=synthetic-test-credential',
  'https://openai.com/?note=%70assword%3Dsynthetic-test-credential',
  'https://openai.com/#refresh%5Ftoken=synthetic-test-credential',
  'c:\\Users\\alice\\secret',
  'https://service.home.arpa/status',
  'service.home.arpa',
  'service.home.arpa:8443',
  'SERVICE.HOME.ARPA:8443/status',
  'service.home.arpa.:8443/status',
  'home.arpa',
  'service.local:8443',
  'service.internal:8443',
  'service.invalid:8443',
  'service.test:8443',
  'service.example:8443',
  'service.onion:8443',
  'service.example.com:8443',
  'service.example.org',
  'service.example.net.',
  '10.0.0.1:8443',
  '/Users/alice/private',
  'alice@company.org',
  'https://127.0.0.1/admin',
  'http://openai.com',
  'https://name:pass@openai.com',
  'https://[::1]/',
  'https://[2001::1]/',
  'https://[2001:2::1]/',
  'https://[3fff::1]/',
  'fd00::1',
  'https:user:pass@openai.com',
  '/private/var/folders/user/private',
  '<img src=x>',
  '![embed](https://openai.com)',
  'data:text/plain,secret',
  '+1 555 234 5678',
  'untracked',
  'reproduction',
];

test('every hazard format is rejected by the production validator against controlled sources', () => {
  const tracked = sourceFixture();
  const untracked = sourceFixture(false);
  const copied = sourceFixture(true, `${reproduced}\n`);
  // Prove each source supports a safe control, apart from the deliberately untracked citation.
  assert.doesNotThrow(() => validatePublicSafety(reportContext(), tracked));
  assert.doesNotThrow(() => validatePublicSafety(reportContext(), copied));
  for (const hazard of hazards) {
    const snapshot =
      hazard === 'untracked' ? untracked : hazard === 'reproduction' ? copied : tracked;
    const answer =
      hazard === 'reproduction' ? reproduced : hazard === 'untracked' ? draft.answer : hazard;
    assert.throws(
      () => validatePublicSafety(reportContext({ answer }), snapshot),
      /public-safety/,
      hazard,
    );
  }
  assert.doesNotThrow(() => validatePublicSafety(reportContext(), tracked));
});

// Distinct rejection paths still cross the real Research entrypoint and publication boundary.
for (const hazard of [
  'password=do-not-publish',
  '090-1234-5678',
  'alice@company.org',
  '/Users/alice/private',
  'service.home.arpa',
  'https://127.0.0.1/admin',
  '<img src=x>',
  '![embed](https://openai.com)',
  'data:text/plain,secret',
  'untracked',
  'reproduction',
])
  test(`hazard path ${hazard} rejects before safety dispatch or corpus creation`, async () => {
    const f = fixture(hazard !== 'untracked');
    if (hazard === 'reproduction')
      fs.writeFileSync(path.join(f.repo, 'value.ts'), `${reproduced}\n`);
    let calls = 0;
    await assert.rejects(
      run(f, {
        ...safe,
        async investigate() {
          return {
            ...draft,
            answer:
              hazard === 'reproduction'
                ? reproduced
                : hazard === 'untracked'
                  ? draft.answer
                  : hazard,
          };
        },
        async auditPublicSafety() {
          calls++;
          throw new Error('deterministic rejection must precede this call');
        },
      }),
      /public-safety/,
    );
    assert.equal(calls, 0);
    noPair(f.repo);
  });
test('public bare hosts and reserved-looking prefixes reach independent safety audit unchanged', async () => {
  const f = fixture();
  const answer =
    'openai.com:443 and service.home.arpa.openai.com:8443 retain public DNS suffixes. https://openai.com/?topic=storage%20choices#section=overview is public context.';
  let calls = 0;
  const result = await run(f, {
    ...safe,
    async investigate() {
      return { ...draft, answer };
    },
    async auditPublicSafety(input, context, snapshot) {
      calls++;
      assert.equal(context.report.answer, answer);
      return safe.auditPublicSafety!(input, context, snapshot);
    },
  });
  assert.equal(calls, 1);
  assert(result.status === 'completed');
  assert.equal(readCorpusReport(f.repo, result.report_json).answer, answer);
});
test('credential policy names and ordinary numeric prose reach safety audit unchanged', async () => {
  const f = fixture();
  const answer = [
    'DB_PASSWORD_REQUIRED=true; PASSWORD_MIN_LENGTH=12; AWS_REGION=us-east-1.',
    'API_KEY_ROTATION_DAYS=30; TOKEN_COUNT=42; KEYBOARD_LAYOUT=us.',
    'PGPASSWORD_REQUIRED=true; DB_PASS_MIN_LENGTH=12; PASSPHRASE_POLICY=strict.',
    'BYPASS=false; COMPASS=north; OVERPASS=enabled; PASS_COUNT=2.',
    'apiTokenCount=42; SecretAccessKeyRequired=true; clientSecretRotationDays=30.',
    'MONKEY=animal; SECRETARY=role; TOKENIZER=enabled; compass=north; bypass=false.',
    'Configure apiToken, SecretAccessKey and clientSecret using the credential provider.',
    'https://openai.com/?apiTokenCount=42#SecretAccessKeyRequired=true describes policy.',
    'Configure DB_PASSWORD and AWS_SECRET_ACCESS_KEY using the credential provider.',
    'Configure PGPASSWORD, DB_PASS and SSH_KEY_PASSPHRASE using the credential provider.',
    'The release date is 2026-09-08 or 08-09-2026, with range 010-020-030.',
    'The postal code is 100-0001 and version is 0.1234.5678.',
    'Identifier build09012345678 and counter 1234567890 are ordinary values.',
    'https://openai.com/?PASSWORD_MIN_LENGTH=12#TOKEN_COUNT=42 describes policy.',
  ].join(' ');
  let calls = 0;
  const result = await run(f, {
    ...safe,
    async investigate() {
      return { ...draft, answer };
    },
    async auditPublicSafety(input, context, snapshot) {
      calls++;
      assert.equal(context.report.answer, answer);
      return safe.auditPublicSafety!(input, context, snapshot);
    },
  });
  assert.equal(calls, 1);
  assert(result.status === 'completed');
  assert.equal(readCorpusReport(f.repo, result.report_json).answer, answer);
});
test('unsafe, indeterminate, incomplete, malformed and absent safety responses cannot use source-audit acceptance', async () => {
  for (const mode of [
    'unsafe',
    'indeterminate',
    'coverage',
    'extra',
    'findings',
    'absent',
    'throw',
  ]) {
    const f = fixture();
    let sourceCalls = 0,
      safetyCalls = 0;
    const agent: ResearchAgent = {
      ...safe,
      async audit() {
        sourceCalls++;
        return { summary: 'Accepted source.', findings: [] };
      },
    };
    if (mode === 'absent') delete agent.auditPublicSafety;
    else
      agent.auditPublicSafety = async (_input, context) => {
        safetyCalls++;
        if (mode === 'throw') throw new Error('sensitive response contents');
        return {
          verdict: mode === 'unsafe' || mode === 'indeterminate' ? mode : 'safe',
          coverage: mode === 'coverage' ? [] : context.strings.map((item) => item.path),
          findings: mode === 'findings' ? [{ path: '/answer', code: 'secret' }] : [],
          ...(mode === 'extra' ? { text: 'sensitive content' } : {}),
        } as PublicSafetyAudit;
      };
    await assert.rejects(
      run(f, agent),
      (error) =>
        error instanceof Error &&
        /public-safety/.test(error.message) &&
        !error.message.includes('sensitive'),
    );
    assert.equal(sourceCalls, 1);
    assert(safetyCalls <= 2);
    noPair(f.repo);
  }
});
test('changed dispatch, candidate, snapshot and permissions cannot adopt a safety response', async () => {
  for (const mutation of ['dispatch', 'candidate', 'snapshot', 'permissions']) {
    const f = fixture();
    await assert.rejects(
      run(f, {
        ...safe,
        async auditPublicSafety(input, context, snapshot) {
          const state = loadResearchState(f.runId)!;
          if (mutation === 'snapshot') fs.writeFileSync(path.join(snapshot, 'value.ts'), 'changed');
          else {
            if (mutation === 'dispatch') state.dispatch = crypto.randomUUID();
            if (mutation === 'candidate') state.candidate!.answer = 'Changed value.';
            if (mutation === 'permissions') state.input.allow_external_sources = true;
            saveResearchState(f.runId, state);
          }
          return safe.auditPublicSafety!(input, context, snapshot);
        },
      }),
    );
    noPair(f.repo);
  }
});
test('completed retrieval rejects divergent output and missing genuine acceptance', async () => {
  const f = fixture(),
    result = await run(f);
  assert(result.status === 'completed');
  const original = fs.readFileSync(result.report_markdown, 'utf8');
  fs.writeFileSync(result.report_markdown, 'different bytes');
  await assert.rejects(run(f));
  assert.equal(fs.readFileSync(result.report_markdown, 'utf8'), 'different bytes');
  fs.writeFileSync(result.report_markdown, original);
  const state = loadResearchState(f.runId)!;
  state.safety = null;
  saveResearchState(f.runId, state);
  fs.unlinkSync(result.report_markdown);
  await assert.rejects(run(f), /Retain the record/);
  assert.equal(fs.existsSync(result.report_markdown), false);
});
test('production semantic adapter creates a fresh read-only thread with exact full context and inherited web permissions', async () => {
  const f = fixture();
  const context = reportContext();
  let threads = 0;
  const agent = new CodexResearchAgent({
    startThread(options) {
      threads++;
      assert.equal(options?.sandboxMode, 'read-only');
      assert.equal(options?.approvalPolicy, 'never');
      assert.equal(options?.workingDirectory, f.repo);
      assert.equal(options?.webSearchMode, threads === 1 ? 'disabled' : 'live');
      return {
        async run(prompt) {
          assert(prompt.includes(JSON.stringify(context)));
          assert(prompt.includes('web-source reproduction'));
          return {
            finalResponse: JSON.stringify({
              verdict: 'safe',
              coverage: context.strings.map((item) => item.path),
              findings: [],
            }),
          };
        },
      };
    },
  });
  for (const allow_external_sources of [false, true])
    await agent.auditPublicSafety(
      { repo: f.repo, question: 'What is exported?', scope_paths: [], allow_external_sources },
      context,
      f.repo,
    );
  assert.equal(threads, 2);
});

test('second-file failure removes only this attempt files and resumes genuine safety acceptance without model work', async () => {
  const f = fixture(),
    script = path.join(temporaryDirectory('safety-failure-'), 'run.ts');
  const runner = new URL('../../research/runner.ts', import.meta.url).pathname;
  fs.writeFileSync(
    script,
    `
    import fs from 'node:fs';
    import { mock } from 'bun:test';
    const link = fs.linkSync;
    fs.linkSync = (...args) => {
      if (String(args[1]).endsWith('.md')) throw new Error('controlled second-file failure');
      return link(...args);
    };
    mock.module('node:fs', () => ({ ...fs, default: fs }));
    const { runResearchWorkflow } = await import(${JSON.stringify(runner)});
    try {
      await runResearchWorkflow(${JSON.stringify(f.runId)}, ${JSON.stringify(f.input)}, {
        async investigate() { return ${JSON.stringify(draft)}; },
        async audit() { return { summary: 'Source accepted.', findings: [] }; },
        async auditPublicSafety(_input, context) { return { verdict: 'safe', coverage: context.strings.map(item => item.path), findings: [] }; },
      });
      process.exit(9);
    } catch (error) { if (!error.message.includes('controlled second-file failure')) throw error; }
  `,
  );
  const processResult = Bun.spawn([process.execPath, script], {
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  assert.equal(await processResult.exited, 0, await new Response(processResult.stderr).text());
  const state = loadResearchState(f.runId)!;
  assert.equal(state.phase, 'publish');
  assert(state.safety);
  assert.equal(fs.existsSync(state.publication!.json), false);
  assert.equal(fs.existsSync(state.publication!.markdown), false);
  const forbidden = async (): Promise<never> => {
    throw new Error('Accepted model work must not repeat');
  };
  const result = await run(f, {
    investigate: forbidden,
    audit: forbidden,
    auditPublicSafety: forbidden,
  });
  assert(result.status === 'completed');
  assert.equal(result.report_json, state.publication!.json);
  assert.deepEqual(loadResearchState(f.runId)!.safety, state.safety);
});

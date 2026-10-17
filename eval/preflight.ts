import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { isRecord } from '../scripts/shared/values.ts';
import type { EvalConfig } from './data.ts';
import { withInterrupts } from '../scripts/shared/process.ts';
import { sandboxPreflightTrial } from './sandbox.ts';
import type { preparePlan } from './eval.ts';
import { preflightGatewayEntrypoint } from './preflight-container.ts';
import { preflightWorkerEntrypoint } from './preflight-worker.ts';

// 固定応答・期待値の正本は独立担当の資産。実装側で成功まで応答を探索しない。
const relativeFile = z
  .string()
  .regex(/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/)
  .refine((path) => path.split('/').every((part) => part !== '.' && part !== '..'));
const scenarioSchema = z.strictObject({
  id: z.enum([
    'scoping',
    'initial',
    'boundaries',
    'command-failure',
    'missing-marker',
    'timeout',
    'interrupt',
  ]),
  prompt: z.string().min(1),
  responseSchema: z.record(z.string(), z.unknown()).optional(),
  steps: z
    .array(
      z.strictObject({
        requestIncludes: z.array(z.string().min(1)),
        sse: z.string().min(1),
      }),
    )
    .min(1)
    .max(4),
  files: z.record(relativeFile, z.string()),
  marker: z.string().min(1),
  artifact: relativeFile,
  artifactText: z.string().min(1),
  runtimeArtifact: relativeFile,
  expectedRejected: z.number().int().min(1).max(16).default(1),
  networkCanary: z
    .strictObject({
      path: z.string().regex(/^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/),
      body: z.string().min(1),
    })
    .optional(),
});

const runtimeObservation = z
  .array(
    z.strictObject({
      role: z.enum(['operation', 'child']),
      bunVersion: z.string(),
      execPath: z.string(),
      realPath: z.string(),
    }),
  )
  .min(1)
  .max(2);

function verifyOperationRuntime(value: unknown, bun: string, child: boolean) {
  const observations = runtimeObservation.parse(value);
  assert.deepStrictEqual(
    observations.map((item) => item.role).sort(),
    child ? ['child', 'operation'] : ['operation'],
  );
  assert(
    observations.every(
      (item) =>
        item.bunVersion === bun &&
        item.realPath === '/usr/local/bin/bun' &&
        item.execPath === '/usr/local/bin/bun',
    ),
    'Operation runtime differs',
  );
  return observations;
}

function jsonLines(text: string): Record<string, unknown>[] {
  return text
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const value: unknown = JSON.parse(line);
        return isRecord(value) ? [value] : [];
      } catch {
        return [];
      }
    });
}

function gatewayToolResults(events: Record<string, unknown>[]) {
  const outputs: string[] = [];
  for (const event of events) {
    if (
      event.type !== 'preflight.request' ||
      !isRecord(event.body) ||
      !Array.isArray(event.body.input)
    ) {
      continue;
    }
    for (const item of event.body.input) {
      if (
        isRecord(item) &&
        ['function_call_output', 'custom_tool_call_output'].includes(String(item.type))
      ) {
        outputs.push(typeof item.output === 'string' ? item.output : JSON.stringify(item.output));
      }
    }
  }
  return outputs.join('\n');
}

function knownToolFailure(events: Record<string, unknown>[], outputs: string) {
  if (/Process exited with code [1-9][0-9]*|"exit_code"\s*:\s*[1-9][0-9]*/.test(outputs)) {
    return true;
  }
  return events.some(
    (event) =>
      isRecord(event.item) &&
      event.item.type === 'command_execution' &&
      (event.item.status === 'failed' ||
        (typeof event.item.exit_code === 'number' && event.item.exit_code !== 0)),
  );
}

function artifactFiles(lines: Record<string, unknown>[]) {
  const snapshots = lines.filter((line) => line.type === 'eval.artifacts');
  assert(
    snapshots.length === 1 && !lines.some((line) => line.type === 'eval.artifacts_missing'),
    'Artifact snapshot missing',
  );
  const snapshot = snapshots[0];
  assert(snapshot, 'Invalid artifacts');
  return z.array(z.strictObject({ path: z.string(), base64: z.string() })).parse(snapshot.files);
}

function operationRuntime(
  files: ReturnType<typeof artifactFiles>,
  scenario: z.infer<typeof scenarioSchema>,
  bun: string,
) {
  const observed = files.find((file) => file.path === scenario.runtimeArtifact);
  assert(observed, 'Operation runtime artifact missing');
  verifyOperationRuntime(
    JSON.parse(Buffer.from(observed.base64, 'base64').toString()),
    bun,
    scenario.id === 'boundaries',
  );
}

function observedSuccess(
  lines: Record<string, unknown>[],
  toolResults: string,
  scenario: z.infer<typeof scenarioSchema>,
  files: ReturnType<typeof artifactFiles>,
) {
  assert(!knownToolFailure(lines, toolResults), 'Known command failed');
  const artifact = files.find((file) => file.path === scenario.artifact);
  assert(
    artifact && Buffer.from(artifact.base64, 'base64').toString() === scenario.artifactText,
    'Expected artifact missing',
  );
  assert(toolResults.includes(scenario.marker), 'Expected operation marker missing');
  assert(
    lines.some((line) => line.type === 'turn.completed'),
    'CLI turn incomplete',
  );
  if (scenario.responseSchema) {
    const file = files.find((file) => file.path === 'actor-records/final.json');
    assert(file, 'Response schema output missing');
    z.strictObject({ status: z.literal('repaired'), findings: z.string() }).parse(
      JSON.parse(Buffer.from(file.base64, 'base64').toString()),
    );
  }
}

function assertExchange(value: unknown, expected: number, rejected: number) {
  // 共通probeの1件と固定操作の予定した拒否だけを認める。
  assert(
    value &&
      typeof value === 'object' &&
      'requests' in value &&
      value.requests === expected &&
      'failed' in value &&
      value.failed === false &&
      'rejected' in value &&
      value.rejected === rejected,
    'Mock exchange incomplete',
  );
}

function compatibilityIdentity(plan: Awaited<ReturnType<typeof preparePlan>>) {
  const { outputDirectory: _output, preflightDirectory: _proof, ...config } = plan.config;
  return createHash('sha256')
    .update(
      JSON.stringify({
        config,
        sources: plan.runner.sourceHashes,
        launch: plan.effectiveLaunch,
        inputs: plan.variants.map((variant) => variant.versions),
        corpus: plan.corpusHash,
      }),
    )
    .digest('hex');
}

export async function requireCompatibilityProof(plan: Awaited<ReturnType<typeof preparePlan>>) {
  assert(
    plan.config.preflightDirectory,
    'Model-free preflight evidence required before model launch',
  );
  const value: unknown = JSON.parse(
    await readFile(resolve(plan.config.preflightDirectory, 'preflight.json'), 'utf8'),
  );
  const proof = z
    .object({
      manifest: z.object({
        identity: z.string(),
        modelFree: z.literal(true),
        fixtureSha256: z.string(),
      }),
      error: z.null(),
      records: z
        .array(z.object({ scenario: scenarioSchema.shape.id, status: z.literal('passed') }))
        .length(7),
    })
    .parse(value);
  const fixture = await readFile(resolve(import.meta.dir, 'tests/preflight.json'));
  assert(
    proof.manifest.identity === compatibilityIdentity(plan) &&
      proof.manifest.fixtureSha256 === createHash('sha256').update(fixture).digest('hex') &&
      new Set(proof.records.map((item) => item.scenario)).size === 7,
    'Preflight differs from current inputs, runner, image, scenarios or launch settings',
  );
}

function operationReady(actor: string, scenario: z.infer<typeof scenarioSchema>, bun: string) {
  const state = spawnSync('docker', ['inspect', '--format', '{{.State.Running}}', actor], {
    timeout: 1000,
    encoding: 'utf8',
  });
  const script = `const text=await Bun.file(${JSON.stringify(`/work/repo/${scenario.artifact}`)}).text();if(text!==${JSON.stringify(scenario.artifactText)})process.exit(1);console.log(JSON.stringify(JSON.parse(await Bun.file(${JSON.stringify(`/work/repo/${scenario.runtimeArtifact}`)}).text())));`;
  const operation = spawnSync('docker', ['exec', actor, '/usr/local/bin/bun', '-e', script], {
    timeout: 1000,
    encoding: 'utf8',
    maxBuffer: 64 * 1024,
  });
  if (state.status !== 0 || state.stdout.trim() !== 'true' || operation.status !== 0) {
    return;
  }
  try {
    return verifyOperationRuntime(JSON.parse(operation.stdout), bun, false);
  } catch {
    return;
  }
}

async function stoppedSession(
  config: EvalConfig,
  dir: string,
  scenario: z.infer<typeof scenarioSchema>,
) {
  assert(
    !Object.hasOwn(scenario.files, scenario.artifact) &&
      !Object.hasOwn(scenario.files, scenario.runtimeArtifact),
    'Readiness artifacts must be created by the operation',
  );
  await writeFile(resolve(dir, 'host-config.json'), JSON.stringify(config));
  const child = Bun.spawn([process.execPath, preflightWorkerEntrypoint, dir], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  });
  const forwardInterrupt = () => {
    child.kill('SIGINT');
  };
  process.on('SIGINT', forwardInterrupt);
  process.on('SIGTERM', forwardInterrupt);
  let signalled = false;
  let operationSeen = false;
  const timer = setTimeout(() => child.kill('SIGKILL'), 185000);
  let observer: ReturnType<typeof setInterval> | undefined;
  const chunks: Uint8Array[] = [];
  let pending = '';
  const decoder = new TextDecoder();
  const stderr = new Response(child.stderr).text();
  try {
    for await (const chunk of child.stdout) {
      chunks.push(chunk);
      pending += decoder.decode(chunk, { stream: true });
      if (!observer && pending.includes('"type":"preflight.actor-start"')) {
        const event = jsonLines(pending).find((line) => line.type === 'preflight.actor-start');
        assert(
          event &&
            typeof event.actor === 'string' &&
            /^dotagents-eval-[a-f0-9-]+-actor$/.test(event.actor),
          'Invalid interrupt target',
        );
        const actor = event.actor;
        observer = setInterval(() => {
          if (operationSeen) {
            return;
          }
          const runtime = operationReady(actor, scenario, config.bunVersion);
          if (runtime) {
            operationSeen = true;
            writeFileSync(
              resolve(dir, 'operation-observation.json'),
              JSON.stringify({
                actor,
                running: true,
                observedAt: Date.now(),
                artifact: scenario.artifact,
                artifactText: scenario.artifactText,
                runtime,
              }),
            );
            if (scenario.id === 'interrupt') {
              signalled = true;
              child.kill('SIGINT');
            }
          }
        }, 100);
      }
    }
    await child.exited;
    await writeFile(resolve(dir, 'worker.stdout'), Buffer.concat(chunks));
    await writeFile(resolve(dir, 'worker.stderr'), await stderr);
    assert(operationSeen, 'Fixed operation not started');
    if (scenario.id === 'interrupt') {
      assert(signalled, 'Interrupt target not reached');
    }
    // workerは共有停止経路でcleanupし、終了を観測してからこの記録を保存する。
    return z
      .object({
        mode: z.string(),
        launched: z.boolean(),
        execution: z.string(),
        reason: z.string(),
        versions: z.unknown(),
        requests: z.unknown(),
        safety: z.strictObject({ containersRemoved: z.boolean(), networkRemoved: z.boolean() }),
      })
      .parse(JSON.parse(await readFile(resolve(dir, 'session.json'), 'utf8')));
  } finally {
    clearTimeout(timer);
    clearInterval(observer);
    process.off('SIGINT', forwardInterrupt);
    process.off('SIGTERM', forwardInterrupt);
  }
}

async function verifyStoppedOperation(
  result: Awaited<ReturnType<typeof sandboxPreflightTrial>>,
  scenario: z.infer<typeof scenarioSchema>,
  dir: string,
  bunVersion: string,
) {
  const seen = z
    .object({
      running: z.literal(true),
      artifact: z.literal(scenario.artifact),
      artifactText: z.literal(scenario.artifactText),
      runtime: z.unknown(),
    })
    .parse(JSON.parse(await readFile(resolve(dir, 'operation-observation.json'), 'utf8')));
  verifyOperationRuntime(seen.runtime, bunVersion, false);
  if (scenario.id === 'interrupt') {
    assert(
      result.reason.startsWith('Interrupted execution:'),
      'Expected host interruption missing',
    );
  } else {
    assert(result.execution === 'timeout', 'Expected bounded termination missing');
  }
}

export async function assessScenario(
  result: Awaited<ReturnType<typeof sandboxPreflightTrial>>,
  scenario: z.infer<typeof scenarioSchema>,
  dir: string,
  bunVersion: string,
) {
  assert(
    result.safety.containersRemoved && result.safety.networkRemoved,
    'Termination unconfirmed',
  );
  assert(result.launched, result.reason);
  const text = await readFile(resolve(dir, 'actor.stdout'), 'utf8');
  const stderr = await readFile(resolve(dir, 'actor.stderr'), 'utf8');
  assert(
    !/metadata.*fallback|unknown model|model.*not found/i.test(text + '\n' + stderr),
    'Model metadata fallback',
  );
  if (scenario.id === 'interrupt' || scenario.id === 'timeout') {
    await verifyStoppedOperation(result, scenario, dir, bunVersion);
    return;
  }
  const gatewayText = await readFile(resolve(dir, 'gateway.stdout'), 'utf8');
  const gatewayEvents = jsonLines(gatewayText);
  const toolResults = gatewayToolResults(gatewayEvents);
  if (scenario.responseSchema) {
    const first = gatewayEvents.find((event) => event.type === 'preflight.request');
    assert(
      first &&
        isRecord(first.body) &&
        isRecord(first.body.text) &&
        isRecord(first.body.text.format),
      'Repair output format missing',
    );
    assert(first.body.text.format.type === 'json_schema', 'Repair output schema missing');
    assert.deepStrictEqual(
      first.body.text.format.schema,
      scenario.responseSchema,
      'Repair output schema changed',
    );
  }
  assert(result.execution === 'completed', result.reason);
  assertExchange(result.requests, scenario.steps.length, scenario.expectedRejected);
  const actorEvents = jsonLines(text);
  const files = artifactFiles(actorEvents);
  operationRuntime(files, scenario, bunVersion);
  if (['command-failure', 'missing-marker'].includes(scenario.id)) {
    let rejected = false;
    try {
      observedSuccess(actorEvents, toolResults, scenario, files);
    } catch (cause) {
      rejected =
        cause instanceof Error &&
        cause.message ===
          (scenario.id === 'command-failure'
            ? 'Known command failed'
            : 'Expected operation marker missing');
    }
    assert(rejected, 'False success accepted');
  } else {
    observedSuccess(actorEvents, toolResults, scenario, files);
  }
}

function parseScenarios(raw: string) {
  const scenarios = z.array(scenarioSchema).length(7).parse(JSON.parse(raw));
  assert(new Set(scenarios.map((item) => item.id)).size === 7, 'Incomplete preflight scenarios');
  assert(
    scenarios.find((item) => item.id === 'initial')?.responseSchema,
    'Initial scenario requires repair response schema',
  );
  assert(
    scenarios.find((item) => item.id === 'boundaries')?.networkCanary,
    'Boundary canary required',
  );
  for (const item of scenarios) {
    assert(
      item.id === 'boundaries' || !item.networkCanary,
      'Canary is only available to the boundary scenario',
    );
    assert(
      item.runtimeArtifact !== item.artifact && !Object.hasOwn(item.files, item.runtimeArtifact),
      'Runtime observation must be generated by the operation',
    );
  }
  return scenarios;
}

async function preflightScenarios(
  config: EvalConfig,
  plan: Awaited<ReturnType<typeof preparePlan>>,
  directory: string,
  stopped: () => boolean,
) {
  // CONFIGの比較条件は変えず、別の合成入力で固定CLIと境界だけを確認する。
  const raw = await readFile(resolve(import.meta.dir, 'tests/preflight.json'), 'utf8');
  const scenarios = parseScenarios(raw);
  const source = await readFile(preflightGatewayEntrypoint, 'utf8');
  const startedAt = Date.now();
  const expiresAt = startedAt + 1200000;
  const records: unknown[] = [];
  const manifest = {
    identity: compatibilityIdentity(plan),
    modelFree: true,
    config,
    runner: plan.runner,
    runtimeHash: plan.runtimeHash,
    fixtureSha256: createHash('sha256').update(raw).digest('hex'),
    gatewaySha256: createHash('sha256').update(source).digest('hex'),
    scenarioTimeMs: 120000,
    totalTimeMs: 1200000,
    maxRequestsPerScenario: 4,
    retries: 0,
    scenarios: scenarios.map((item) => item.id),
    entryBun: Bun.version,
  };
  console.log(JSON.stringify(manifest));
  await writeFile(resolve(directory, 'preflight-plan.json'), JSON.stringify(manifest, null, 2));
  let error: string | null = null;
  for (const [index, scenario] of scenarios.entries()) {
    if (error) {
      records.push({ scenario: scenario.id, status: 'not-run', reason: error });
      continue;
    }
    const dir = resolve(directory, scenario.id);
    await mkdir(dir);
    const runtime = resolve(dir, 'runtime');
    const input = resolve(dir, 'input');
    await mkdir(runtime);
    await mkdir(input);
    try {
      assert(!stopped(), 'Preflight interrupted before launch');
      for (const [path, body] of Object.entries(scenario.files)) {
        const target = resolve(input, path);
        await mkdir(resolve(target, '..'), { recursive: true });
        await writeFile(target, body);
      }
      await writeFile(resolve(dir, 'host-canary'), 'PUBLIC-SYNTHETIC-NOT-MOUNTED');
      const deadline = Math.min(expiresAt, Date.now() + 120000);
      await writeFile(resolve(runtime, 'container.ts'), plan.runtimeSource);
      await writeFile(resolve(runtime, 'preflight-container.ts'), source);
      await writeFile(resolve(runtime, 'scenario.json'), JSON.stringify(scenario));
      await writeFile(
        resolve(runtime, 'settings.json'),
        JSON.stringify({
          model: config.model,
          reasoning: config.reasoning,
          maxRequests: 4,
          maxOutputTokens: config.maxOutputTokens,
          expiresAt: deadline,
          prompt: scenario.prompt,
          responseSchema: scenario.responseSchema,
          cliVersion: config.cliVersion,
          bunVersion: config.bunVersion,
          gitVersion: config.gitVersion,
          hostCanaryPath: resolve(dir, 'host-canary'),
        }),
      );
      assert(!stopped(), 'Preflight interrupted during preparation');
      const result = ['interrupt', 'timeout'].includes(scenario.id)
        ? await stoppedSession(config, dir, scenario)
        : await withInterrupts(() => sandboxPreflightTrial(config, runtime, input, deadline));
      assert(!stopped(), 'Preflight interrupted');
      await assessScenario(result, scenario, dir, config.bunVersion);
      records.push({ scenario: scenario.id, status: 'passed', result });
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Preflight failed';
      records.push({ scenario: scenario.id, status: 'failed', reason: error });
    }
    if (index < scenarios.length - 1) {
      await writeFile(
        resolve(directory, 'preflight.json'),
        JSON.stringify({ manifest, records, error }, null, 2),
      );
    }
  }
  await writeFile(
    resolve(directory, 'preflight.json'),
    JSON.stringify({ manifest, records, error }, null, 2),
  );
  return { error, records };
}

export async function preflight(
  config: EvalConfig,
  plan: Awaited<ReturnType<typeof preparePlan>>,
  directory: string,
) {
  let stopped = false;
  const interrupt = () => {
    stopped = true;
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    return await preflightScenarios(config, plan, directory, () => stopped);
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
}

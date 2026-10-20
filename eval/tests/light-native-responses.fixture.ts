import assert from 'node:assert/strict';

// #405のモデルなしホスト確認用。サーバー・実CLI・実認証は起動しない。
// ホストは採用したBunの実体を指定し、生成結果・版・hashを証拠へ固定する。
// Docker用preflight.jsonを変更・流用せず、固定操作だけを独立に生成する。
function sse(id: string, input: string) {
  const item = {
    type: 'custom_tool_call',
    id: `ct_${id}`,
    call_id: `call_${id}`,
    name: 'exec',
    namespace: 'functions',
    input,
    status: 'completed',
  };
  const events = [
    { type: 'response.created', response: { id: `resp_${id}`, status: 'in_progress', output: [] } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...item, input: '', status: 'in_progress' },
    },
    {
      type: 'response.custom_tool_call_input.delta',
      item_id: item.id,
      output_index: 0,
      delta: input,
    },
    { type: 'response.custom_tool_call_input.done', item_id: item.id, output_index: 0, input },
    { type: 'response.output_item.done', output_index: 0, item },
    {
      type: 'response.completed',
      response: {
        id: `resp_${id}`,
        status: 'completed',
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

function finalSse(id: string, reply: string) {
  const item = {
    type: 'message',
    id: `msg_${id}`,
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: reply, annotations: [] }],
  };
  const events = [
    {
      type: 'response.created',
      response: { id: `resp_${id}_final`, status: 'in_progress', output: [] },
    },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...item, content: [], status: 'in_progress' },
    },
    {
      type: 'response.content_part.added',
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    },
    {
      type: 'response.output_text.delta',
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: reply,
    },
    {
      type: 'response.output_text.done',
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      text: reply,
    },
    {
      type: 'response.content_part.done',
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part: item.content[0],
    },
    { type: 'response.output_item.done', output_index: 0, item },
    {
      type: 'response.completed',
      response: {
        id: `resp_${id}_final`,
        status: 'completed',
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

// fixtureは許可workspace内へ同一hashで配置し、対象canaryの個別パスはprofileへ加えない。
// 完了応答では裁定しない。ホストは実コマンドの到達・終了・観測を照合する。
export function nativeBoundaryResponses(
  bunExecutable: string,
  fixturePath: string,
  kind: 'read' | 'shell-read' | 'write',
  targetPath: string,
) {
  assert([bunExecutable, fixturePath, targetPath].every((path) => path.startsWith('/')));
  const marker = 'PUBLIC_NATIVE_BOUNDARY_OBSERVATION';
  const cmd = [bunExecutable, fixturePath, kind, targetPath].map(quote).join(' ');
  const input = `let result = await tools.exec_command(${JSON.stringify({ cmd, yield_time_ms: 1000 })});
text({marker: ${JSON.stringify(marker)}, kind: ${JSON.stringify(kind)}, result});
while (result.session_id) {
  result = await tools.write_stdin({session_id: result.session_id, chars: '', yield_time_ms: 1000});
  text({marker: ${JSON.stringify(marker)}, kind: ${JSON.stringify(kind)}, result});
}`;
  return [
    { requestIncludes: ['functions', 'exec'], sse: sse('boundary', input) },
    {
      requestIncludes: [marker],
      sse: finalSse('boundary', '固定境界操作を記録しました。裁定はホストで行います。'),
    },
  ];
}

// 初回宣言には遅延公開ツールが含まれない場合があるため、実行時の一覧を観測する。
// 一覧だけでは境界成立を認定しない。ホストが実ツールとschemaを照合して次のprobeを選ぶ。
export function nativeToolInventoryResponses() {
  const marker = 'PUBLIC_NATIVE_TOOL_INVENTORY';
  const input = `if (!Array.isArray(ALL_TOOLS)) throw new Error('runtime tool inventory unavailable');
text({marker: ${JSON.stringify(marker)}, tools: ALL_TOOLS.map(({name, description}) => ({name, description}))});`;
  return [
    { requestIncludes: ['functions', 'exec'], sse: sse('tool_inventory', input) },
    {
      requestIncludes: [marker],
      sse: finalSse('tool_inventory', '公開ツール一覧を記録しました。境界は未確認です。'),
    },
  ];
}

// nameとargsは、実一覧とschemaを確認したホストが合成canaryだけを指定する。
// ツールが未公開なら停止し、コマンドreadで代用しない。返答・例外とも観測として残す。
export function nativeReadToolResponses(name: string, args: Record<string, unknown>) {
  assert(name.length > 0);
  const marker = 'PUBLIC_NATIVE_READ_TOOL_OBSERVATION';
  const input = `const name = ${JSON.stringify(name)};
if (!ALL_TOOLS.some(tool => tool.name === name) || typeof tools[name] !== 'function') throw new Error('requested read tool unavailable');
try {
  const result = await tools[name](${JSON.stringify(args)});
  text({marker: ${JSON.stringify(marker)}, name, result});
} catch (cause) {
  text({marker: ${JSON.stringify(marker)}, name, error: String(cause)});
}`;
  return [
    { requestIncludes: ['functions', 'exec'], sse: sse('read_tool', input) },
    {
      requestIncludes: [marker],
      sse: finalSse('read_tool', '合成読取り操作を記録しました。裁定はホストで行います。'),
    },
  ];
}

function observedMarker(id: string, marker: string) {
  if (id === 'command-failure') {
    return 'PUBLIC_NATIVE_EXPECTED_EXIT_23';
  }
  if (id === 'timeout') {
    return 'PUBLIC_NATIVE_TIMEOUT_STARTED';
  }
  return id === 'missing-marker' ? 'PUBLIC_NATIVE_MARKER_INTENTIONALLY_ABSENT' : marker;
}

export function nativeFixedResponses(bunExecutable: string, bunVersion: string) {
  assert(bunExecutable.startsWith('/') && bunVersion.length > 0);
  return ['scoping', 'initial', 'command-failure', 'missing-marker', 'timeout', 'interrupt'].map(
    (id) => {
      const stem = `preflight-native-${id}`;
      const marker = `PUBLIC_NATIVE_${id.toUpperCase().replaceAll('-', '_')}_OK`;
      const artifact = `${stem}.txt`;
      const artifactText = `公開されたネイティブ合成成果物 ${id}\n`;
      const runtimeArtifact = `${stem}-runtime.json`;
      const common = `import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,realpathSync} from 'node:fs';
assert.equal(Bun.version,${JSON.stringify(bunVersion)});
assert.equal(realpathSync(process.execPath),realpathSync(${JSON.stringify(bunExecutable)}));
const child=Bun.spawnSync([process.execPath,'-e','console.log(JSON.stringify({version:Bun.version,path:process.execPath}))']);
assert.equal(child.exitCode,0,new TextDecoder().decode(child.stderr));
const childRuntime=JSON.parse(new TextDecoder().decode(child.stdout));
assert.equal(childRuntime.version,Bun.version);assert.equal(realpathSync(childRuntime.path),realpathSync(process.execPath));
writeFileSync(${JSON.stringify(runtimeArtifact)},JSON.stringify({parent:{version:Bun.version,path:process.execPath},child:childRuntime}));
assert.equal(readFileSync('public-input.txt','utf8'),'公開された合成入力\\n');
`;
      const operation =
        id === 'command-failure'
          ? "console.error('PUBLIC_NATIVE_EXPECTED_EXIT_23');process.exit(23);"
          : `writeFileSync('public-input.txt','公開された合成入力の変更\\n');
assert.equal(readFileSync('public-input.txt','utf8'),'公開された合成入力の変更\\n');
writeFileSync(${JSON.stringify(artifact)},${JSON.stringify(artifactText)});
console.log(${JSON.stringify(observedMarker(id, marker))});
${['timeout', 'interrupt'].includes(id) ? "const pending=Bun.spawn(['/bin/sleep','600']);writeFileSync('native-processes.json',JSON.stringify([process.pid,pending.pid]));console.log('PUBLIC_NATIVE_PROCESS_READY');await pending.exited;" : ''}`;
      const input = `let result = await tools.exec_command(${JSON.stringify({ cmd: `${quote(bunExecutable)} -e ${quote(common + operation)}`, yield_time_ms: 1000 })});
text(result);
while (result.session_id) {
  result = await tools.write_stdin({session_id: result.session_id, chars: '', yield_time_ms: 1000});
  text(result);
}`;
      const initial = id === 'initial';
      const reply = initial
        ? JSON.stringify({ status: 'repaired', findings: '公開された固定操作を確認しました。' })
        : '公開された固定操作を確認しました。';
      const followupMarker = observedMarker(id, marker);
      return {
        id,
        prompt: `公開された合成入力を扱う${id}のモデルなし互換性確認です。固定操作だけを行ってください。`,
        steps: [
          { requestIncludes: ['functions', 'exec'], sse: sse(id, input) },
          ...(['timeout', 'interrupt'].includes(id)
            ? []
            : [{ requestIncludes: [followupMarker], sse: finalSse(id, reply) }]),
        ],
        files: { 'public-input.txt': '公開された合成入力\n' },
        marker,
        artifact,
        artifactText,
        runtimeArtifact,
        ...(initial
          ? {
              responseSchema: {
                type: 'object',
                additionalProperties: false,
                required: ['status', 'findings'],
                properties: {
                  status: { type: 'string', enum: ['repaired', 'needs_host', 'needs_human'] },
                  findings: { type: 'string' },
                },
              },
            }
          : {}),
      };
    },
  );
}

// #409: 同名の個人登録があっても固定版の本文を要求・実読取りへ接続する。
export function nativeFixedInputResponses(
  bun: string,
  files: { path: string; sha256: string }[],
  instructions: string,
  requiredInputs: string[] = [],
  structured = false,
) {
  const marker = 'PUBLIC_FIXED_INPUT_HASHES';
  const program = `const {createHash}=require('node:crypto');const {readFileSync}=require('node:fs');console.log(JSON.stringify({marker:${JSON.stringify(marker)},files:${JSON.stringify(files.map((file) => file.path))}.map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')}))}));`;
  const cmd = [bun, '-e', program].map(quote).join(' ');
  const input = `let result = await tools.exec_command(${JSON.stringify({ cmd, yield_time_ms: 1000 })});text(result);while (result.session_id) { result = await tools.write_stdin({session_id: result.session_id, chars: "", yield_time_ms: 1000});text(result); }`;
  return [
    {
      requestIncludes: [
        'functions',
        'exec',
        ...[instructions, ...requiredInputs].map((value) => JSON.stringify(value).slice(1, -1)),
      ],
      sse: sse('fixed_inputs', input),
    },
    {
      requestIncludes: [marker, ...files.map((file) => file.sha256)],
      sse: finalSse(
        'fixed_inputs',
        structured
          ? JSON.stringify({
              status: 'repaired',
              findings: '固定入力の本文hashを記録しました。ホストが要求と照合します。',
            })
          : '固定入力の本文hashを記録しました。ホストが要求と照合します。',
      ),
    },
  ];
}

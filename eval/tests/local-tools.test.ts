import assert from 'node:assert/strict';
import { expect, test } from 'bun:test';
import { providerBody, providerGateway } from '../container.ts';
import { containerArgs } from '../sandbox.ts';
import { localToolsRequest } from './local-tools.fixture.ts';

const limits = {
  model: 'example-model',
  reasoning: 'high',
  maxRequests: 4,
  maxOutputTokens: 8000,
};

// #401: SSEの終了イベント名だけで成功にせず、明示された失敗・未完了も照合する。
// 宣言検査で先に遮られないinline入力を使い、実APIやサーバーを起動しない。
for (const [name, responseBody] of [
  ['completed', { status: 'completed' }],
  ['failed', { status: 'failed' }],
  ['incomplete', { status: 'incomplete' }],
  ['in_progress', { status: 'in_progress' }],
  ['本文欠落', undefined],
  ['null本文', null],
  ['配列本文', []],
  ['文字列本文', 'completed'],
  ['数値本文', 1],
  ['真偽値本文', true],
  ['status欠落', {}],
] as const) {
  test(`SSE終了本文の状態を照合し後続要求を制御する: ${name}`, async () => {
    let sent = 0;
    const gateway = providerGateway(limits, 'SYNTHETIC_KEY', async () => {
      sent++;
      const event = {
        type: 'response.completed',
        response: responseBody,
      };
      return new Response(`data: ${JSON.stringify(event)}\n\n`, {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });
    const request = (input: string) =>
      new Request('http://gateway:8080/v1/responses', {
        method: 'POST',
        body: JSON.stringify({ ...localToolsRequest(), input }),
      });
    try {
      const response = await gateway.handle(request('公開入力1'));
      expect(response.status).toBe(200);
      // 不正なstreamを切断する実装も、転送後に封鎖する実装も許容する。
      // どちらも失敗を記録し、次のprovider要求を送らないことが必要。
      let streamFailed = false;
      try {
        await response.text();
      } catch {
        streamFailed = true;
      }
      const complete = name === 'completed';
      if (complete) {
        expect(streamFailed).toBe(false);
      }
      expect(gateway.stats().failed).toBe(!complete);
      expect((await gateway.handle(request('公開入力2'))).status).toBe(complete ? 200 : 403);
      expect(sent).toBe(complete ? 2 : 1);
    } finally {
      gateway.stop();
    }
  });
}

// additional_toolsの一律拒否に隠れず、旧形式でも同じ契約を守る。
function inlineHistory() {
  const value = localToolsRequest();
  const declaration = value.input[0];
  assert(declaration && 'tools' in declaration && declaration.tools?.[0]);
  return {
    ...value,
    tools: declaration.tools[0].tools,
    input: [
      { type: 'function_call', call_id: 'public-read', name: 'exec_command', arguments: '{}' },
      { type: 'function_call_output', call_id: 'public-read', output: '公開された結果' },
    ],
  };
}

// #401: 新形式だけを厳格化しても、旧形式の宣言から未知制御を転送できてはならない。
// 新形式の一律拒否に隠れない正常対照を、同じ葉の宣言と一緒に検査する。
for (const kind of ['function', 'custom'] as const) {
  for (const field of ['server_url', 'unknown_control']) {
    test(`旧形式の${kind}宣言に隠した${field}を拒否する`, () => {
      const source = localToolsRequest();
      const item = source.input[0];
      assert(item && 'tools' in item && item.tools?.[0]);
      const leaf = item.tools[0].tools.find((tool) => tool.type === kind);
      assert(leaf);
      const normal = { ...source, input: '公開入力', tools: [leaf] };
      expect(providerBody(normal, limits)).toEqual({
        ...normal,
        store: false,
        max_output_tokens: 8000,
      });
      const invalid = {
        ...normal,
        tools: [{ ...leaf, [field]: 'https://example.invalid/remote' }],
      };
      expect(() => providerBody(invalid, limits)).toThrow();
    });
  }
}

// #401の呼出し・結果の対応は、完了後も要求全体で一意に保つ。
// 既存のduplicate-callは結果前の重複だけなので、完了後の再使用を別に守る。
for (const namespaced of [false, true]) {
  for (const [firstKind, secondKind] of [
    ['function', 'function'],
    ['function', 'custom'],
    ['custom', 'function'],
    ['custom', 'custom'],
  ] as const) {
    test(`${namespaced ? '新' : '旧'}形式で完了済みcall_idの${firstKind}から${secondKind}への再使用を拒否する`, () => {
      const declaration = localToolsRequest();
      const inline = inlineHistory();
      const history = (secondId: string) => {
        const scope = namespaced ? { namespace: 'functions' } : {};
        const items = [
          {
            call_id: 'completed-call',
            ...scope,
            ...(firstKind === 'function'
              ? { type: 'function_call', name: 'exec_command', arguments: '{}' }
              : { type: 'custom_tool_call', name: 'exec', input: 'text("公開入力");' }),
          },
          {
            type: firstKind === 'function' ? 'function_call_output' : 'custom_tool_call_output',
            call_id: 'completed-call',
            output: '公開結果1',
          },
          {
            call_id: secondId,
            ...scope,
            ...(secondKind === 'function'
              ? { type: 'function_call', name: 'exec_command', arguments: '{}' }
              : { type: 'custom_tool_call', name: 'exec', input: 'text("公開入力");' }),
          },
          {
            type: secondKind === 'function' ? 'function_call_output' : 'custom_tool_call_output',
            call_id: secondId,
            output: '公開結果2',
          },
        ];
        return namespaced
          ? { ...declaration, input: [...declaration.input, ...items] }
          : { ...inline, input: items };
      };
      const normal = history('distinct-call');
      expect(providerBody(normal, limits)).toEqual({
        ...normal,
        store: false,
        max_output_tokens: 8000,
      });
      expect(() => providerBody(history('completed-call'), limits)).toThrow();
    });
  }
}

for (const [name, change] of [
  ['未知フィールド', { unknown_control: true }],
  ['保存prompt', { prompt: { id: 'stored-prompt' } }],
  ['保存conversation', { conversation: 'stored-conversation' }],
  ['前の応答', { previous_response_id: 'stored-response' }],
  ['背景実行', { background: true }],
] as const) {
  test(`正常な旧形式を対照に要求制御を拒否する: ${name}`, () => {
    const normal = inlineHistory();
    expect(providerBody(normal, limits)).toEqual({
      ...normal,
      store: false,
      max_output_tokens: 8000,
    });
    expect(() => providerBody({ ...normal, ...change }, limits)).toThrow();
  });
}

for (const mismatch of ['orphan', 'wrong-kind', 'duplicate-call', 'duplicate-result']) {
  test(`旧形式でも呼出しと結果の対応を検査する: ${mismatch}`, () => {
    const normal = inlineHistory();
    expect(providerBody(normal, limits)).toEqual({
      ...normal,
      store: false,
      max_output_tokens: 8000,
    });
    const invalid = structuredClone(normal);
    const [call, output] = invalid.input;
    assert(call && output);
    if (mismatch === 'orphan') {
      output.call_id = 'unknown-call';
    }
    if (mismatch === 'wrong-kind') {
      output.type = 'custom_tool_call_output';
    }
    if (mismatch === 'duplicate-call') {
      invalid.input.unshift({ ...call });
    }
    if (mismatch === 'duplicate-result') {
      invalid.input.push({ ...output });
    }
    expect(() => providerBody(invalid, limits)).toThrow();
  });
}

// #401: 完了した履歴として転送する呼出しには対応する結果が必要。
// 孤立した結果の拒否だけでは、結果を失った要求の受入を検出できない。
for (const kind of ['function', 'custom'] as const) {
  test(`旧形式の${kind}履歴で結果欠落を拒否する`, () => {
    const value = inlineHistory();
    const normal = {
      ...value,
      input: [
        {
          call_id: 'public-complete',
          ...(kind === 'function'
            ? { type: 'function_call', name: 'exec_command', arguments: '{}' }
            : { type: 'custom_tool_call', name: 'exec', input: 'text("public");' }),
        },
        {
          type: kind === 'function' ? 'function_call_output' : 'custom_tool_call_output',
          call_id: 'public-complete',
          output: '公開結果',
        },
      ],
    };
    expect(providerBody(normal, limits)).toEqual({
      ...normal,
      store: false,
      max_output_tokens: 8000,
    });
    expect(() => providerBody({ ...normal, input: normal.input.slice(0, 1) }, limits)).toThrow();
  });
}

for (const [name, item] of [
  [
    '履歴内の未知制御',
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '公開入力' }],
      configuration_update: { model: 'other' },
    },
  ],
  [
    'URL入力',
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_file', file_url: 'https://example.invalid/file' }],
    },
  ],
  [
    '深いstored reference',
    {
      type: 'function_call_output',
      call_id: 'read',
      output: [{ type: 'input_file', file_id: 'stored' }],
    },
  ],
] as const) {
  test(`inline履歴の外部参照・未知制御を拒否する: ${name}`, () => {
    const input = [
      ...(item.type === 'function_call_output'
        ? [{ type: 'function_call', call_id: 'read', name: 'exec_command', arguments: '{}' }]
        : []),
      item,
    ];
    expect(() => providerBody({ ...localToolsRequest(), input }, limits)).toThrow();
  });
}

test('中継はmethod・query・path・同一要求再送を拒否しactorのheaderを転送しない', async () => {
  const sent: RequestInit[] = [];
  const gateway = providerGateway(limits, 'GATEWAY_ONLY_KEY', async (url, init) => {
    expect(url).toBe('https://api.openai.com/v1/responses');
    sent.push(init);
    return new Response(
      'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
      {
        headers: { 'Content-Type': 'text/event-stream' },
      },
    );
  });
  const value = { ...localToolsRequest(), input: '公開入力' };
  const request = (path = '/v1/responses', method = 'POST') =>
    new Request(`http://gateway:8080${path}`, {
      method,
      ...(method === 'GET' ? {} : { body: JSON.stringify(value) }),
      headers: {
        Authorization: 'Bearer ACTOR_CANARY',
        'X-Forwarded-Host': 'example.invalid',
        'OpenAI-Project': 'actor-project',
      },
    });
  try {
    for (const [path, method] of [
      ['/v1/responses', 'GET'],
      ['/v1/responses', 'PUT'],
      ['/v1/responses?url=https://example.invalid', 'POST'],
      ['/v1/responses/extra', 'POST'],
    ]) {
      assert(path && method);
      expect((await gateway.handle(request(path, method))).status).toBe(403);
    }
    expect(sent).toHaveLength(0);
    const normal = await gateway.handle(request());
    expect(normal.status).toBe(200);
    await normal.text();
    expect((await gateway.handle(request())).status).toBe(403);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.redirect).toBe('error');
    const headers = new Headers(sent[0]?.headers);
    expect(headers.get('Authorization')).toBe('Bearer GATEWAY_ONLY_KEY');
    expect(headers.get('X-Forwarded-Host')).toBeNull();
    expect(headers.get('OpenAI-Project')).toBeNull();
  } finally {
    gateway.stop();
  }
});

test('旧inline正常対照はURLを含むコードとローカル呼出し結果を保持する', () => {
  const value = {
    ...localToolsRequest(),
    input: [
      {
        type: 'function_call',
        call_id: 'read',
        name: 'exec_command',
        arguments: '{"cmd":"echo https://example.invalid"}',
      },
      { type: 'function_call_output', call_id: 'read', output: 'https://example.invalid' },
      {
        type: 'custom_tool_call',
        call_id: 'code',
        name: 'exec',
        input: 'const tools = {server_url: "https://example.invalid"};',
      },
      { type: 'custom_tool_call_output', call_id: 'code', output: '公開された結果' },
    ],
  };
  expect(providerBody(value, limits)).toEqual({ ...value, store: false, max_output_tokens: 8000 });
});

test('新形式のnamespace・Schema・grammarを削除や平坦化せず固定上限で転送する', async () => {
  const value = { ...localToolsRequest(), store: true, max_output_tokens: 99999 };
  let sent: unknown;
  const gateway = providerGateway(limits, 'SYNTHETIC_KEY', async (_url, init) => {
    assert(typeof init.body === 'string');
    sent = JSON.parse(init.body);
    return new Response(
      'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
      {
        headers: { 'Content-Type': 'text/event-stream' },
      },
    );
  });
  try {
    const response = await gateway.handle(
      new Request('http://gateway:8080/v1/responses', {
        method: 'POST',
        body: JSON.stringify(value),
      }),
    );
    expect(response.status).toBe(200);
    await response.text();
    expect(sent).toEqual({ ...value, store: false, max_output_tokens: 8000 });
  } finally {
    gateway.stop();
  }
});

// 宣言の受入とは別にmetadataの検査へ到達させる。
// #401の採用CLI互換性と、ホスト提示の限定7キーの接続契約に対応する。
const cliMetadata = {
  'x-codex-installation-id': 'public-installation',
  'x-codex-turn-metadata': 'public-turn-metadata',
  turn_id: 'public-turn',
  'x-codex-window-id': 'public-window',
  session_id: 'public-session',
  root_turn_id: 'public-root-turn',
  thread_id: 'public-thread',
};

test('採用CLIで観測された要求項目を持つ合成のローカル要求を保持する', () => {
  // ホスト証拠6e3096b5の項目名を照合する。値は公開の合成値であり、
  // 採取要求の再現や、未知の制御値全般の許可を意味しない。
  const value = {
    ...localToolsRequest(),
    stream: true,
    tool_choice: 'auto',
    parallel_tool_calls: true,
    reasoning: { effort: limits.reasoning, context: 'all_turns' },
    store: false,
    include: [],
    prompt_cache_key: 'public-cache-key',
    text: { format: { type: 'text' } },
    client_metadata: cliMetadata,
  };
  const inline = { ...value, input: '公開入力' };
  expect(providerBody(inline, limits)).toEqual({ ...inline, max_output_tokens: 8000 });
  expect(providerBody(value, limits)).toEqual({ ...value, max_output_tokens: 8000 });
});

test('採用CLIの限定metadataとreasoning.contextを保持する', () => {
  const value = {
    ...localToolsRequest(),
    reasoning: { effort: limits.reasoning, context: 'all_turns' },
    client_metadata: cliMetadata,
  };
  expect(providerBody(value, limits)).toEqual({ ...value, store: false, max_output_tokens: 8000 });
});

test('旧inline正常対照でも限定metadataとcontextを削除せず保持する', () => {
  for (const reasoning of [
    { effort: limits.reasoning },
    { effort: limits.reasoning, context: 'all_turns' },
  ]) {
    const value = {
      ...localToolsRequest(),
      input: '公開入力',
      reasoning,
      client_metadata: cliMetadata,
    };
    expect(providerBody(value, limits)).toEqual({
      ...value,
      store: false,
      max_output_tokens: 8000,
    });
  }
});

for (const [name, change] of [
  ['未知metadata', { client_metadata: { ...cliMetadata, server_url: 'https://example.invalid' } }],
  ...Object.keys(cliMetadata).map(
    (key) => [`metadataの型: ${key}`, { client_metadata: { ...cliMetadata, [key]: 123 } }] as const,
  ),
  ['metadataが配列', { client_metadata: [] }],
  ['metadataがnull', { client_metadata: null }],
  ['未知context', { reasoning: { effort: limits.reasoning, context: 'unknown' } }],
  ['contextの型', { reasoning: { effort: limits.reasoning, context: 123 } }],
  ['未知reasoning制御', { reasoning: { effort: limits.reasoning, unknown_control: true } }],
] as const) {
  test(`正常なinline入力で採用CLIの未知制御を拒否する: ${name}`, () => {
    const value = {
      ...localToolsRequest(),
      input: '公開入力',
      reasoning: { effort: limits.reasoning, context: 'all_turns' },
      client_metadata: cliMetadata,
    };
    expect(() => providerBody({ ...value, ...change }, limits)).toThrow();
  });
}

test('namespace付きのローカル呼出し・結果を対応させ、未知の呼出し先を拒否する', () => {
  const declaration = localToolsRequest();
  const call = {
    type: 'custom_tool_call',
    call_id: 'public-call',
    namespace: 'functions',
    name: 'exec',
    input: 'text(await tools.exec_command({cmd: "echo public"}));',
  };
  const value = {
    ...declaration,
    input: [
      ...declaration.input,
      call,
      { type: 'custom_tool_call_output', call_id: 'public-call', output: 'public' },
    ],
  };
  expect(providerBody(value, limits)).toEqual({ ...value, store: false, max_output_tokens: 8000 });
  for (const change of [{ namespace: 'unknown' }, { name: 'unknown' }]) {
    expect(() =>
      providerBody(
        {
          ...value,
          input: value.input.map((item) => (item === call ? { ...call, ...change } : item)),
        },
        limits,
      ),
    ).toThrow();
  }
});

// #401の呼出し先対応は宣言位置によって迂回できてはいけない。
for (const invalidName of ['undeclared', 'exec_command']) {
  test(`旧形式の宣言がある履歴でも不正なcustom呼出し先を拒否する: ${invalidName}`, () => {
    const value = localToolsRequest();
    const declaration = value.input[0];
    assert(declaration && 'tools' in declaration && declaration.tools);
    const namespace = declaration.tools[0];
    assert(namespace);
    const request = (name: string) => ({
      ...value,
      tools: namespace.tools,
      input: [
        { type: 'custom_tool_call', call_id: 'public-inline', name, input: 'text("public");' },
        { type: 'custom_tool_call_output', call_id: 'public-inline', output: 'public' },
      ],
    });
    const normal = request('exec');
    expect(providerBody(normal, limits)).toEqual({
      ...normal,
      store: false,
      max_output_tokens: 8000,
    });
    expect(() => providerBody(request(invalidName), limits)).toThrow();
  });
}

for (const declarationFirst of [true, false]) {
  test(`宣言が${declarationFirst ? '前' : '後'}でも宛先と宣言の型を照合する`, () => {
    const value = localToolsRequest();
    const history = (name: string, type: string) => {
      const call = {
        type,
        call_id: 'public-order-call',
        namespace: 'functions',
        name,
        ...(type === 'function_call' ? { arguments: '{}' } : { input: 'text("public");' }),
      };
      const items = [
        call,
        {
          type: type === 'function_call' ? 'function_call_output' : 'custom_tool_call_output',
          call_id: 'public-order-call',
          output: 'public',
        },
      ];
      return {
        ...value,
        input: declarationFirst ? [...value.input, ...items] : [...items, ...value.input],
      };
    };
    for (const [name, type] of [
      ['exec', 'custom_tool_call'],
      ['exec_command', 'function_call'],
    ] as const) {
      const normal = history(name, type);
      expect(providerBody(normal, limits)).toEqual({
        ...normal,
        store: false,
        max_output_tokens: 8000,
      });
    }
    for (const [name, type] of [
      ['undeclared', 'custom_tool_call'],
      ['exec_command', 'custom_tool_call'],
      ['exec', 'function_call'],
    ] as const) {
      expect(() => providerBody(history(name, type), limits)).toThrow();
    }
  });
}

test('Schemaのdependenciesのプロパティ名配列とデータは外部参照にしない', () => {
  const value = withDeclaration((_item, _namespace, leaves) => {
    assert(leaves[0]);
    leaves[0].parameters = {
      type: 'object',
      properties: { cmd: { type: 'string' }, $ref: { type: 'string' } },
      dependencies: {
        cmd: ['$ref', 'tools', 'file_url'],
        $ref: { properties: { server_url: { const: 'https://example.invalid/data' } } },
      },
      const: { $ref: 'https://example.invalid/data', tools: ['public'] },
    };
  });
  expect(providerBody(value, limits)).toEqual({ ...value, store: false, max_output_tokens: 8000 });
});

for (const reference of ['$ref', '$dynamicRef', '$recursiveRef']) {
  for (const additional of [false, true]) {
    test(`${additional ? '新' : '旧'}形式でSchemaのdependencies内の外部${reference}を拒否する`, () => {
      const schema = (external: boolean) => {
        const value = withDeclaration((_item, _namespace, leaves) => {
          assert(leaves[0]);
          leaves[0].parameters = {
            type: 'object',
            dependencies: {
              cmd: {
                allOf: [
                  external ? { [reference]: 'https://example.invalid/schema' } : { type: 'object' },
                ],
              },
            },
          };
        });
        if (additional) {
          return value;
        }
        const declaration = value.input[0];
        assert(declaration && 'tools' in declaration && declaration.tools);
        const namespace = declaration.tools[0];
        assert(namespace);
        return { ...value, tools: namespace.tools, input: '公開入力' };
      };
      const normal = schema(false);
      expect(providerBody(normal, limits)).toEqual({
        ...normal,
        store: false,
        max_output_tokens: 8000,
      });
      expect(() => providerBody(schema(true), limits)).toThrow();
    });
  }
}

// 変異はすべて同じ正常宣言を起点とする。新形式の一律拒否だけでも
// 反例は通るため、上の正常対照が通るまでは個別の拒否能力を確認済みにしない。
function withDeclaration(
  change: (
    item: Record<string, unknown>,
    namespace: Record<string, unknown>,
    leaves: Record<string, unknown>[],
  ) => void,
) {
  const value = localToolsRequest();
  const item = value.input[0];
  assert(item && 'tools' in item && item.tools);
  const namespace = item.tools[0];
  assert(namespace);
  change(item, namespace, namespace.tools);
  return value;
}

const invalidDeclarations: [string, () => unknown][] = [
  [
    'roleの変更',
    () =>
      withDeclaration((item) => {
        item.role = 'user';
      }),
  ],
  [
    '識別子の型',
    () =>
      withDeclaration((item) => {
        item.id = 17;
      }),
  ],
  [
    '未知制御',
    () =>
      withDeclaration((item) => {
        item.previous_response_id = 'stored';
      }),
  ],
  [
    '設定の上書き',
    () =>
      withDeclaration((item) => {
        item.model = 'other-model';
      }),
  ],
  [
    'namespaceの未知フィールド',
    () =>
      withDeclaration((_item, namespace) => {
        namespace.discovery = true;
      }),
  ],
  [
    '宣言の未知フィールド',
    () =>
      withDeclaration((_item, _namespace, leaves) => {
        assert(leaves[0]);
        leaves[0].server_url = 'https://example.invalid/mcp';
      }),
  ],
  [
    '名前の欠落',
    () =>
      withDeclaration((_item, namespace) => {
        delete namespace.name;
      }),
  ],
  [
    '宣言の重複',
    () =>
      withDeclaration((_item, _namespace, leaves) => {
        assert(leaves[0]);
        leaves.push(structuredClone(leaves[0]));
      }),
  ],
  [
    'functionとcustomの名前衝突',
    () =>
      withDeclaration((_item, _namespace, leaves) => {
        assert(leaves[0] && leaves[1]);
        leaves[1].name = leaves[0].name;
      }),
  ],
  [
    'strictの型',
    () =>
      withDeclaration((_item, _namespace, leaves) => {
        assert(leaves[0]);
        leaves[0].strict = 'false';
      }),
  ],
  [
    'parametersの型',
    () =>
      withDeclaration((_item, _namespace, leaves) => {
        assert(leaves[0]);
        leaves[0].parameters = 'object';
      }),
  ],
  [
    '外部grammar',
    () =>
      withDeclaration((_item, _namespace, leaves) => {
        assert(leaves[1]);
        leaves[1].format = {
          type: 'grammar',
          syntax: 'lark',
          url: 'https://example.invalid/grammar',
        };
      }),
  ],
];

for (const kind of ['web_search', 'file_search', 'shell', 'code_interpreter', 'mcp']) {
  invalidDeclarations.push([
    `namespace内の${kind}`,
    () =>
      withDeclaration((_item, _namespace, leaves) => {
        leaves.push({ type: kind, name: 'remote_public' });
      }),
  ]);
}

for (const [name, make] of invalidDeclarations) {
  test(`新形式の不正宣言を拒否する: ${name}`, () => {
    expect(() => providerBody(make(), limits)).toThrow();
  });
}

for (const kind of ['web_search', 'file_search', 'shell', 'code_interpreter', 'mcp']) {
  test(`旧形式でも${kind}を許可しない`, () => {
    const normal = {
      ...localToolsRequest(),
      input: '公開入力',
      tools: [
        {
          type: 'function',
          name: 'remote_public',
          description: '公開されたローカル操作',
          strict: false,
          parameters: { type: 'object' },
        },
      ],
    };
    expect(providerBody(normal, limits)).toEqual({
      ...normal,
      store: false,
      max_output_tokens: 8000,
    });
    expect(() =>
      providerBody(
        {
          ...localToolsRequest(),
          input: '公開入力',
          tools: [{ type: kind, name: 'remote_public' }],
        },
        limits,
      ),
    ).toThrow();
  });
}

for (const role of ['gateway', 'probe', 'actor']) {
  test(`${role}のログ圧縮を無効にし10m・1ファイルと外側の制限を維持する`, () => {
    const args = containerArgs(
      'test',
      `public@sha256:${'a'.repeat(64)}`,
      'isolated',
      '/tmp/runtime',
      role,
      role === 'gateway' ? undefined : '/tmp/input',
    );
    const values = (flag: string) =>
      args.flatMap((value, index) => (value === flag ? [args[index + 1]] : []));
    expect(values('--log-driver')).toEqual(['local']);
    expect(values('--log-opt')).toHaveLength(3);
    expect(new Set(values('--log-opt'))).toEqual(
      new Set(['compress=false', 'max-file=1', 'max-size=10m']),
    );
    expect(values('--user')).toEqual(['1000:1000']);
    expect(values('--memory')).toEqual(['2g']);
    expect(values('--cpus')).toEqual(['2']);
    expect(values('--pids-limit')).toEqual(['64']);
    expect(values('--cap-drop')).toEqual(['ALL']);
    expect(values('--security-opt')).toEqual(['no-new-privileges']);
    expect(values('--tmpfs')).toEqual([
      '/work:rw,nosuid,nodev,size=268435456,uid=1000,gid=1000',
      '/tmp:rw,nosuid,nodev,size=67108864,uid=1000,gid=1000',
    ]);
    expect(args).toContain('--read-only');
    expect(args).not.toContain('--privileged');
    expect(args).not.toContain('--cap-add');
  });
}

for (const role of ['probe', 'actor']) {
  test(`${role}のDNS上流を自身のloopbackへ固定する`, () => {
    const args = containerArgs(
      'test',
      `public@sha256:${'a'.repeat(64)}`,
      'isolated',
      '/tmp/runtime',
      role,
      '/tmp/input',
    );
    expect(args.flatMap((value, index) => (value === '--dns' ? [args[index + 1]] : []))).toEqual([
      '127.0.0.1',
    ]);
  });
}

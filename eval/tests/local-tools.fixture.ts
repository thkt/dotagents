// #401の合意済み構造から作る合成入力。実CLIの採取原本ではない。
// 説明文のURLとSchemaのプロパティ名は外部参照として解釈しない。
export function localToolsRequest() {
  return {
    model: 'example-model',
    reasoning: { effort: 'high' },
    tools: [],
    input: [
      {
        type: 'additional_tools',
        id: 'tools_public',
        role: 'developer',
        tools: [
          {
            type: 'namespace',
            name: 'functions',
            description: '公開資料 https://example.invalid/ のローカル操作',
            tools: [
              {
                type: 'function',
                name: 'exec_command',
                description: 'ローカルのコマンドを実行する',
                strict: false,
                parameters: {
                  type: 'object',
                  properties: {
                    cmd: { type: 'string' },
                    tools: { type: 'string' },
                    file_url: { type: 'string' },
                    server_url: { type: 'string' },
                  },
                  required: ['cmd'],
                  additionalProperties: false,
                },
              },
              {
                type: 'custom',
                name: 'exec',
                description: 'ローカルのコードを実行する',
                format: {
                  type: 'grammar',
                  syntax: 'lark',
                  definition: 'start: CODE\nCODE: /[\\s\\S]+/',
                },
              },
            ],
          },
        ],
      },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '公開されたREADMEを確認してください。' }],
      },
    ],
  };
}

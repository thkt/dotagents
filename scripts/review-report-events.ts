import { validatedJsonMembers } from './review-report-json.ts';
import { isRecord } from './values.ts';

export interface LogEvent {
  line: number;
  raw: string;
  type: string;
  operation: string;
  outputBytes?: number;
  inputJson?: string;
  outputJson?: string;
  errorJson?: string;
  reference?: { source: string; tool: string };
  result: string;
  timestamp?: string;
  itemId?: string;
  itemType?: string;
  relatedLine?: number;
  problems: string[];
}

const lifecycle: Record<string, string> = {
  'thread.started': 'スレッド開始',
  'turn.started': 'ターン開始',
  'turn.completed': 'ターン完了',
  'turn.failed': 'ターン失敗',
  error: 'エラー',
};
const items: Record<string, string> = {
  command_execution: 'コマンド実行',
  mcp_tool_call: 'MCPツール',
  agent_message: 'モデルの応答',
  reasoning: 'モデルの推論記録',
  file_change: 'ファイル変更',
  web_search: '検索',
  todo_list: '作業一覧',
};

function itemValues(
  row: LogEvent,
  item: Record<string, unknown>,
  source: Map<string, string | undefined>,
) {
  const inputKey: Record<string, string> = {
    command_execution: 'command',
    mcp_tool_call: 'arguments',
    web_search: 'query',
  };
  const key =
    typeof item.type === 'string' && Object.hasOwn(inputKey, item.type)
      ? inputKey[item.type]
      : undefined;
  row.inputJson = key ? source.get(key) : undefined;
  const outputKeys =
    item.type === 'command_execution'
      ? ['aggregated_output']
      : item.type === 'mcp_tool_call'
        ? ['result']
        : ['text', 'changes', 'items'];
  row.outputJson = outputKeys.map((name) => source.get(name)).find((value) => value !== undefined);
  row.errorJson = item.type === 'mcp_tool_call' ? source.get('error') : undefined;
  row.reference = referenceRead(source);

  if (item.type === 'mcp_tool_call') {
    row.operation += `: ${typeof item.server === 'string' ? item.server : '未記録・形式未確認'} / ${typeof item.tool === 'string' ? item.tool : '未記録・形式未確認'}`;
  }
}

function describeItem(
  row: LogEvent,
  item: Record<string, unknown>,
  source: Map<string, string | undefined>,
) {
  row.itemId = typeof item.id === 'string' && item.id ? item.id : undefined;
  row.itemType = typeof item.type === 'string' ? item.type : undefined;
  row.operation =
    row.itemType && Object.hasOwn(items, row.itemType)
      ? (items[row.itemType] ?? '未対応の項目')
      : '未対応の項目';
  if (!row.itemType || !Object.hasOwn(items, row.itemType)) {
    row.problems.push('未対応の項目・表示内容は未確認');
  }
  itemValues(row, item, source);
  row.result =
    {
      'item.started': '開始',
      'item.updated': '更新（結果未確認）',
      'item.completed': '完了イベント',
    }[row.type] ?? '未対応イベント（結果未確認）';
  if (
    row.type === 'item.completed' &&
    typeof item.status !== 'string' &&
    typeof item.exit_code !== 'number'
  ) {
    row.result += '（成否未確認）';
  }
  if (typeof item.status === 'string') {
    const status: Record<string, string> = {
      in_progress: '実行中',
      completed: '完了',
      failed: '失敗',
      interrupted: '中断',
    };
    row.result += ` / ${Object.hasOwn(status, item.status) ? status[item.status] : `未対応の状態: ${item.status}`}`;
  }
  if (typeof item.exit_code === 'number') {
    row.result += ` / 終了コード ${item.exit_code}`;
  }
}

function describeEvent(value: unknown, line: number, raw: string): LogEvent {
  const row: LogEvent = {
    line,
    raw,
    type: '',
    operation: '未対応イベント',
    result: '未確認',
    problems: [],
  };
  if (!isRecord(value) || typeof value.type !== 'string') {
    row.problems.push('イベント形式が不正・表示内容は未確認');
    return row;
  }
  row.type = value.type;
  row.timestamp = typeof value.timestamp === 'string' ? value.timestamp : undefined;
  const members = validatedJsonMembers(raw);
  const item = isRecord(value.item) ? value.item : {};
  if (['item.started', 'item.updated', 'item.completed'].includes(row.type)) {
    describeItem(row, item, validatedJsonMembers(members.get('item')));
  } else if (Object.hasOwn(lifecycle, row.type)) {
    row.operation = lifecycle[row.type] ?? row.type;
    row.result = row.operation;
    row.outputJson = ['error', 'message', 'usage']
      .map((key) => members.get(key))
      .find((entry) => entry !== undefined);
  } else {
    row.problems.push('未対応イベント・表示内容は未確認');
  }
  const outputJson = row.outputJson ?? row.errorJson;
  const output: unknown = outputJson?.startsWith('"') ? JSON.parse(outputJson) : undefined;
  row.outputBytes = typeof output === 'string' ? Buffer.byteLength(output, 'utf8') : undefined;
  inspectEvent(row, item);
  return row;
}

function inspectEvent(row: LogEvent, item: Record<string, unknown>) {
  if (
    row.type === 'error' ||
    row.type.endsWith('.failed') ||
    item.status === 'failed' ||
    (item.error !== null && item.error !== undefined) ||
    (isRecord(item.result) && item.result.isError === true) ||
    (typeof item.exit_code === 'number' && item.exit_code !== 0)
  ) {
    row.problems.push('失敗の記録（原因・品質への影響は未確認）');
  }
  if (item.status === 'interrupted') {
    row.problems.push('中断の記録（結果は原文で確認）');
  }
  if (
    ['mcp_tool_call', 'command_execution'].includes(row.itemType ?? '') &&
    row.type === 'item.completed' &&
    !hasRecordedOutput(row)
  ) {
    row.problems.push('応答欠落・結果は未確認');
  }
}

export function hasRecordedOutput(row: LogEvent): boolean {
  return [row.outputJson, row.errorJson].some((value) => value !== undefined && value !== 'null');
}

function stringMember(members: Map<string, string | undefined>, key: string) {
  const member = members.get(key);
  const value: unknown = member === undefined ? undefined : JSON.parse(member);
  return typeof value === 'string' && value.trim() ? value : undefined;
}

// Only named, explicit read tools. Shell commands, searches and model claims are
// not proof of a read; ambiguous duplicate members do not supply a target.
function referenceRead(members: Map<string, string | undefined>): LogEvent['reference'] {
  if (stringMember(members, 'type') !== 'mcp_tool_call') {
    return;
  }
  const tool = stringMember(members, 'tool');
  const args = validatedJsonMembers(members.get('arguments'));
  let source: string | undefined;
  if (tool && ['read_source', 'read_file', 'read_text_file'].includes(tool)) {
    source = readPath(args);
  } else if (tool && ['read_url', 'fetch_url', 'web_fetch'].includes(tool)) {
    const url = stringMember(args, 'url');
    source = url && /^https?:\/\//i.test(url) ? url : undefined;
  }
  return source && tool
    ? { source, tool: `${stringMember(members, 'server') ?? '提供元未記録'} / ${tool}` }
    : undefined;
}

function readPath(args: Map<string, string | undefined>) {
  const path = stringMember(args, 'path');
  const file = stringMember(args, 'file_path');
  if ((args.has('path') && !path) || (args.has('file_path') && !file)) {
    return;
  }
  return path && file && path !== file ? undefined : (path ?? file);
}

// Retain every row, including updates and failures. Only link unambiguous IDs in this file.
function relateItems(rows: LogEvent[]) {
  const unconfirmed = '完了との対応は未確認（ID欠落・重複・不一致、または未完）';
  const groups = new Map<string, LogEvent[]>();
  for (const row of rows) {
    if (row.itemId) {
      const group = groups.get(row.itemId) ?? [];
      group.push(row);
      groups.set(row.itemId, group);
    } else if (row.type === 'item.started') {
      row.problems.push(unconfirmed);
    }
  }
  for (const group of groups.values()) {
    const starts = group.filter((entry) => entry.type === 'item.started');
    const ends = group.filter((entry) => entry.type === 'item.completed');
    const end = ends[0];
    for (const row of starts) {
      if (
        starts.length === 1 &&
        ends.length === 1 &&
        end &&
        end.line > row.line &&
        row.itemType &&
        end.itemType === row.itemType
      ) {
        row.relatedLine = end.line;
        end.relatedLine = row.line;
      } else {
        row.problems.push(unconfirmed);
      }
    }
  }
}

export function parseLogEvents(text: string): LogEvent[] {
  const rows: LogEvent[] = [];
  for (const [index, raw] of text.split('\n').entries()) {
    if (!raw.trim()) {
      continue;
    }
    try {
      const value: unknown = JSON.parse(raw);
      rows.push(describeEvent(value, index + 1, raw));
    } catch {
      rows.push({
        line: index + 1,
        raw,
        type: '',
        operation: '不正・未完の行',
        result: '未確認',
        problems: ['JSONL不正・未完の記録'],
      });
    }
  }
  relateItems(rows);
  return rows;
}

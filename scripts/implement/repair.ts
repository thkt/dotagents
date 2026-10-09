// Invalid replies retain string findings unchanged for the correction failure record.
export function parseRepairReply(
  stdout: string,
):
  | { status: 'repaired' | 'needs_human' | 'needs_host'; findings: string }
  | { status: 'invalid'; findings?: string } {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return { status: 'invalid' };
  }
  if (typeof value !== 'object' || value === null) {
    return { status: 'invalid' };
  }
  if (!('status' in value) || typeof value.status !== 'string') {
    return { status: 'invalid' };
  }
  if (!('findings' in value) || typeof value.findings !== 'string') {
    return { status: 'invalid' };
  }
  const status =
    value.status === 'repaired' ||
    ((value.status === 'needs_human' || value.status === 'needs_host') &&
      value.findings.trim().length > 0)
      ? value.status
      : 'invalid';
  return { status, findings: value.findings };
}

// Callers keep their task, targeted-check purpose and escalation conditions explicit.
export function repairInstructions(capture: { destination: string } | null) {
  return [
    'テストの作成・更新はホストが用意する独立した別セッションの担当です。この実装・修正セッションでテスト・fixture・検証接続定義を変更しないでください。独立テストの期待値を通すために緩めず、不一致はIssueへ照合してください。テストの不足・誤りや機械的な接続修正もfindingsへ具体的に記し、次の別セッションへ戻してください。要求・範囲の変更は人へ戻してください。独立テストの実行と実装後の成功・必要な正常動作の確認は担当できます。',
    '対象にテスト方針があれば適用してください。影響するテストについて、防ぐ現実的な不具合と既存検証に加わる保証を特定し、実行時間・不安定さ・保守費用と比較してください。十分な価値がないテストは削除・統合の案と理由をfindingsへ記し、実際の変更は独立した別のテストセッションへ戻してください。安心感・件数・カバレッジ指標だけを理由に維持を提案しないでください。findingsには、その不具合、テストを追加・維持・統合・削除する理由、失う検出条件、残る検証と未確認の限界を説明してください。テストごとの台帳は作らないでください。テスト整理では、実装・テスト・文書・実行時間を同じ条件で比較し、行の圧縮やファイル移動を改善に数えたり、未測定の効果を主張したりしないでください。',
    'UIを実装・変更した場合は、対象画面の主要な表示状態を対応幅の範囲で1px刻みに幅掃引してください。中間幅の検証の必要性を判断して省略しないでください。同じ画面・状態・対象版・条件を検証する既存の幅掃引結果は使えます。信頼するimplementスキルのreferences/testing.md「UI変更時の幅掃引」で、対象repoの実行方法、ページ全体の失敗と要素候補の区別、結果の記録とホストへの引き継ぎを確認してください。候補は実画面で確認し、不具合は修正して再検証してください。実行待ち・実行不能・未実行を検証完了と扱わず、状態・幅・候補・対象版・条件・未確認事項と証拠の参照をfindingsへ残し、同じ差分の独立評価へ渡してください。',
    '文書だけの変更にも付随する更新にも、対象に文書方針があれば適用してください。現行の操作説明を正確に保ち、過去の結果は証拠として残してください。文書の事実・数量・条件・範囲・権限・未確認の主張・参照を原資料へ照合してください。',
    'commit・push・公開をしないでください。設定済みの全体検証は変更後にホストが実行します。sandbox内でブラウザーやサーバーを起動しないでください。',
    ...(capture
      ? [
          `このIssueに必要な媒体と、設定済みのcaptureコマンドを準備してください。最終的な媒体は${capture.destination}/で参照してください。`,
          'ホストは通常のテストとは別にcaptureを実行します。captureコマンドの最後の引数には、出力ディレクトリの絶対パスが渡されます。その直下にはPNG/JPEG/WebP/MP4/WebMファイルだけを保存してください（ブラウザー定義ではCAPTURE_OUTPUT）。動画用コンテキストを閉じ、動画を同じ場所に保存してください。capture中に媒体や報告をcheckoutへ書き込まないでください。',
        ]
      : [
          'この対象はcaptureなしと宣言されています。合意済みIssueで媒体が必要なら、実行前に必要なcaptureを設定できるようneeds_humanを返してください。',
        ]),
    '実装とテスト・captureの定義が揃い、設定済みのcheck・captureの実行だけが残る場合はrepairedを返してください。実際の契約を調べ、予定されているcheckだけを理由にneeds_hostを返さないでください。必要な受入検証がその契約では実行されず、権限のあるホストで担当AIが実行する必要がある場合はneeds_hostを返してください。そのfindingsは空白以外の内容を含み、必要な検証、設定済みcheck・captureでは不足する理由、対象版、期待する証拠を示す必要があります。これは受入でも人の判断でもありません。要求・範囲・権限・実行上限を変える必要がある場合は、それらを変えずにneeds_humanを返し、回答に依存する作業を止めてください。',
    'statusがrepaired、needs_host、needs_humanのいずれかで、変更内容または必要な人の判断をfindingsに説明したJSONを返してください。needs_humanでは、findingsを空文字や空白だけにせず、質問、人が選ぶ必要のある選択肢、その影響を説明してください。指示ファイルが停止の理由なら、実際に読んだファイルへのリンクと該当する指示の引用を示し、明示された要件と自分の解釈を区別してください。',
  ].join('\n');
}

export function feedbackInstructions(command?: string[]) {
  return command
    ? [
        `feedbackCheck（担当セッション内の反復用）: ${JSON.stringify(command)}。通常の作業中の確認にはこのコマンドを使い、対象repoの方針に従って必要な確認範囲へ広げてください。実装・修正の完了前に全体のcheckが通る状態にする契約は変わりません。ホストは各修正後に全体のcheckを実行します。feedbackCheckの成功を全体checkの成功として扱わないでください。`,
      ]
    : [];
}

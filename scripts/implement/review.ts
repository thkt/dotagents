import assert from 'node:assert/strict';
import { z } from 'zod';
import { walkthroughSteps } from './walkthrough.ts';

export const reviewModel = { model: 'gpt-6.1-sol', reasoningEffort: 'high' };
const text = z.string().min(1).regex(/\S/);
const disposition = z.enum(['open', 'fixed', 'not_applicable']);
const newItem = z.strictObject({
  kind: z.enum(['defect', 'concern']),
  area: z.enum(['code', 'requirements', 'tests', 'documentation']),
  required: z.boolean(),
  location: z
    .strictObject({
      path: text.nullable(),
      line: z.number().int().min(1).nullable(),
    })
    // Cross-field validation remains a runtime check; JSON Schema conversion
    // does not encode this refinement (the previous output schema did not either).
    .refine((value) => value.line === null || value.path !== null),
  condition: text,
  impact: text,
  evidence: text,
  action: text,
  reason: text,
});
const reviewResponse = z.strictObject({
  findings: text,
  walkthrough: walkthroughSteps,
  targetId: text,
  assessments: z.strictObject({ code: text, requirements: text, tests: text, documentation: text }),
  updates: z.array(z.strictObject({ id: text, disposition, reason: text })),
  newItems: z.array(newItem),
  documents: z.array(
    z.strictObject({
      path: text,
      role: z.enum(['current', 'historical', 'proposal']),
      reason: text,
    }),
  ),
  handoff: z.array(text),
});
export const reviewSchema = z.toJSONSchema(reviewResponse);

// Stored records keep the complete host-owned identity and status. Reuse the
// response fields so reading a saved review validates the same item details.
const reviewItem = newItem.extend({ id: text, introducedIn: text, disposition });
export const reviewRecord = reviewResponse.omit({ updates: true, newItems: true }).extend({
  walkthrough: walkthroughSteps.optional(),
  status: z.enum(['accepted', 'needs_changes']),
  items: z.array(reviewItem),
});
export type ReviewItem = z.infer<typeof reviewItem>;
export type Review = z.infer<typeof reviewRecord>;

export function parseReview(
  stdout: string,
  targetId: string,
  attempt: number,
  previous?: Review,
): Review {
  const parsed = reviewResponse.safeParse(JSON.parse(stdout));
  assert(parsed.success, 'Missing or invalid review fields');
  const value = parsed.data;
  assert(value.targetId === targetId, 'Review target mismatch');
  const priorItems = previous?.items ?? [];
  const ids = new Set(priorItems.map((item) => item.id));
  const updates = new Map(value.updates.map((update) => [update.id, update]));
  assert(updates.size === value.updates.length, 'Duplicate finding update ID');
  assert(
    value.updates.every((update) => ids.has(update.id)),
    'Unknown finding update ID',
  );
  const items = priorItems.map((prior) => {
    const update = updates.get(prior.id);
    assert(update, 'Prior finding omitted');
    return { ...prior, disposition: update.disposition, reason: update.reason };
  });
  for (const [index, finding] of value.newItems.entries()) {
    items.push({
      ...finding,
      id: `R${attempt}-${index + 1}`,
      introducedIn: targetId,
      disposition: 'open',
    });
  }
  assert(
    new Set(value.documents.map((doc) => doc.path)).size === value.documents.length,
    'Duplicate document reference',
  );
  const { updates: _updates, newItems: _newItems, ...details } = value;
  return {
    ...details,
    items,
    status: items.some((item) => item.required && item.disposition === 'open')
      ? 'needs_changes'
      : 'accepted',
  };
}

export const reviewInstructions = [
  '初回評価でも再評価でも、現在の成果物を独立して評価してください。現在の差分に加え、影響する呼出元・呼出先、共有型、状態遷移、エラー処理、関連テストを読んでください。過去の指摘を判定すると同時に、現在の関連経路で具体的な問題の再発や新規発生も確認してください。過去の指摘を直しただけでは受入の根拠になりません。無関係なコードの監査や、範囲外の機能・書き方の好みを要求しないでください。',
  'walkthroughには、現在の最終評価対象の実際の差分と関連コードに基づく説明順のステップを返してください。追加修正と必要な文書変更も考慮し、初回要約を最終説明として流用しないでください。各ステップのtitle、intent、rationale、code（repo相対path・1始まりのstart/end行）、evidence（保存済み検証の参照と意味）、limitations（未確認事項）を記してください。全ファイルの網羅や固定ステップ数は不要です。現在の対象に存在する通常UTF-8ファイルだけを参照し、削除の説明には関連する現行コードと保存diffを使ってください。コード・証拠と説明の意味、版、条件を四観点の既存評価で独立して照合し、識別値の一致だけで内容を正しいと判断しないでください。説明の欠陥は通常の指摘へ戻してください。',
  '次の四つの観点を分けて評価してください。コードの正しさ（入力境界、状態更新、非同期動作、失敗時の副作用）と具体的な冗長性、合意済みIssueの要求と範囲、テストによる現実的な不具合の検出力、必要な文書・証拠と実装版の整合です。',
  'Issueにその振る舞いが明記されていなくても、コードの欠陥を報告してください。確認できた欠陥と未確認の懸念を区別してください。指摘なしもcheck成功も、欠陥が存在しないことを保証しません。',
  '変更に関係する冗長性は、影響するヘルパーの呼出しを、その内部の読取りと検査まで展開して確認してください。隣接する重複文だけでなく、呼出元と呼出先を通して、対象・入力・版・目的の一致を追ってください。観測が繰り返される箇所ごとに、その間の操作、または新たな結果を必要とする別の保証を特定してください。同じ境界内で、一度の新しい観測結果を呼出元と呼出先で共用できるか検討してください。外部状態が変わり得ることだけでは、すべての再読取りを正当化できません。モデル実行、setup、書込み、公開をまたぐために必要な観測は保ち、鮮度と失敗時の動作を考慮してください。ローカル書込みがないことだけでも、冗長性の証明にはなりません。工程をまたぐキャッシュや再検証の一括削除を指示しないでください。分岐・状態・引き継ぎの重複も調べ、最初の指摘で関連経路の追跡を止めないでください。',
  '具体的な冗長性はnewItemsへ記載してください。場所、呼出経路と一致する入力、条件と観測時点、実行または保守の費用、局所的な削除・統合案と残る保証を示してください。assessments.codeでは、指摘の経緯を繰り返さず、最終的な変更と理由を説明してください。変更後の経路全体を比較してください。抽象化によって、減る量より多くの引数・分岐・状態・説明が増えることもあります。見た目の類似、短さ、行数、好みだけでは指摘になりません。削除も抽象化も、それ自体で優れているわけではありません。指摘0件も有効です。読めた範囲の限界と判断を保留する理由を正直に示してください。',
  '冗長性の対象・条件・無駄が確認でき、合意範囲内の局所修正で必要な保証を保てる場合、その指摘をrequiredにしてください。既存の修正ループへ戻し、公開前に解消してください。規模や重大度による件数の割当ては設けないでください。効果が不明なもの、好みだけのもの、範囲外の再設計は、冗長性の必須修正にしないでください。',
  '対象のテスト方針を読み、実装側の主張ではなく要求に照らして、影響するテストを独立して調べてください。assessments.testsには、防ぐ現実的な不具合、既存検証に加わる保証、テストを追加・維持・統合・削除する理由、失う検出条件、残る検証と未確認の限界を説明してください。その保証を実行時間・不安定さ・保守費用と比較し、コピーした期待値や、誤った理由で通る否定テストを見つけてください。具体的な見逃しや正当化できない費用は、通常の指摘として修正へ戻してください。ただし、件数の減少を理由に妥当な削除を拒否したり、既存検証で十分な箇所にテストを要求したり、テストごとの台帳を要求したりしないでください。テスト整理では、実装・テスト・文書・実行時間を同じ条件で比較してください。ファイル移動や行の圧縮だけを利点にしないでください。実測と仮説を区別してください。この評価はPR説明へ渡ります。schemaへの適合は、判断の品質やモデルの指示遵守を証明しません。',
  '文書だけの変更にも、対象の文書方針を適用してください。変更文書の事実・数量・条件・範囲・権限・未確認の主張・参照を、Issue・原資料・コード・check結果と照合してください。読者が必要な判断をできるか評価し、具体的な内容の欠陥は修正へ戻してください。現行方針、過去の証拠、未採用の提案を区別してください。関連する要求なしに新しいコードやテストを要求しないでください。',
  '実装の前提を、ホストコンテキストにあるIssue・報告参照と引き継ぎ版へ照合してください。requirementsとdocumentationの評価では、関係する適用条件・合意・根拠の変化を説明し、出典を選んだ理由はdocumentsのreasonへ記載してください。矛盾する観測は出典を辿り、影響する前提とIssueの判断へ結び付けてください。独立して根拠を調べた上で差分を提案するか、不足する事実は調査へ、要求・権限の変更は人へ戻してください。根拠の編集は許可を意味しません。判断を妨げる不足や矛盾は、影響する判断と戻り先をactionに記したrequiredかつopenの指摘としてください。受入後の引き継ぎ作業にしないでください。評価担当は人の判断を代行できません。',
  'ファイルを編集せず、全体checkを実行しないでください。ホストのcheck結果は対象記録にあります。現在の成果物と必要な範囲の検証を使って指摘を判定し、修正担当の自己申告をそのまま信用しないでください。',
  'ホストのtargetRecordにあるtestsから独立テストの入力・応答・成果物・findingsを辿り、Issueと版、検出条件、修正前の狙った失敗と正常対照、修正後の成功を現在のcheckへ照合してください。テスト不要の理由も評価してください。実装担当の説明を期待値の根拠にせず、不一致はIssueへ照合し、要求の変更は人へ戻してください。機械的な接続変更もテスト担当の別セッションで行います。入力境界の記録は意味的な独立性やモデル品質の改善を証明しません。',
  'ホストのtargetRecordにあるrepairsSinceReviewを順に読んでください。前回の独立評価以降（初回評価では実行開始以降）に、この実行で正常に完了した追加修正をすべて参照しており、修正後のcheckが失敗したものも含みます。latestRepairは引き続き最新の要素を示します。各<prefix>.stdoutのfindingsを読み、根拠・変更・成果物を変えなかった理由を辿ってください。attempt、sourceBefore、sourceAfter、stdoutHashは、その修正と応答を特定します。その後のホスト撮影による変更も考慮し、現在のIssue・対象ソース・check結果と照合してください。以前の評価区間や別runの、参照されていない修正で代用しないでください。repairsSinceReviewが空でlatestRepairがnullなら追加修正はなく、初回評価でも有効です。修正の説明は調査すべき主張として扱い、自動的にfixedやacceptedと判断せず、過去のすべての指摘を現在の根拠で独立して再評価してください。',
  'UIの実装・変更では、主要な表示状態と対応幅の1px刻みの幅掃引結果を、同じ画面・状態・対象版・条件へ照合してください。ページ全体の横はみ出しの失敗、候補の実画面確認と修正後の再検証、実行不能・未実行を区別し、check成功や実行予定だけで受入にしないでください。幅・状態・候補・対象版・条件・未確認事項を証拠から辿り、検証と限界をassessments.tests、Issue固有の残る条件をhandoffへ渡してください。',
  'レビュー用JSON schemaに従って応答してください。ホストコンテキストのtargetIdをそのまま返してください。四つのassessmentsすべてに適用性を含む具体的な理由を書き、未確認の限界は該当する評価欄に置き、四つ全部へ繰り返さないでください。findingsは全体の要約です。statusやitemsではなく、updatesとnewItemsを返してください。ホストが完全な記録を再構成し、requiredかつopenの指摘からstatusを計算します。',
  '既存のPR生成器は、assessments、現在の指摘のreason（openの指摘ではcondition・impact・actionも）、documentsのreason、handoffを公開用に選びます。各説明の置き場を一つにしてください。codeは具体的な変更と理由、requirementsは実装説明を繰り返さず合意済みの振る舞いとの対応、testsは模擬テストと実実行を区別した実際の検証と限界、documentationは出典の適用条件・版・合意・前提の変化を説明し、個々の文書の役割と選定理由はdocumentsへ置きます。四つのassessmentsすべてに具体的な理由を記しつつ、同じ変更・結論・注意点を重複させたり、指摘への回答をassessmentsへコピーしたりしないでください。表現が似ていても、異なる条件・否定・権限・未確認の限界・担当は保持し、必要なら該当する説明を参照してください。検証済みcommit、checkコマンドと結果、accepted状態はホストが追加します。これらの機械的な事実を繰り返さず、検証が何を検出するか説明してください。一般的な全件成功の主張ではなく、簡潔で事実に即した文章にしてください。生ログやホスト内の記録への参照はevidence・findingsと内部記録に置き、公開用の項目には置かないでください。fixedまたはnot_applicableの指摘では、reasonが公開用の回答全文になります。関係する問題と条件、現在の解決内容または適用されない理由と根拠を特定し、引き続き関係する影響や限界を保持してください。生成器はその元のcondition・impact・actionを公開しないため、必要な文脈をそれらの項目に依存させないでください。反復の経緯を語り直したり生の根拠をコピーしたりしないでください。内部の完全な評価と指摘履歴は保持してください。',
  'assessments.codeには、読者が変更箇所と理由を理解する助けになる場合だけ、短い呼出経路、型・データの形、責任分担の比較など、必要最小限の構造説明を加えてください。既存構造の変更には焦点を絞ったdiffブロックを使い、新しい構造や、差分では担当・順序が不明になる場合は、必要な構造全体を示してください。評価対象版の実際の差分と関連コードに基づかせてください。略図や擬似コードはそう明記し、判断に関係する条件・失敗時の動作・実行順序・担当を保持してください。未実装の構造を実装済みとして描かないでください。リンク修正や表現だけの明確化など、文章で十分な場合は構造説明を省いてください。すべてのPRに図、構造の節、固定の文数・箇条書き数、画像、HTMLを要求しないでください。選んだ説明を差分・関連コードへ独立して照合し、版の整合、重要な条件、明瞭な日本語を確認してください。短さだけでは、説明の十分性、モデルの指示遵守、読む時間の改善の証拠になりません。',
  'newItemsの各要素には、kind（defectまたはconcern）、area（code/requirements/tests/documentation）、required、location、condition、impact、evidence、action、reasonが必要です。id、introducedIn、dispositionは省いてください。ホストが識別子、検証済みtargetId、openを割り当てます。IDは指摘の内容や人の判断の要否を意味しません。文書の欠落など、実在するコード位置がない場合はpathとlineをnullにしてください。位置や再現実行を捏造しないでください。',
  '解決済みも含め、過去のすべての指摘IDに対してupdatesの要素をちょうど一つずつ返してください。現在の成果物と検証に基づくid、disposition（open、fixed、not_applicable）、reasonだけを使ってください。元の詳細はホストが保持します。詳細を繰り返したり過去のIDをnewItemsへ入れたりしないでください。初回評価のupdatesは空です。実装者の主張だけではなく、修正や非該当を示す具体的な根拠を説明してください。必要なら再度openにしてください。未解決のrequiredな指摘はopenのまま残してください。',
  '実際に参照した主要なリポジトリ文書を、正確なリポジトリ相対パス、role（current/historical/proposal）、参照理由とともに列挙してください。ホストが版を対応付けます。これは十分に読んだことの証明でも、全文書の索引でもありません。',
  '定型の公開・アップロード・CI作業、担当AIによる公開された根拠の照合と媒体の実表示・レイアウト確認、人によるレビュー・承認・マージは、実行条件に応じてホストだけがPR本文へ追加します。handoffや他の公開用項目へ繰り返さないでください。公開前に未実施であることは実装の欠陥ではなく、acceptedもこれらの完了や免除を意味しません。handoffはIssue固有の未確認条件、必要な後続対応、明示した担当に限定し、残るものがなければ[]を返してください。表現が似ていても、異なる条件や担当は保持してください。',
].join('\n');

export function reviewSummary(history: Review[], recordPaths: string[]) {
  const current = history.at(-1);
  if (!current) {
    return '';
  }
  return [
    current.findings,
    `評価対象: ${current.targetId}`,
    ...Object.entries(current.assessments).map(([key, value]) => `${key}: ${value}`),
    ...current.documents.map((doc) => `出典: ${doc.path} (${doc.role}): ${doc.reason}`),
    ...current.items.map(
      (item) =>
        `${item.id} (${item.area}/${item.kind}, ${item.disposition}, required=${item.required}, target=${item.introducedIn}): ${item.location.path ?? 'ファイル位置なし'}${item.location.line === null ? '' : `:${item.location.line}`}: ${item.condition}; 影響: ${item.impact}; 根拠: ${item.evidence}; 対応: ${item.action}; 判定: ${item.reason}`,
    ),
    ...current.handoff.map((action) => `引き継ぎ: ${action}`),
    `評価記録（ホスト内）: ${recordPaths.join(', ')}`,
    '構造の検証とcheck成功は、欠陥が存在しないことを保証しません。',
  ].join('\n\n');
}

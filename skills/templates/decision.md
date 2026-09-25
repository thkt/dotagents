# 判断記録の書式

dotclaudeのMADR形式を使う。`docs/decisions/NNNN-name.md`に保存し、既存の最大番号の次を選ぶ。本文は日本語で書ける。提案段階なら決定者や結論を捏造せず、未決定と記す。適用するrepo・目的・条件をContextに明記する。

```markdown
---
status: "proposed"
date: "YYYY-MM-DD"
decision-makers: "確認できた人または役割。未確認なら未確認"
---

# 選択を表すタイトル

## Context and Problem Statement

対象と適用範囲、何を決める必要があるか。

## Considered Options

- 選択肢A
- 選択肢B

## Decision Outcome

選んだ案と理由、合意を確認した出典。提案なら未決定と記す。

### Consequences

- 良くなること。
- 引き受ける不利益と未確認事項。

### Confirmation

採用した実装や運用が判断に合うことを確かめる方法。

## More Information

原本のパス・版、Issue・PR、置換するDRへの参照。

### Reassessment Triggers

- 見直す条件。
```

Decision Drivers、Pros and Cons of the Options、consulted、informedは判断に必要な場合だけ加える。状態と置換方法は[共通手順](../references/documents.md#残す更新する)に従う。

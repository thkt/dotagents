module publication {
  // 版0を検証した後、別の書込み主体が版1へ一度だけ変更できる。
  // SHAの衝突、巻戻し、複数run、認証・ネットワーク障害は扱わない。
  type State = { current: int, verified: int, phase: str, sent: int }
  var s: State

  action init = s' = { current: 0, verified: -1, phase: "new", sent: -1 }

  action verify = all {
    s.phase == "new",
    s' = s.with("verified", s.current).with("phase", "verified"),
  }

  action change = all {
    s.current == 0,
    s.phase == "verified" or s.phase == "checked",
    s' = s.with("current", 1),
  }

  // 不一致は送信せず停止する。停止したrunは再開しない。
  action inspect = all {
    s.phase == "verified",
    s' = s.with("phase", if (s.current == s.verified) "checked" else "stopped"),
  }

  // 粗いモデル: 照合と送信が原子的、という現実より強い仮定。
  action atomicPush = all {
    s.phase == "verified",
    s' = if (s.current == s.verified)
      s.with("sent", s.current).with("phase", "sent")
    else s.with("phase", "stopped"),
  }

  // 現行refspecの抽象化: 照合の後、送信時点でブランチを解決する。
  action branchPush = all {
    s.phase == "checked",
    s' = s.with("sent", s.current).with("phase", "sent"),
  }

  // 比較案: 送信元を検証済みSHAに固定する。この案は実装未採用。
  action pinnedPush = all {
    s.phase == "checked",
    s' = s.with("sent", s.verified).with("phase", "sent"),
  }

  // 検出力の対照: 送信前の照合を意図的に省く。
  action uncheckedPush = all {
    s.phase == "verified",
    s' = s.with("sent", s.current).with("phase", "sent"),
  }

  action idle = s' = s
  action atomicStep = any { verify, change, atomicPush, idle }
  action splitStep = any { verify, change, inspect, branchPush, idle }
  action pinnedStep = any { verify, change, inspect, pinnedPush, idle }
  action uncheckedStep = any { verify, change, uncheckedPush, idle }

  // 送った内容が、そのrunで検証した版と一致する。後日の版変更とは比較しない。
  val invVerifiedPayload = s.sent == -1 or s.sent == s.verified
}

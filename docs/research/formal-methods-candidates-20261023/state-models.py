"""有限モデルの到達状態を幅優先探索する。実装の証明ではない。"""
from collections import deque
import json
import sys
from pathlib import Path

def explore(initial, steps, invariant):
    pending = deque([(initial, [])])
    seen = {initial}
    while pending:
        state, trace = pending.popleft()
        if not invariant(state):
            return {"states": len(seen), "counterexample": trace, "violatingState": state}
        for name, target in steps(state):
            if target not in seen:
                seen.add(target)
                pending.append((target, trace + [name]))
    return {"states": len(seen), "counterexample": None}

def publication(retry_unknown):
    # 工程、実際の外部効果、把握した状態、送信回数、未照合のままの再送
    def steps(s):
        phase, effect, knowledge, sends, unsafe = s
        if phase == 'ready' and sends < 2:
            for success in (False, True):
                yield 'send(effect=%s)' % success, ('inflight', effect or success, 'unknown', sends+1, unsafe)
        if phase == 'inflight':
            yield 'lose-response', ('stopped', effect, 'unknown', sends, unsafe)
            yield 'observe-response', ('done' if effect else 'ready', effect, 'yes' if effect else 'no', sends, unsafe)
        if phase == 'stopped':
            yield 'reconcile-actual-state', ('done' if effect else 'ready', effect, 'yes' if effect else 'no', sends, unsafe)
            if retry_unknown and sends < 2:
                yield 'retry-without-reconciliation', ('inflight', effect, 'unknown', sends+1, True)
    return explore(('ready',False,'no',0,False), steps, lambda s: not s[4])

def version(pinned):
    # 現在の版、検証版、工程、送信版。外部の版変更を照合と送信の間にも許す。
    def steps(s):
        current, verified, phase, sent = s
        if current == 0:
            yield 'external-change', (1,verified,phase,sent)
        if phase == 'initial':
            yield 'verify', (current,current,'verified',sent)
        if phase == 'verified':
            yield 'inspect', (current,verified,'inspected' if current == verified else 'stop',sent)
        if phase == 'inspected':
            yield 'send-pinned' if pinned else 'send-branch', (current,verified,'sent',verified if pinned else current)
    return explore((0,-1,'initial',-1),steps,lambda s:s[2]!='sent' or s[3]==s[1])

def authority(compare_parent):
    # 最初の公開権限、直前の公開権限、履歴中の制限、復帰回数
    def steps(s):
        initial,current,restricted,depth=s
        if depth < 3:
            for next_authority in (False,True):
                if next_authority and not (current if compare_parent else initial):
                    continue
                yield 'return(publish=%s)'%next_authority,(initial,next_authority,restricted or not next_authority,depth+1)
    return explore((True,True,False,0),steps,lambda s:not(s[1] and s[2]))

result={
 'publication': {'preserveUnknown':publication(False),'retryUnknownControl':publication(True)},
 'version': {'pinnedCurrent':version(True),'branchPushControl':version(False)},
 'authority': {'parentCheckCurrent':authority(True),'rootOnlyControl':authority(False)},
}
for family in result.values():
    current, control = family.values()
    assert current['counterexample'] is None
    assert control['counterexample'] is not None
Path(sys.argv[1]).write_text(json.dumps(result,indent=2))
print(json.dumps(result,indent=2))

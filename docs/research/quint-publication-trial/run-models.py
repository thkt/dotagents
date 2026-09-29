"""固定したQuint環境で4条件を実行し、反例と実行失敗を区別して保存する。"""
import hashlib
import json
import pathlib
import re
import subprocess
import sys
import time

source = pathlib.Path(__file__).resolve().parent
quint = pathlib.Path(sys.argv[1]).resolve()
output = pathlib.Path(sys.argv[2]).resolve()
output.mkdir(parents=True, exist_ok=True)
results = []
for step, violation in [("atomicStep", False), ("uncheckedStep", True),
                        ("splitStep", True), ("pinnedStep", False)]:
    argv = [str(quint), "verify", str(source / "publication.qnt"),
            "--backend=tlc", f"--step={step}", "--invariant=invVerifiedPayload",
            f"--tlc-config={source / 'tlc.json'}", "--verbosity=3"]
    started = time.monotonic()
    run = subprocess.run(argv, cwd=output, text=True, stdout=subprocess.PIPE,
                         stderr=subprocess.STDOUT, timeout=90)
    elapsed = time.monotonic() - started
    (output / f"{step}.log").write_text(run.stdout)
    expected = (run.returncode == 1 and "Invariant q_inv is violated" in run.stdout
                and "[violation]" in run.stdout) if violation else (
                    run.returncode == 0 and "Model checking completed. No error" in run.stdout)
    counts = re.search(r"(\d+) states generated, (\d+) distinct states found, (\d+) states left", run.stdout)
    results.append({"step": step, "exitCode": run.returncode, "expectedOutcome": expected,
                    "violation": violation, "wallSeconds": round(elapsed, 3),
                    "generated": int(counts[1]) if counts else None,
                    "distinct": int(counts[2]) if counts else None,
                    "remaining": int(counts[3]) if counts else None})
    if not expected:
        print(run.stdout)
        raise SystemExit(f"検証結果を分類できません: {step}")
summary = {"modelSha256": hashlib.sha256((source / "publication.qnt").read_bytes()).hexdigest(),
           "quintVersion": subprocess.check_output([str(quint), "--version"], text=True).strip(),
           "results": results}
(output / "results.json").write_text(json.dumps(summary, indent=2) + "\n")
print(json.dumps(summary, indent=2))

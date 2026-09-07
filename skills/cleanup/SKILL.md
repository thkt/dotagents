---
name: cleanup
description: Prepares and explicitly approves post-merge cleanup from a verified Build Ship receipt, preserving dirty state and unrelated Git data.
---

# Cleanup

Use only a leading explicit `$cleanup <issue>` or `$cleanup approve <prepared digest>` invocation. Run the hook-supplied `codex-cleanup` command and input unchanged; omit `--run-id` because the hook injects task identity. `codex-cleanup describe` documents the closed CLI.

For preparation, explain the exact return base, deletion targets, saved dirty state, and prepared digest from the preview. Preparation does not authorize cleanup. Ask for `$cleanup approve <prepared digest>` only after presenting this concrete preview.

Approval authorizes that immutable repository/task-bound preimage. The runtime restores and verifies saved state before deleting expected-OID targets. Report completed, pending and unattempted steps, retained recovery OID/ref, and the failure reason. Resume interrupted approved work only with `codex-cleanup resume --input` and the original hook-supplied path; never rearm it or fabricate a historical Ship receipt.

A pending remote deletion with the expected OID still present is ambiguous. Retain local and recovery refs and explain the required manual resolution; do not resend the deletion, infer recreation history, or auto-resume from a Stop hook. After verified remote absence, the original approved operation can resume.

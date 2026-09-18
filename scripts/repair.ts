// Invalid statuses retain well-formed findings for the correction failure record.
export function parseRepairReply(
  stdout: string,
):
  | { status: 'repaired' | 'needs_human'; findings: string }
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
    value.status === 'repaired' || value.status === 'needs_human' ? value.status : 'invalid';
  return { status, findings: value.findings };
}

// Callers keep their task, targeted-check purpose and escalation conditions explicit.
export function repairInstructions(capture: { destination: string } | null) {
  return [
    'Before creating or updating tests, apply the target test policy when present and these common test criteria. Ask what realistic bug deleting each relevant test would miss. Compare its additional assurance with runtime, flakiness and maintenance cost; actively remove or consolidate tests that do not justify that cost. Do not retain tests merely for reassurance, test counts or coverage metrics. Explain any lost detection conditions and the remaining verification.',
    'In findings, explain the concrete bugs prevented by verification affected by this change, what it adds beyond existing verification, and why tests were added, retained, consolidated or removed. State lost detection conditions, remaining verification and unverified limits. Reuse sufficient existing tests; do not create a per-test ledger. For test cleanup, compare implementation, test and documentation changes and runtime under the same conditions; do not count line compression or file moves as an improvement or claim unmeasured effects.',
    'Apply the target documentation policy when present to documentation-only changes and accompanying updates; keep current operating instructions accurate and historical results in evidence. Compare document facts, quantities, conditions, scope, authority, unverified claims and references with original sources.',
    'Do not commit, push or publish. Leave configured full verification to the host after your changes; do not launch browsers or servers in your sandbox.',
    ...(capture
      ? [
          `Prepare the configured capture command and required media for this Issue. Reference final media at ${capture.destination}/.`,
          'The host runs capture separately from normal tests. Its command receives the absolute output directory as the final argument. Save only PNG/JPEG/WebP/MP4/WebM files directly under that directory (CAPTURE_OUTPUT for browser definitions). Close video contexts and save video there. Do not write media or reports into the checkout during capture.',
        ]
      : [
          'This target declares no capture. If the agreed Issue needs media, return needs_human to configure required capture before execution.',
        ]),
    'Return repaired when implementation and test/capture definitions are ready; pending host execution alone is not needs_human. Actual requirement or authorization decisions still require needs_human.',
    'Return JSON with status repaired or needs_human, and findings explaining your changes or the necessary human decision.',
  ].join('\n');
}

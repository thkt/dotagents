/** @file Outcome: Public acceptance binds every unchanged report string and both final bytes to an independent audit. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isIP } from 'node:net';
import { FlowError } from '../shared/errors.ts';
import { isObject, rejectUnknownKeys } from '../shared/schema.ts';
import type { ResearchInput, ResearchReport } from './contracts.ts';
import {
  canonicalJson,
  canonicalReport,
  reportStrings,
  renderCorpusMarkdown,
  sha256,
} from './corpus.ts';

const codes = [
  'secret',
  'personal_data',
  'private_endpoint',
  'unsafe_url',
  'embed',
  'source_reproduction',
  'unavailable_evidence',
  'uncertain',
] as const;
export interface PublicSafetyAudit {
  verdict: 'safe' | 'unsafe' | 'indeterminate';
  coverage: string[];
  findings: { path: string; code: (typeof codes)[number] }[];
}
export interface PublicSafetyContext {
  report: ResearchReport;
  markdown: string;
  strings: { path: string; value: string }[];
}
export interface SafetyAcceptance {
  audit: PublicSafetyAudit;
  dispatch: string;
  binding: string;
}
export const PUBLIC_SAFETY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['safe', 'unsafe', 'indeterminate'] },
    coverage: { type: 'array', items: { type: 'string' } },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { path: { type: 'string' }, code: { type: 'string', enum: codes } },
        required: ['path', 'code'],
      },
    },
  },
  required: ['verdict', 'coverage', 'findings'],
} as const;
export function safetyContext(report: ResearchReport): PublicSafetyContext {
  return { report, markdown: renderCorpusMarkdown(report), strings: reportStrings(report) };
}
function reject(): never {
  throw new FlowError(
    'Research public-safety validation rejected publication',
    'research_safety_error',
  );
}
export function parsePublicSafetyAudit(
  raw: unknown,
  context: PublicSafetyContext,
): PublicSafetyAudit {
  if (!isObject(raw)) reject();
  try {
    rejectUnknownKeys(raw, ['verdict', 'coverage', 'findings'], 'safety audit');
  } catch {
    reject();
  }
  if (
    !['safe', 'unsafe', 'indeterminate'].includes(String(raw.verdict)) ||
    !Array.isArray(raw.coverage) ||
    !Array.isArray(raw.findings)
  )
    reject();
  const expected = context.strings.map((item) => item.path).sort();
  if (
    canonicalJson(
      [...raw.coverage].sort((a, b) =>
        String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0,
      ),
    ) !== canonicalJson(expected)
  )
    reject();
  for (const finding of raw.findings) {
    if (
      !isObject(finding) ||
      Object.keys(finding).sort().join(',') !== 'code,path' ||
      !expected.includes(String(finding.path)) ||
      !codes.includes(finding.code as (typeof codes)[number])
    )
      reject();
  }
  if (raw.verdict === 'safe' && raw.findings.length) reject();
  return structuredClone(raw) as unknown as PublicSafetyAudit;
}
function reservedHost(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/gu, '')
    .replace(/\.$/u, '');
  if (!host.includes('.') && !isIP(host)) return true;
  if (
    /(?:^|\.)(?:localhost|local|internal|invalid|test|example|onion)$/u.test(host) ||
    /(?:^|\.)(?:example\.(?:com|org|net)|home\.arpa)$/u.test(host)
  )
    return true;
  if (isIP(host) === 4) {
    const [a, b, c] = host.split('.').map(Number) as [number, number, number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  // Public IPv6 unicast is 2000::/3; documentation and transition ranges fail closed.
  if (isIP(host) === 6) {
    const [first, second] = host.split(':').map((group) => Number.parseInt(group || '0', 16));
    return (
      first! < 0x2000 ||
      first! > 0x3fff ||
      (first === 0x2001 && (second! < 0x200 || second === 0xdb8)) ||
      first === 0x2002 ||
      first! >= 0x3ffe
    );
  }
  return false;
}
// Inspect complete assignment keys so casing, namespace prefixes and separators
// cannot hide a credential suffix. Policy suffixes (PASSWORD_MIN_LENGTH) remain
// ordinary fields; short PASS keys need a boundary to exclude bypass and compass.
function containsCredential(value: string): boolean {
  if (
    /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-(?:proj-)?[\w-]{16,}|gh[pousr]_[\w]{20,}|github_pat_[\w]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[\w-]+))/iu.test(
      value,
    )
  )
    return true;
  for (const match of value.matchAll(/(?<![a-z0-9_-])([a-z0-9_-]+)["']?\s*[:=]\s*(?=\S)/giu)) {
    const key = match[1]!;
    const normalized = key.replace(/[_-]/gu, '').toLowerCase();
    if (
      /(?:password|passwd|passphrase|pwd|secret|(?:api|access|secret|private|signing)key|accesskeyid|token|authorization)$/u.test(
        normalized,
      ) ||
      /(?:^|[_-])pass$/iu.test(key) ||
      /[a-z]Pass$/u.test(key)
    )
      return true;
  }
  return false;
}

// Match complete national phone layouts, including trunk prefixes and area-code
// parentheses. Digit counts keep dates, postal codes and short numeric ranges out.
const nationalPhone =
  /(?<![\p{L}\p{N}_])(?:0\d{1,4}[ .-]\d{1,4}[ .-]\d{3,4}|\(0\d{1,4}\)[ .-]?\d{1,4}[ .-]?\d{3,4}|0\d{1,4}\(\d{1,4}\)\d{3,4}|0[1-9](?:[ .-]\d{2}){4}|0[789]0\d{8})(?![\p{L}\p{N}_])/gu;

function hazard(value: string): boolean {
  value = value.normalize('NFKC');
  if (containsCredential(value)) return true;
  if (
    [...value.matchAll(nationalPhone)].some((match) => {
      const digits = match[0].replace(/\D/gu, '').length;
      return digits === 10 || digits === 11;
    })
  )
    return true;
  if (
    /(?:\/(?:Users|home|root)\/[^\s/]+|\/(?:private\/)?var\/folders\/[^\s/]+|[A-Za-z]:[\\/]Users[\\/]|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\b\d{3}-\d{2}-\d{4}\b|(?:\b\d{3}[ .-]\d{3}[ .-]|\(\d{3}\)[ .-]?\d{3}[ .-]?)\d{4}\b|(?:\+\d[\d ().-]{8,}\d)|\b(?:\d[ -]*?){13,19}\b)/iu.test(
      value,
    )
  )
    return true;
  if (
    /(?:<\/?[A-Za-z!][^>]*>|!\[[^\]]*\]\s*\(|\[[^\]]*\]\s*\([^)]*\)|\bdata:|\bjavascript:|\bfile:|\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0)\b)/iu.test(
      value,
    )
  )
    return true;
  if (
    Array.from(value).some((char) => {
      const code = char.codePointAt(0)!;
      return (
        (code < 32 && ![9, 10, 13].includes(code)) ||
        (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069)
      );
    }) ||
    /\bBearer\s+[\w.+/=-]{12,}/iu.test(value) ||
    /\beyJ[\w-]+\.[\w-]+\.[\w-]+/u.test(value)
  )
    return true;
  for (const match of value.matchAll(
    /\b(?:[a-z][a-z0-9+.-]*:\/\/|(?:https?|ftp|sftp|ssh|git|ws|wss|file|data|javascript|mailto|tel):)[^\s<>"']+/giu,
  )) {
    try {
      const url = new URL(match[0]);
      if (url.protocol !== 'https:' || url.username || url.password || reservedHost(url.hostname))
        return true;
      // URLSearchParams decodes escaped keys and values, including OAuth fragment parameters.
      for (const [key, parameter] of [
        ...url.searchParams,
        ...new URLSearchParams(url.hash.slice(1)),
      ])
        if (containsCredential(`${key}=${parameter}`.normalize('NFKC'))) return true;
    } catch {
      return true;
    }
  }
  // Bare DNS names and host:port endpoints use the same policy as URL hosts.
  // Consume the complete name so a reserved-looking prefix of a public host is not rejected.
  for (const match of value.matchAll(/\b[\w-]+(?:\.[\w-]+)+\.?/gu))
    if (reservedHost(match[0])) return true;
  for (const match of value.matchAll(/(?:[a-f0-9]{0,4}:){2,}[a-f0-9:.]*/giu))
    if (isIP(match[0]) === 6 && reservedHost(match[0])) return true;
  return false;
}
function tokens(value: string): string[] {
  return (
    value
      .normalize('NFKC')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}
/** A source audit is necessary but cannot substitute for these public-release checks. */
export function validatePublicSafety(context: PublicSafetyContext, snapshot: string): void {
  if (
    canonicalReport(context.report).research_id !== context.report.research_id ||
    context.markdown !== renderCorpusMarkdown(context.report) ||
    canonicalJson(context.strings) !== canonicalJson(reportStrings(context.report))
  )
    reject();
  if (context.strings.some((item) => hazard(item.value))) reject();
  // Validate the literal rendered output as well as its decoded meaning-bearing values.
  const renderedText = context.markdown.replace(/&#(\d+);/gu, (_match, number: string) =>
    String.fromCodePoint(Number(number)),
  );
  if (hazard(context.markdown) || hazard(renderedText)) reject();
  const sources = new Set(
    context.report.findings.flatMap((f) =>
      f.evidence.filter((e) => e.kind === 'repository').map((e) => e.source),
    ),
  );
  const windows = new Set<string>();
  for (const source of sources) {
    const tracked = spawnSync(
      'git',
      ['-C', snapshot, '--literal-pathspecs', 'ls-files', '--error-unmatch', '--', source],
      { encoding: 'utf8' },
    );
    if (tracked.status !== 0) reject();
    let componentPath = snapshot;
    for (const component of source.split('/')) {
      componentPath = path.join(componentPath, component);
      if (fs.lstatSync(componentPath).isSymbolicLink()) reject();
    }
    const file = path.resolve(snapshot, source);
    const relative = path.relative(fs.realpathSync(snapshot), fs.realpathSync(file));
    if (
      relative.startsWith('..') ||
      path.isAbsolute(relative) ||
      !fs.lstatSync(file).isFile() ||
      fs.lstatSync(file).isSymbolicLink()
    )
      reject();
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file));
    } catch {
      reject();
    }
    if (text.includes('\0')) reject();
    for (const block of text.split(/\n\s*\n/u)) {
      const words = tokens(block);
      for (let index = 0; index + 12 <= words.length; index++)
        windows.add(words.slice(index, index + 12).join(' '));
    }
  }
  for (const item of [...context.strings, { path: '', value: renderedText }]) {
    if (/\/evidence\/\d+\/(?:source|locator)$/u.test(item.path)) continue;
    const words = tokens(item.value);
    for (let index = 0; index + 12 <= words.length; index++)
      if (windows.has(words.slice(index, index + 12).join(' '))) reject();
  }
}
export function safetyBinding(
  context: PublicSafetyContext,
  sourceDigest: string,
  input: ResearchInput,
  dispatch: string,
  owner: string,
  dispatches: string[],
): string {
  return sha256(
    canonicalJson({
      report: canonicalJson(context.report),
      markdown: context.markdown,
      sourceDigest,
      input,
      dispatch,
      owner,
      dispatches,
    }),
  );
}
export function requireSafetyAcceptance(
  acceptance: SafetyAcceptance | null,
  context: PublicSafetyContext,
  sourceDigest: string,
  input: ResearchInput,
  dispatches: string[],
  owner: string,
): void {
  if (
    !acceptance ||
    Object.keys(acceptance).sort().join(',') !== 'audit,binding,dispatch' ||
    dispatches.at(-1) !== acceptance.dispatch ||
    acceptance.binding !==
      safetyBinding(context, sourceDigest, input, acceptance.dispatch, owner, dispatches) ||
    parsePublicSafetyAudit(acceptance.audit, context).verdict !== 'safe'
  )
    reject();
}

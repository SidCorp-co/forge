import type { Finding } from './findings.js';

interface SecretRule {
  rule: string;
  pattern: RegExp;
  /** Prefix length to keep unmasked in the excerpt (e.g. 'sk-ant-' = 7). */
  prefixLen: number;
}

export const SECRET_RULES: SecretRule[] = [
  { rule: 'secret.anthropic-key', pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g, prefixLen: 7 },
  { rule: 'secret.epodsystem-key', pattern: /crmk_[A-Za-z0-9]{20,}/g, prefixLen: 5 },
  { rule: 'secret.sentry-key', pattern: /sntryu_[A-Za-z0-9]{20,}/g, prefixLen: 7 },
  { rule: 'secret.github-pat', pattern: /ghp_[A-Za-z0-9]{36}/g, prefixLen: 4 },
  { rule: 'secret.aws-access-key', pattern: /AKIA[0-9A-Z]{16}/g, prefixLen: 4 },
  {
    rule: 'secret.generic-high-entropy',
    pattern: /(?:api[_-]?key|secret|token|password)\s*[:=]\s*['"]?([A-Za-z0-9/+_-]{24,})/gi,
    prefixLen: 0,
  },
];

export const INJECTION_MARKERS: Array<{ rule: string; marker: string }> = [
  { rule: 'injection.command-name-tag', marker: '<command-name>' },
  { rule: 'injection.command-args-tag', marker: '<command-args>' },
  { rule: 'injection.system-reminder-tag', marker: '<system-reminder>' },
  { rule: 'injection.end-tag', marker: '</s>' },
  { rule: 'injection.untrusted-data-open', marker: '⟦UNTRUSTED_DATA' },
  { rule: 'injection.untrusted-data-close', marker: '⟦END_UNTRUSTED_DATA⟧' },
];

const TERMINAL_AUTO_ADVANCE = {
  rule: 'dangerous.terminal-auto-advance',
  pattern: /forge_issues?[._]update[\s\S]{0,80}status['"\s:]+(?:released|closed)/g,
};

function maskSecret(match: string, prefixLen: number): string {
  if (prefixLen > 0 && match.length > prefixLen) {
    return `${match.slice(0, prefixLen)}***`;
  }
  return '***';
}

function excerptAround(text: string, index: number, windowLen = 40): string {
  const start = Math.max(0, index - 10);
  const end = Math.min(text.length, start + windowLen);
  let snippet = text.slice(start, end);
  if (start > 0) snippet = `…${snippet}`;
  if (end < text.length) snippet = `${snippet}…`;
  return snippet;
}

function scanField(text: string, field: string): Finding[] {
  const findings: Finding[] = [];

  for (const rule of SECRET_RULES) {
    rule.pattern.lastIndex = 0;
    let m = rule.pattern.exec(text);
    while (m !== null) {
      findings.push({
        severity: 'blocker',
        rule: rule.rule,
        field,
        message: `Hardcoded secret detected (${rule.rule})`,
        excerpt: maskSecret(m[0], rule.prefixLen),
      });
      m = rule.pattern.exec(text);
    }
  }

  for (const { rule, marker } of INJECTION_MARKERS) {
    const idx = text.indexOf(marker);
    if (idx !== -1) {
      findings.push({
        severity: 'blocker',
        rule,
        field,
        message: `Prompt-injection marker detected: ${marker}`,
        excerpt: excerptAround(text, idx),
      });
    }
  }

  TERMINAL_AUTO_ADVANCE.pattern.lastIndex = 0;
  let tm = TERMINAL_AUTO_ADVANCE.pattern.exec(text);
  while (tm !== null) {
    findings.push({
      severity: 'warn',
      rule: TERMINAL_AUTO_ADVANCE.rule,
      field,
      message: 'Skill unconditionally advances issue to a terminal status (released/closed)',
      excerpt: excerptAround(text, tm.index, 60),
    });
    tm = TERMINAL_AUTO_ADVANCE.pattern.exec(text);
  }

  return findings;
}

export interface ScanSkillContentInput {
  name?: string;
  description?: string;
  skillMd: string;
}

export function scanSkillContent(input: ScanSkillContentInput): Finding[] {
  const findings: Finding[] = [];

  findings.push(...scanField(input.skillMd, 'skillMd'));

  if (input.description) {
    findings.push(...scanField(input.description, 'description'));
  }

  if (input.name) {
    findings.push(...scanField(input.name, 'name'));
  }

  return findings;
}

export type FindingSeverity = 'blocker' | 'warn';

export interface Finding {
  severity: FindingSeverity;
  rule: string;
  field: string;
  message: string;
  excerpt: string;
}

export class SkillContentBlockedError extends Error {
  readonly code = 'SKILL_CONTENT_BLOCKED';
  readonly findings: Finding[];
  constructor(findings: Finding[]) {
    super(`SKILL_CONTENT_BLOCKED: ${findings.length} blocking finding(s)`);
    this.name = 'SkillContentBlockedError';
    this.findings = findings;
  }
}

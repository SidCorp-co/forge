export type FindingSeverity = 'blocker' | 'warn';

export interface Finding {
  severity: FindingSeverity;
  rule: string;
  field: string;
  message: string;
  excerpt: string;
}

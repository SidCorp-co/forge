import type { Sql } from 'postgres';

export declare const SECRET_MARK: string;
export declare const DISCARDED_MARK: string;

export interface LegacyColumn {
  table: string;
  column: string;
  v1: string;
  discard?: boolean;
}

export declare const LEGACY_COLUMNS: LegacyColumn[];

export interface LegacyReport {
  columns: Array<LegacyColumn & { present: boolean }>;
  projects: Array<{
    id: string;
    slug: string;
    name: string;
    archived: boolean;
    legacy: Record<string, unknown>;
    bindings: Array<{
      id: string;
      provider: string;
      role: string;
      label: string | null;
      stages: string[] | null;
      rollback: { from: 'binding' | 'connection'; value: unknown } | null;
    }>;
  }>;
}

export declare function redact(value: unknown, key?: string): unknown;
export declare function presentColumns(sql: Sql): Promise<Set<string>>;
export declare function readLegacyConfig(sql: Sql): Promise<LegacyReport>;
export declare function withReadOnly<T>(url: string, fn: (tx: Sql) => Promise<T>): Promise<T>;
export declare function render(report: LegacyReport, url: string): string;

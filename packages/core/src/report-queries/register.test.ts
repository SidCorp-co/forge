import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ReportQueryAdapter } from './adapter.js';
import { registerReportQueries } from './register.js';
import { clearReportQueriesForTest, listReportQueries } from './registry.js';

afterEach(() => clearReportQueriesForTest());

// Every query this directory defines, read from its modules rather than kept here by hand: a new
// query file is covered the day it lands, and one left out of register.ts fails by name (ISS-1254).
const HERE = dirname(fileURLToPath(import.meta.url));
const isQuery = (v: unknown): v is ReportQueryAdapter =>
  typeof (v as ReportQueryAdapter | null)?.descriptor?.id === 'string' &&
  typeof (v as ReportQueryAdapter).run === 'function';
const DEFINED = new Map<string, string>();
beforeAll(async () => {
  for (const file of readdirSync(HERE).filter((f) => /^[^.]+\.ts$/.test(f))) {
    const exports = (await import(join(HERE, file))) as Record<string, unknown>;
    for (const value of Object.values(exports)) {
      for (const q of Array.isArray(value) ? value : [value])
        if (isQuery(q)) DEFINED.set(q.descriptor.id, file);
    }
  }
});

describe('registerReportQueries', () => {
  it('registers every query this directory defines, each declaring what it reads, under one shape', () => {
    registerReportQueries();
    const all = listReportQueries();
    const registered = new Set(all.map((q) => q.descriptor.id));
    expect(DEFINED.size).toBeGreaterThan(0);
    expect(
      [...DEFINED].filter(([id]) => !registered.has(id)).map(([id, file]) => `${id} (${file})`),
      'defined but not registered: add each to registerReportQueries in register.ts',
    ).toEqual([]);
    expect([...registered].filter((id) => !DEFINED.has(id))).toEqual([]);
    for (const q of all) {
      expect(q.reads.length, q.descriptor.id).toBeGreaterThan(0);
      expect(q.descriptor.permission, q.descriptor.id).toBe('project.read');
    }
  });

  it('refuses a second registration of the same set, naming the first duplicate', () => {
    registerReportQueries();
    expect(() => registerReportQueries()).toThrow(/is already registered/);
  });
});

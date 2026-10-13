import { getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as schema from '../../db/schema.js';
import { tableRow } from './rows.js';
import { renderSchema } from './schema.js';

const tables = Object.values(schema).filter((value) => is(value, PgTable)) as PgTable[];

describe('tableRow', () => {
  it('reads every table the schema declares, with no type JSON Schema cannot hold', () => {
    expect(tables.length).toBeGreaterThan(50);
    const unrepresentable = tables.flatMap((table) =>
      renderSchema(tableRow(table), 'output').unrepresentable.map(
        (at) => `${getTableName(table)}.${at}`,
      ),
    );
    expect(unrepresentable).toEqual([]);
  });

  it('names each table by its own name, so two tables never share a component', () => {
    const names = tables.map(
      (table) => Object.keys(renderSchema(tableRow(table), 'output').defs)[0],
    );
    expect(new Set(names).size).toBe(tables.length);
  });

  it('holds a table once however many routes answer with it', () => {
    const table = tables[0] as PgTable;
    expect(tableRow(table)).toBe(tableRow(table));
  });

  it('describes a column as the table declares it: a timestamp is a date-time string, a not-null column is required', () => {
    const issues = schema.issues;
    const rendered = renderSchema(tableRow(issues), 'output');
    const def = Object.values(rendered.defs)[0] as {
      properties: Record<string, Record<string, unknown>>;
      required: string[];
    };
    expect(def.properties.createdAt).toMatchObject({ type: 'string', format: 'date-time' });
    expect(def.required).toContain('id');
  });
});

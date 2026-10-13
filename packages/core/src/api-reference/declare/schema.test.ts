import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { renderSchema } from './schema.js';

describe('renderSchema', () => {
  it('renders an input as what is sent: a coerced number is a number the caller may send as text', () => {
    const { schema } = renderSchema(z.object({ n: z.coerce.number().int().min(1) }), 'input');
    expect(schema.properties).toMatchObject({ n: { type: 'integer', minimum: 1 } });
  });

  it('renders a Date as the date-time string it becomes on the wire', () => {
    const { schema, unrepresentable } = renderSchema(z.object({ at: z.date() }), 'output');
    expect(schema.properties).toMatchObject({ at: { type: 'string', format: 'date-time' } });
    expect(unrepresentable).toEqual([]);
  });

  it('names a custom check, which has no JSON Schema, instead of rendering it as accept-anything', () => {
    const { unrepresentable } = renderSchema(
      z.object({ x: z.custom<string>(() => true) }),
      'output',
    );
    expect(unrepresentable).toEqual(['properties.x:custom']);
  });

  it('names a transform in an output, where what leaves is not what was parsed', () => {
    const { unrepresentable } = renderSchema(
      z.object({ x: z.string().transform((s) => s.length) }),
      'output',
    );
    expect(unrepresentable.length).toBeGreaterThan(0);
  });

  it('does not name an optional or nullable around a type that renders', () => {
    const { unrepresentable } = renderSchema(
      z.object({ a: z.string().optional(), b: z.number().nullable(), c: z.unknown().optional() }),
      'output',
    );
    expect(unrepresentable).toEqual([]);
  });

  it('lifts a type named with an id into defs and points at components', () => {
    const named = z.object({ id: z.string() }).meta({ id: 'Thing' });
    const { schema, defs } = renderSchema(z.object({ a: named, b: named }), 'output');
    expect(Object.keys(defs)).toEqual(['Thing']);
    expect(JSON.stringify(schema)).toContain('#/components/schemas/Thing');
    expect(JSON.stringify(schema)).not.toContain('$defs');
  });
});

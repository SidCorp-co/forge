import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { codeFor, describeOperation, empty, fail, json, operationOf, raw } from './describe.js';

describe('describeOperation', () => {
  it('passes a request through untouched and registers what it declared', async () => {
    const declaration = { summary: 's', responses: { 200: json(z.object({})) } };
    const middleware = describeOperation(declaration);
    let reached = false;
    await middleware({} as never, async () => {
      reached = true;
    });
    expect(reached).toBe(true);
    expect(operationOf(middleware)).toBe(declaration);
  });

  it('refuses a status that is not an HTTP status, naming the operation', () => {
    expect(() => describeOperation({ summary: 'Odd', responses: { 700: empty() } })).toThrow(
      /"700".*Odd/,
    );
  });

  it('refuses a success answer under an error status and an error under a success one', () => {
    expect(() => describeOperation({ summary: 'A', responses: { 404: empty() } })).toThrow(
      /error status/,
    );
    expect(() => describeOperation({ summary: 'B', responses: { 200: fail('X') } })).toThrow(
      /success status/,
    );
  });

  it('allows a JSON body under an error status, for the routes whose errors are not the envelope', () => {
    expect(() =>
      describeOperation({
        summary: 'C',
        responses: { 200: raw('text/plain', 't'), 409: json(z.object({})) },
      }),
    ).not.toThrow();
  });

  it('returns undefined for a handler that declared nothing', () => {
    expect(operationOf(async () => undefined)).toBeUndefined();
  });
});

describe('fail', () => {
  it('names one code with when it happens', () => {
    expect(fail('NOT_FOUND', 'gone')).toEqual({
      kind: 'fail',
      codes: [{ code: 'NOT_FOUND', when: 'gone' }],
    });
  });

  it('names several codes for one status', () => {
    expect(fail({ A: 'a', B: 'b' }).codes).toEqual([
      { code: 'A', when: 'a' },
      { code: 'B', when: 'b' },
    ]);
  });

  it('takes the code the error handler derives from the status when none is named', () => {
    expect(codeFor(404, fail().codes[0]?.code ?? 'x')).toBe('NOT_FOUND');
    expect(codeFor(409, '')).toBe('CONFLICT');
    expect(codeFor(409, 'STALE')).toBe('STALE');
  });
});

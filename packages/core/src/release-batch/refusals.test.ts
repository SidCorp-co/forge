import type { HTTPException } from 'hono/http-exception';
import { describe, expect, it } from 'vitest';
import { undeclaredProbes } from './refusals.js';

function body(err: HTTPException): string {
  return JSON.stringify(err.cause) + err.message;
}

describe('undeclaredProbes', () => {
  it('answers 409 under the code the routes translate', () => {
    const err = undeclaredProbes();
    expect(err.status).toBe(409);
    expect(body(err)).toContain('RELEASE_PROBES_UNDECLARED');
  });

  it('names the project field as a way out', () => {
    const text = body(undeclaredProbes());
    expect(text).toContain('environments.live.commitUrl');
    expect(text).toContain('environments.live.commitPath');
  });

  it('names the binding field as the other way out', () => {
    expect(body(undeclaredProbes())).toContain('verify');
    expect(body(undeclaredProbes())).toContain('probes');
  });

  it('says what a commit path looks like, including the empty case', () => {
    const text = body(undeclaredProbes());
    expect(text).toContain('data.commit');
    expect(text).toMatch(/whole body/i);
  });

  it('says a binding declaring an unreadable verify takes no project default', () => {
    expect(body(undeclaredProbes())).toMatch(/takes NO project default/i);
  });
});

// The refusals a release answers with, judged as MESSAGES.
//
// A refusal's status code says only that something was wrong; the message is the whole deliverable,
// because it is the first and often the only thing an operator reads about a declaration they have
// never made. ISS-1069 measured what a message naming one way out costs: `sidpeak` read
// `RELEASE_PROBES_UNDECLARED`, went to declare `verify` on its binding, and needed a production
// hostname Forge held no field for — its two recorded URLs both served staging and its live address
// existed only in the Coolify UI. The shorter way out existed by then and the message did not
// mention it.

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

  // cm:guard BOTH ways out, and they are not two spellings of one instruction: one field on the
  // project answers every live binding at once, and one field per binding overrides it. An operator
  // told only about the binding is being sent the long way round, once per binding.
  it('names the project field as a way out', () => {
    const text = body(undeclaredProbes());
    expect(text).toContain('environments.live.commitUrl');
    expect(text).toContain('environments.live.commitPath');
  });

  it('names the binding field as the other way out', () => {
    expect(body(undeclaredProbes())).toContain('verify');
    expect(body(undeclaredProbes())).toContain('probes');
  });

  // cm:guard the message must say what the commit path IS, because it is the field an operator
  // cannot guess: the fleet does not agree on one shape — `sid-desk` answers `{"commit":…}` and
  // `sidpeak` answers `{"data":{"commit":…}}` — and a blank one means the whole body.
  it('says what a commit path looks like, including the empty case', () => {
    const text = body(undeclaredProbes());
    expect(text).toContain('data.commit');
    expect(text).toMatch(/whole body/i);
  });

  // cm:guard the message must NOT invite an operator to fix a broken `verify` by deleting the
  // project field, because the default never fires on a declaration `parseVerifyConfig` refused.
  // Without this sentence the refusal reads as though filling the project field would rescue a
  // malformed binding, which is exactly the silent substitution the channel code refuses to make.
  it('says a binding declaring an unreadable verify takes no project default', () => {
    expect(body(undeclaredProbes())).toMatch(/takes NO project default/i);
  });
});

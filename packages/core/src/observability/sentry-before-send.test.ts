import { DrizzleQueryError } from 'drizzle-orm/errors';
import { describe, expect, it } from 'vitest';
import { sentryBeforeSend } from './sentry.js';

describe('sentryBeforeSend', () => {
  it("sends a failed query's statement to Sentry, and none of its params", () => {
    const err = new DrizzleQueryError(
      'insert into "users" values ($1, $2)',
      ['dup@b.co', '$argon2id$x'],
      new Error('dup'),
    );
    const event = {
      breadcrumbs: [],
      exception: { values: [{ type: 'Error', value: err.message }] },
    };
    const sent = JSON.stringify(sentryBeforeSend(event, { originalException: err }));
    expect(sent).toContain('insert into');
    expect(sent).not.toMatch(/argon2|dup@b\.co/);
  });
});

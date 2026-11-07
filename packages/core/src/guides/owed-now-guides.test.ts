// @direct-test-of packages/core/src/guides/dispatch-guide.ts
// @direct-test-of packages/core/src/guides/issue-flow-guide.ts
// @direct-test-of packages/core/src/guides/requirements-guide.ts
// @direct-test-of packages/core/src/guides/suggestions-guide.ts
// The epod master read a requirement's check date as a day to start on and held an issue until it
// (ISS-1113). Every guide a master or a run reads says an owed act with a date is owed now, the date
// only its latest day.
import { describe, expect, it } from 'vitest';
import { guideRoutes } from './routes.js';

async function served(slug: string): Promise<string> {
  const res = await guideRoutes.request(`/guides/${slug}.md`);
  expect(res.status, `guide ${slug} is not served`).toBe(200);
  return (await res.text()).replace(/\s+/g, ' ');
}

describe('a dated owed act reads as owed now in the served guides', () => {
  for (const slug of ['dispatch', 'issue-flow', 'requirement-lifecycle']) {
    it(`${slug} says the date is the latest day, never one to wait for`, async () => {
      const text = await served(slug);
      expect(text).toContain('is owed now: the date is the latest day');
      expect(text).toContain('never a day to start on or to hold an issue until');
    });
  }

  it("states the breakdown's SLA as owed from the agree, at the latest its working days after", async () => {
    const text = await served('suggestions');
    expect(text).toMatch(/owes it from the agree on, at the latest \d+ working days after it/);
    expect(text).not.toMatch(/owes it within \d+ working days/);
  });
});

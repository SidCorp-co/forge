/**
 * ISS-1113 — the guidance, which the issue calls the deliverable and the gate
 * the thing behind it. A gate with no guidance teaches nothing and is met with
 * a workaround, so what the guide has to SAY is asserted here rather than left
 * to whoever writes it next.
 */

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { RECORD_DESTINATIONS, RECORD_GUIDE_SLUG } from '../messaging/record-screen.js';
import { RECORDS_GUIDE } from './records-guide.js';
import { getGuide, listGuides } from './registry.js';
import { guideRoutes } from './routes.js';

const body = RECORDS_GUIDE.body;
/** The same prose with its wrapping collapsed, so an assertion is about words and not line breaks. */
const prose = body.replace(/\s+/gu, ' ');

describe('the records-and-comments guide', () => {
  it('is served by the registry under its own slug', () => {
    expect(getGuide(RECORD_GUIDE_SLUG)).toBe(RECORDS_GUIDE);
    expect(listGuides().map((g) => g.slug)).toContain(RECORD_GUIDE_SLUG);
  });

  it('says what a comment is for', () => {
    expect(prose).toContain('A comment is prose a person reads');
  });

  it('names a store for every destination the rule routes to', () => {
    for (const route of new Set(Object.values(RECORD_DESTINATIONS))) {
      expect(body).toContain(route);
    }
  });

  it('names the store each kind of thing a run records belongs in', () => {
    for (const store of [
      'issue_step_contexts',
      'issue_attributes',
      'agent_session_turns',
      'kernel_transitions',
      'forge_memory',
      'knowledge_entries',
    ]) {
      expect(body).toContain(store);
    }
  });

  it('carries the joined-not-duplicated rule, with the column that joins them', () => {
    expect(prose).toContain('joined, not duplicated');
    expect(body).toContain('source_comment_id');
  });

  it('carries the fence-is-the-smell rule, and refuses the character cap by name', () => {
    expect(prose).toContain('A fence in a comment is the smell');
    expect(body).toContain('record-in-comment');
    expect(body).toContain('COMMENT_BODY_MAX_CHARS');
    expect(prose).toContain('not the lever');
  });

  it('states that the MCP comment door is warned and never refused, and why', () => {
    expect(prose).toContain('warned and never refused');
    expect(prose).toContain('no request context');
  });

  it('explains the dormancy the refusal is reachable through', () => {
    expect(body).toContain('x-forge-capabilities');
    expect(body).toContain('record-route');
  });
});

describe('both delivery channels', () => {
  const app = new Hono().route('/api', guideRoutes);

  it('serves the slug as markdown over REST', async () => {
    const res = await app.request(`/api/guides/${RECORD_GUIDE_SLUG}.md`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(body);
  });

  it('serves the slug as JSON over REST', async () => {
    const res = await app.request(`/api/guides/${RECORD_GUIDE_SLUG}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { guide: { slug: string } }).guide.slug).toBe(RECORD_GUIDE_SLUG);
  });

  it('is reachable through the same getGuide the forge_guide MCP tool calls', () => {
    expect(getGuide(RECORD_GUIDE_SLUG)?.body).toBe(body);
  });
});

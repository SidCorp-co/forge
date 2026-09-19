import { describe, expect, it } from 'vitest';
import { buildJobPromptString } from './user.js';

/**
 * The prompt is one of four read paths that must see the body PROJECTION rather
 * than the markup, and these are the cases that would go red if it were dropped
 * from this one. Its own file because `user.test.ts` is frozen at its size.
 */

describe('an html component description reaches the prompt as text, not markup', () => {
  const snapshot = {
    title: 'Body templates',
    description:
      '<forge-problem><forge-opening><p>Bodies are unchecked.</p></forge-opening>' +
      '<forge-who><p>Every downstream reader.</p></forge-who>' +
      '<forge-diagram kind="mermaid">flowchart LR\n  A --> B</forge-diagram>' +
      '<forge-todo><p>Validate in the kernel.</p></forge-todo>' +
      '<forge-evidence><forge-row date="2026-09-03" measured="8 of 57" source="SQL" /></forge-evidence>' +
      '</forge-problem>',
    descriptionFormat: 'html',
  };

  it('carries the prose and the mermaid source, and no forge- tag', () => {
    const out = buildJobPromptString({
      jobType: 'triage',
      issueId: 'iss-1',
      issueSnapshot: snapshot,
      policy: { includeFields: ['description'] },
    });
    expect(out).toContain('Bodies are unchecked.');
    expect(out).toContain('Every downstream reader.');
    expect(out).toContain('A --> B');
    expect(out).not.toContain('<forge-');
  });

  it('projects BEFORE the cap, so the cap bounds requirements rather than tag names', () => {
    const out = buildJobPromptString({
      jobType: 'triage',
      issueId: 'iss-1',
      issueSnapshot: snapshot,
      policy: { includeFields: ['description'], fieldCaps: { description: 120 } },
    });
    expect(out).toContain('Bodies are unchecked.');
  });

  it('leaves a markdown description exactly as it did before', () => {
    const out = buildJobPromptString({
      jobType: 'triage',
      issueId: 'iss-1',
      issueSnapshot: {
        title: 't',
        description: '## Problem\n\nIt 500s.',
        descriptionFormat: 'markdown',
      },
      policy: { includeFields: ['description'] },
    });
    expect(out).toContain('## Problem');
  });
});

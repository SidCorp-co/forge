/**
 * ISS-1388 — Pass 2 of the module-taxonomy migration is a `labels` replace-set across every tagged
 * issue, and that write takes no lease: `updateIssueFields` carries only the `sessionContext`
 * precondition, so a write over an issue a run holds lands and overwrites that run's label change
 * with no refusal. The page has to say so beside the write, and name the window that is safe.
 */

import { describe, expect, it } from 'vitest';
import { getGuide } from './registry.js';

/** The text under one `###` heading, up to the next `###` or the end of the page. */
function section(body: string, heading: string): string {
  const start = body.indexOf(`### ${heading}`);
  if (start === -1) throw new Error(`no '### ${heading}' section in the page`);
  const next = body.indexOf('\n### ', start + 1);
  return body.slice(start, next === -1 ? undefined : next);
}

function pass2(): string {
  const guide = getGuide('module-taxonomy-migration');
  if (!guide) throw new Error('module-taxonomy-migration is not a guide core serves');
  return section(guide.body, 'Pass 2 — attribute the issues');
}

describe('the Pass 2 section of the module-taxonomy-migration guide', () => {
  it('says beside the write that the pass takes no lease', () => {
    expect(pass2()).toMatch(/takes no lease/);
  });

  it('names the window a migrator can use: between waves, while no issue is held by a run', () => {
    const text = pass2();
    expect(text).toMatch(/between waves/);
    expect(text).toMatch(/no issue of the project is held by a run/);
  });

  it('keeps the REPLACES warning, in the same section as the caveat', () => {
    const text = pass2();
    expect(text).toMatch(/`labels` REPLACES the set/);
    expect(text).toMatch(/the one way this pass\s+loses data/);
  });
});

describe('the page, against the database it describes', () => {
  it('does not say label names are not unique, which labels_project_id_name_uq refuses', () => {
    const guide = getGuide('module-taxonomy-migration');
    expect(guide?.body).not.toMatch(/names are not unique/);
    expect(guide?.body).toMatch(/LABEL_NAME_TAKEN/);
  });
});

describe('that section reader, against planted pages', () => {
  it('refuses a page with no such heading, naming it', () => {
    expect(() => section('### Pass 1\nx\n', 'Pass 2 — attribute the issues')).toThrow(
      "no '### Pass 2 — attribute the issues' section in the page",
    );
  });

  it('stops at the next heading, so a caveat under a later one is not read as Pass 2', () => {
    const page = '### Pass 2 — attribute the issues\nwrite\n### Verify\ntakes no lease\n';
    expect(section(page, 'Pass 2 — attribute the issues')).not.toMatch(/takes no lease/);
  });
});

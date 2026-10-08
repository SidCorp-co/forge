import { describe, expect, it } from 'vitest';
import { A3_REPORT_QUERIES } from './phase-a-queries.js';
import { progressByRequirement } from './progress-by-requirement.js';
import { roadmapEta } from './roadmap-eta.js';

// A state column says which shared vocabulary its values are, so web draws each value as the badge
// every other screen draws it with (REQ-32 BC-3). Every `status` column of every query is listed
// here: one that names a vocabulary names the one its read returns, and one that names none is a
// decision recorded, since no shared family reads its values yet.

const ALL = [progressByRequirement, roadmapEta, ...A3_REPORT_QUERIES];

describe("the queries' state columns", () => {
  it('name the vocabulary their values belong to, or none by decision', () => {
    const declared = Object.fromEntries(
      ALL.flatMap((q) =>
        q.descriptor.output
          .filter((f) => f.type === 'status')
          .map((f) => [`${q.descriptor.id}.${f.name}`, f.vocabulary ?? null]),
      ),
    );
    expect(declared).toEqual({
      'progress-by-requirement.state': 'requirement',
      'roadmap-eta.lane': null,
      'roadmap-eta.state': 'requirement',
      'release-readiness.state': 'releaseState',
      'criteria-coverage.verdict': 'bcVerdict',
      'workflow-status.kind': null,
      'workflow-status.provenance': null,
      'workflow-status.rewrite': null,
    });
  });
});

import { describe, expect, it } from 'vitest';
import { DISPATCH_GUIDE } from './dispatch-guide.js';

// read as prose, wherever a line wraps
const prose = DISPATCH_GUIDE.body.split(/\s+/).join(' ');

// REQ-79 BC-12, BC-18 (ISS-845, FB-453): direct mode is every fast project outside strict, and it
// lands the way the project lands, so a project whose branches change only by merged MR is never
// pushed past.
describe('the dispatch guide teaches direct mode outside strict, landing by the project route', () => {
  it('selects direct mode by not strict, never by yolo alone', () => {
    expect(prose).toContain('A project whose gate profile is not `strict`');
    expect(prose).not.toContain('A project whose gate profile is `yolo`');
  });

  it('lands through a change request where the project lands by one, and pushes only where it pushes', () => {
    expect(prose).toContain('Land it by the route its project lands by');
    expect(prose).toContain('`release.changeRequests`');
    expect(prose).toContain('POST /api/projects/:id/integrations/source/change-requests');
    expect(prose).toContain('Push to the base branch only where the project lands by push');
    expect(prose).not.toContain('Push it to the base branch when');
  });
});

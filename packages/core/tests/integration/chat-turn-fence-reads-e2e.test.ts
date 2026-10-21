/**
 * A chat turn never reads another project's data, even one the person asking belongs to (REQ-30
 * BC-10; workflow design chat-turn r2, step `denied`). Both modes are planted: the Assistant's turn
 * token and an Agent session's token. The person asking owns both projects, so the project fence,
 * not the person's role, is what each refusal reads.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AskerWorld,
  addOtherProject,
  MODES,
  OTHER,
  openAskerWorld,
} from '../helpers/chat-fence-world.js';
import { closeWorld, ok, type Reply } from '../helpers/ecosystem-world.js';

let w: AskerWorld;
let other: Awaited<ReturnType<typeof addOtherProject>>;

beforeAll(async () => {
  w = await openAskerWorld();
  other = await addOtherProject(w);
}, 180_000);

afterAll(closeWorld);

/** Refused, and nothing of the other project in what came back. */
function refusedBlind(r: Reply): void {
  expect([403, 404], JSON.stringify(r.json)).toContain(r.status);
  expect(JSON.stringify(r.json)).not.toContain(OTHER);
}

const otherReads = (): [string, string][] => [
  ['its issue by id', `/api/issues/${other.issue}`],
  ['its issue by key', `/api/issues/ISS-1?projectId=${other.id}`],
  ['its requirement', `/api/projects/${other.id}/requirements/REQ-1`],
  ['its feedback', `/api/projects/${other.id}/feedback/FB-1`],
];

describe("a turn's token never reads another project the person asking belongs to", () => {
  it('the person reads each of them signed in, so the person may', async () => {
    for (const [what, path] of otherReads()) {
      const r = await w.say('person', 'GET', path);
      expect(r.status, `${what}: ${JSON.stringify(r.json)}`).toBe(200);
      expect(JSON.stringify(r.json), what).toContain(OTHER);
    }
  });

  for (const mode of MODES) {
    it(`the ${mode} token is refused each of them, and reads its own project`, async () => {
      for (const [, path] of otherReads()) refusedBlind(await w.say(`asker:${mode}`, 'GET', path));
      ok(await w.say(`asker:${mode}`, 'GET', `/api/issues/${w.homeIssue}`));
    });
  }

  it("the Assistant's own tools answer the turn's project whatever project they are named", async () => {
    const set = w.tools('asker');
    const one = await set.execute(
      'forge_requirement',
      JSON.stringify({ projectId: other.id, requirement: 'REQ-1' }),
    );
    expect(w.text(one)).not.toContain(OTHER);
    const listed = await set.execute('forge_requirements', JSON.stringify({ projectId: other.id }));
    expect(listed.isError, w.text(listed)).toBeFalsy();
    expect(w.text(listed)).toContain('Home requirement');
    expect(w.text(listed)).not.toContain(OTHER);
  });

  it('a pipeline run of the other project, named by its own id, is not found from a turn', async () => {
    const r = await w
      .tools('asker')
      .execute('forge_project_pipeline_runs', JSON.stringify({ action: 'get', runId: other.run }));
    expect(r.isError, w.text(r)).toBe(true);
    expect(w.text(r)).toContain('PIPELINE_RUN_NOT_FOUND');
    expect(w.text(r)).not.toContain(other.id);
    refusedBlind(await w.say('asker:agent', 'GET', `/api/pipeline-runs/${other.run}`));
    ok(await w.say('person', 'GET', `/api/pipeline-runs/${other.run}`));
  });
});

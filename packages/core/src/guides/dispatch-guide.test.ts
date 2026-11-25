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

  // ISS-1050: "its own tests" read as the whole suite; only the build and the related tests come first
  it('lands once the batch builds and its related tests pass, the whole suite after the push', () => {
    expect(prose).toContain(
      'as soon as the merged batch compiles with its typecheck and the tests covering the files it touched are green',
    );
    expect(prose).toContain('Every other test, lint and CI follow the push');
    expect(prose).toContain(
      'Where a project rule asks for more before the landing, that rule holds',
    );
    expect(prose).not.toContain('its own tests pass');
  });

  // ISS-1050 (REQ-79 BC-21): a batch leaves what it did not clean to the cleanup run, as debt
  it('records what a batch leaves unclean as debt, never fixed in the batch nor filed as an issue', () => {
    expect(prose).toContain(
      'What the batch leaves unclean (duplicates, code not reused, workarounds, leftovers such as raw buttons or dead components) is recorded as debt through the debts door (`POST /api/projects/:id/debts`), never fixed inside the batch and never filed as an issue',
    );
  });

  it('lands through a change request where the project lands by one, and pushes only where it pushes', () => {
    expect(prose).toContain('Land the batch once, by the route its project lands by');
    expect(prose).toContain('`release.changeRequests`');
    expect(prose).toContain('POST /api/projects/:id/integrations/source/change-requests');
    expect(prose).toContain('Push to the base branch only where the project lands by push');
    expect(prose).not.toContain('Push it to the base branch when');
  });
});

// ISS-845, batch-delivery (owner, 2026-11-01): a master works in batches split by files, never
// issue by issue; a batch lands, releases and is judged once, and no issue carries its own ceremony.
describe('the dispatch guide teaches batches by default', () => {
  it('splits a wave by files and folds what arrives mid-wave into it', () => {
    expect(prose).toContain('### 4. Batch by files');
    expect(prose).toContain('an issue that arrives while it runs joins it');
    expect(prose).toContain('issues that touch the same files ride one branch');
    expect(prose).toContain('File overlap and conflict risk are the only bound');
    expect(prose).not.toContain('Two issues that only share a file are neighbours');
    expect(prose).not.toContain('the second waits for the first to land');
  });

  it('lands, releases and judges a direct batch once, with no per-issue ceremony', () => {
    expect(prose).toContain('It works in batches');
    expect(prose).toContain('Land the batch once');
    expect(prose).toContain('No issue gets its own plan, its own full suite or its own release');
    expect(prose).toContain('the assumption written as one line');
    expect(prose).toContain('Release the batch once, on the minimum bar');
    expect(prose).toContain('one live judge pass over the batch');
    expect(prose).toContain('a red there is fixed forward in the next batch');
    // ISS-1209 (FB-610, epod L-8): a person's screen request is written out, never guessed, and
    // the judge pass checks the screen at the widths people use
    expect(prose).toContain('A screen change a person asked for is not filled by judgement');
    expect(prose).toContain('a screen is checked at the widths the qa guide');
    expect(prose).not.toContain('For each issue it takes');
    expect(prose).not.toContain('gate profile yolo');
    expect(DISPATCH_GUIDE.summary).not.toContain('yolo');
  });

  // ISS-1243 item 22 (owner, 2026-11-15): the epod master hand-built ISS-167 in its own pane for
  // 15+ minutes while a room and eight feedback issues waited, because step 2 offered "Build in this
  // session" as the first choice
  it('hands every build part to subagents and keeps the master session free to answer agents', () => {
    expect(prose).toContain('Hand every build part to a general-purpose subagent');
    expect(prose).toContain(
      "Keep this session free to triage, answer a room agent's ask before any other work (Answering a room agent's ask) and land; build in it only a change too small to brief",
    );
    expect(prose).not.toContain('Build in this session, or hand each file-disjoint part');
    expect(prose).not.toContain('Its master builds instead of dispatching');
  });

  // ISS-1254 (owner, 2026-11-16): parallel builders in one tree read each other's half-written
  // files; each builder now has its own tree off the batch branch, folded in by the master
  it('gives each builder its own worktree off the batch branch, folded and removed by the master', () => {
    expect(prose).toContain('Each builder gets its own worktree and branch off the batch branch');
    expect(prose).toContain(
      '`git worktree add -b <batch-branch>-<part> <repo>/.claude/worktrees/<batch>-<part> <batch-branch>`',
    );
    expect(prose).toContain('no two builders share a tree');
    expect(prose).toContain(
      "Fold each builder's commits into the batch branch (cherry-pick or merge) and remove its tree once it is folded",
    );
    expect(prose).not.toContain('file-disjoint part');
  });

  // ISS-1048 (owner, 2026-11-06): a master read a batch as any slice of work, split one large issue
  // into mini-batches and released each, and each live red became one more release
  // ISS-1245 (owner, 2026-11-16): a builder holds one of its project's subagent slots, so a direct
  // master declares each builder's run too, and is told by name when its project has none free
  it('declares each direct builder as a run, its slot, refused by name when none is free', () => {
    expect(prose).toContain('Declare its run first, over the issues it builds');
    expect(prose).toContain('the box refuses a builder dispatched without one');
    expect(prose).toContain('`RUN_SLOT_UNAVAILABLE`');
    expect(prose).not.toContain('no shipped role, no declaration');
  });

  // ISS-1444 (FB-843, forge-plugin L-16): a master declared and dispatched a builder on the declare
  // alone, and the issue stood at open through the build; a declare moves no status
  it("takes each declared issue's lease with its run before the builder is dispatched", () => {
    const direct = prose.slice(prose.indexOf('### Direct mode')).replace(/\s+/g, ' ');
    expect(direct).toContain(
      "take each of those issues' lease with that run before the builder is dispatched",
    );
    expect(direct).toContain("-H 'x-forge-run: <run id>'");
    expect(direct).toContain('a declare records the run and moves no status');
    expect(direct).toContain('so the issue stands at `in_progress`');
  });

  // ISS-1366 (FB-780, epod): a master declared a run, woke a finished builder with SendMessage,
  // and its next dispatch was refused as undeclared. Both the declaration step and direct mode
  // say a woken subagent takes no run, never to wake one while a declared run waits, and the way out.
  it('never wakes a finished builder while a declared run waits, and names dispatching or closing first', () => {
    const declare = prose.slice(prose.indexOf('### 6. Declare'), prose.indexOf('### 7. Fold'));
    const direct = prose.slice(prose.indexOf('### Direct mode'));
    for (const section of [declare, direct]) {
      expect(section).toContain('woken with `SendMessage` takes');
      expect(section).toMatch(
        /never wake (a finished one|one) while a (declared run|run you declared) waits for its dispatch/i,
      );
      expect(section).toContain('`forge-runner run close`');
    }
    expect(declare).toContain('dispatch first, or close the run you will not dispatch');
    expect(direct).toContain('Dispatch the new builder first, or close the waiting run');
    expect(declare).toContain('refused naming your latest run and the subagent holding it');
  });

  // ISS-1363 (FB-779, epod L-57): a run declared --role runner was refused at dispatch and its
  // issues fell back to open; (FB-778, sid-desk L-8): criteria written onto the record after landing
  it('names the role a builder run is declared as, a model refusal, and criteria on the record first', () => {
    expect(prose).toContain('`forge-runner run declare --role general-purpose`');
    expect(prose).toContain('or as another role than the one declared');
    expect(prose).toContain("naming a model the box's account allows");
    expect(prose).toContain(
      "each issue's criteria are on its record (`PUT /api/issues/:id/criteria`), never only in its description",
    );
  });

  it('never makes a batch smaller than an issue, and folds a live red into the next batch', () => {
    expect(prose).toContain('A batch is never smaller than an issue');
    expect(prose).toContain('one issue is never split across releases');
    expect(prose).toContain('a large issue is built whole');
    expect(prose).toContain('goes into the next batch, never a release of its own');
  });
});

// ISS-1243 items 20, 21: the master answers a room agent's ask before any other work, by the door
// that hands it back into the agent's session, and reads the agent's open threads before it posts
describe("the dispatch guide names the doors of a room agent's ask and its open threads", () => {
  it('names the answer door, the asks read with its bound, and the open threads read', () => {
    expect(prose).toContain("### Answering a room agent's ask");
    expect(prose).toContain('Answer it before any other work');
    expect(prose).toContain(
      '`POST /api/projects/:id/support/master-asks/:askId/answer` `{ answer }`',
    );
    expect(prose).toContain(
      '`GET /api/projects/:id/support/master-asks` lists the asks waiting on you, each with its wait, and counts those past the 10-minute bound as breached',
    );
    expect(prose).toContain('`GET /api/projects/:id/support/agent-threads`');
  });

  // ISS-1465: where an agent owns the thread it tells the result; the master's result reaches it by
  // the item's move or the ask's answer, never a master post beside it
  it('says the agent tells its thread the result, which reaches it by the item or the ask', () => {
    const section = prose.slice(prose.indexOf('### Telling a room what came of it'));
    expect(section).toContain(
      'Where a channel agent owns the thread, the agent tells its users the result, never you',
    );
    expect(section).toContain("handed into the asker's thread as a note by core as you move it");
    expect(section).toContain('master-asks/:askId/answer');
    expect(section).toContain('A result for a room with no agent in the thread');
  });
});

// ISS-861 (owner, 2026-11-01): triage writes what helps the run, and no field is a precondition
// of dispatch that core does not itself hold.
describe('the dispatch guide asks for no triage ritual', () => {
  it('holds no run back on a missing complexity and asks no confirmation record', () => {
    expect(prose).not.toContain('No run is dispatched on an issue holding no `complexity`');
    expect(prose).not.toContain('a `confirmation` record');
    expect(prose).toContain('A candidate that survives goes into the batch');
  });

  it('still names the refusals the box and core hold', () => {
    for (const kernel of ['ISSUE_SCOPE_HELD', 'ISSUE_AT_REST', 'forge-runner run declare']) {
      expect(prose).toContain(kernel);
    }
  });
});

// ISS-943: a master with a result for its project's support room found no door, and the result was
// relayed by hand as the bot. The guide names the door with its body, every room kind it takes, and
// the rules a room the product's users read keeps.
describe('the dispatch guide names the room door a master posts its own results through', () => {
  it('names the door with its body and the rooms it takes', () => {
    expect(prose).toContain(
      '`POST /api/projects/:id/support/master-posts` with `{ text, rid?, thread?, attachments? }`',
    );
    // ISS-1024: the images a post carries, named by their Forge uploads
    expect(prose).toContain('`{ target: issue | comment | session, attachmentId }`');
    for (const code of ['SUPPORT_POST_IMAGE_NOT_AN_IMAGE', 'SUPPORT_POST_IMAGE_UNREADABLE']) {
      expect(prose).toContain(code);
    }
    expect(prose).toContain("a support room, a channel agent's group, an operations room");
    expect(prose).toContain('Never relay it by hand or through a script posting as the bot');
  });

  it('names the rules of a room its users read, and each refusal', () => {
    expect(prose).toContain(
      "only in an asker's thread (one a member wrote in), never at its top level",
    );
    for (const code of [
      'SUPPORT_ROOM_UNKNOWN',
      'SUPPORT_ROOM_SWITCHED_OFF',
      'SUPPORT_THREAD_OF_ANOTHER_ROOM',
      'SUPPORT_THREAD_UNKNOWN',
      'SUPPORT_MASTER_POST_USERS_ROOM',
    ]) {
      expect(prose).toContain(code);
    }
  });

  // ISS-1433 (FB-832): a post naming no thread landed in the project's thread beside a room agent's
  // ask, and the guide never said where such a post goes, nor how to take a misplaced one back
  it('says where a post naming no thread lands in each room, never at the top level, and how to undo it', () => {
    expect(prose).toContain(
      "With none, it lands in the project's own thread its binding records in an operations room, in the report thread of any other room the team reads (Forge opens one), and a room its users read refuses it",
    );
    expect(prose).toMatch(/No master post goes at a room's top level, where [^.]+/);
    expect(prose).toContain("name the room's `reportThread` from the rooms read as `thread`");
    expect(prose).toContain('`landedIn`');
    expect(prose).toContain(
      'A post that landed in the wrong thread is deleted this way and posted where it belongs',
    );
  });
});

// ISS-1006 round 2: a decision raised before its asker was taught reads "No summary"; the master that
// finds one of its project's writes the plain text onto it, one sentence where it reads its method.
describe('the dispatch guide teaches the master to write a pending decision its plain text', () => {
  it('names the read that finds one and the door that writes it', () => {
    expect(prose).toContain(
      'An open question of this project with `plain: null` (`GET /api/questions?projectId=<id>&status=open`)',
    );
    expect(prose).toContain('write it, `PUT /api/questions/:id/plain` `{ plain }`');
    expect(prose).toContain('never let an ISS-, REQ- or BC- key carry the meaning');
  });
});

// ISS-946, ISS-1268 BR: a channel agent's session runs as a background session in its room, which
// its owner watches as a master is watched
describe('the dispatch guide gives the command that attaches to a channel agent', () => {
  it("names the room agent's attach, and no tmux pane", () => {
    expect(DISPATCH_GUIDE.body).toContain('`forge-runner chat attach <slug>`');
    expect(DISPATCH_GUIDE.body).not.toContain('forge-chat-<slug>`');
  });

  // ISS-1268: a master is a background session, opened by project rather than by pane
  it('names the command that opens a master session live', () => {
    expect(DISPATCH_GUIDE.body).toContain('`forge-runner master attach <slug>`');
    expect(DISPATCH_GUIDE.body).not.toContain('attach -t forge-master-');
  });
});

import { describe, expect, it } from 'vitest';
import {
  baDoorPersona,
  rocketChatDoorPersona,
  webAgentConversationPersona,
  webConversationPersona,
} from '../door-persona.js';

// REQ-30 BC-1 and BC-2 (chat-turn design, steps `draft`, `mode` and `repo`): each mode says when a
// question needs the other one, and why; every door that states figures names the read behind each;
// and the Agent door reads the project through the routes the reply check counts as its reads. These
// are the words the model is given. That it follows them is witnessed on the running build.

const PROJECT = { id: '7d3a3c1e-0d4b-4f6e-9c1a-5b2e8f9a0c11', name: 'Forge', slug: 'forge' };
const web = webConversationPersona(PROJECT.name, PROJECT.slug, 'owner@forge.test');
const agent = webAgentConversationPersona(PROJECT, 'owner@forge.test');
const rocket = rocketChatDoorPersona(
  { projectName: PROJECT.name, venue: 'answering in a Rocket.Chat room', projectSlug: 'forge' },
  { botName: 'Bao', authorUsername: 'linh' },
);

describe('each mode says when a question needs the other, and why', () => {
  it('Agent mode answers a question that needs no repository and names Assistant mode, with why', () => {
    expect(agent).toMatch(/A question that needs no repository[^\n]*answer it from those reads/);
    expect(agent).toMatch(
      /Assistant mode answers such a question without a paired box, because it reads the project's data on the server/,
    );
  });

  it('Assistant mode names Agent mode for a file, a function, an edit or a command, with why', () => {
    expect(web).toMatch(
      /a question about a file, a function or the code is one Agent mode answers/,
    );
    expect(web).toContain('only a paired box holds the checkout');
    expect(web).toMatch(
      /You CANNOT edit a file or run a command: that needs a session on a paired box/,
    );
  });
});

describe('the Agent door reads the project through the routes its reply check counts', () => {
  it.each([
    'projects/7d3a3c1e-0d4b-4f6e-9c1a-5b2e8f9a0c11/status',
    'projects/7d3a3c1e-0d4b-4f6e-9c1a-5b2e8f9a0c11/requirements',
    'projects/7d3a3c1e-0d4b-4f6e-9c1a-5b2e8f9a0c11/releases',
    'projects/7d3a3c1e-0d4b-4f6e-9c1a-5b2e8f9a0c11/requirements/REQ-n/decisions',
    'memory/search -X POST',
    'projects/7d3a3c1e-0d4b-4f6e-9c1a-5b2e8f9a0c11/report-queries/<query>/runs -X POST',
  ])('names %s', (route) => {
    expect(agent).toContain(route);
  });

  it('says it has none of the forge tools the shared layers name', () => {
    expect(agent).toContain('You have none of the forge tools named above');
  });
});

describe('every door that states a figure is told to name its read', () => {
  it.each([
    ['web', web],
    ['web-agent', agent],
    ['rocketchat', rocket],
  ])('%s', (_door, prompt) => {
    expect(prompt).toContain('NAME THE READ BEHIND EVERY FIGURE');
    expect(prompt).toContain(
      'A decision or a figure found only in\n  memory is answered with that date',
    );
  });

  it('the BA door', () => {
    const ba = baDoorPersona(PROJECT.name, 'REQ-30', 'owner@forge.test');
    expect(ba).toContain('names the read it came from');
  });
});

describe('the BA door records what is not its requirement, and names the other mode (REQ-30 BC-2, BC-3)', () => {
  const ba = baDoorPersona(PROJECT.name, 'REQ-30', 'Ann (project member)');
  it('sends a problem to Feedback and a new wish to a requirement suggestion, never an issue', () => {
    expect(ba).toContain('`project_feedback`');
    expect(ba).toContain('`ba_suggest_requirement`');
    expect(ba).toContain('You file no issue.');
  });
  it('says a code question needs Agent mode, and why', () => {
    expect(ba).toMatch(/needs Agent mode \(a paired device with the repository\)/);
  });
  it('carries the asker with their role', () => {
    expect(ba).toContain('Ann (project member)');
  });
});

// REQ-41 BC-25, BC-27, BC-29, BC-30: dev, 2026-10-22 (conversation a760cd5f). Told "open them for me"
// twice, the assistant answered "I cannot press approval for you"; it added ISS-616, 617, 569 and 607
// to a cluster of eight; it answered the owner's "29" with "No"; and it opened requests with "Correct".
describe("Assistant mode acts on the person's word, on exactly what was agreed", () => {
  it('makes decisions with act_on_decisions on the word in their current message, never one more', () => {
    expect(web).toContain("When the person's CURRENT message tells you to make decisions");
    expect(web).toContain(
      'make them with act_on_decisions, quoting their instruction exactly as word',
    );
    expect(web).toContain('Pass exactly the decisions the conversation agreed, never one more');
    expect(web).toContain('never say you cannot press a decision for them');
    expect(web).toContain('leave the decision cards under your reply for them to press');
  });

  it('names an item already moved on as done, with who and when, and claims nothing the tool did not return', () => {
    expect(web).toContain(
      'an item it reports already_done you name done, with who moved it and when',
    );
    expect(web).toMatch(
      /A DECISION IS DONE ONLY WHEN `act_on_decisions` SAYS SO, OR THE ITEM READS SO/,
    );
    expect(web).toContain(
      'Never recommend a decision on an item a read shows has already moved on',
    );
  });

  it('says what each count counts, never a bare "No" to their number', () => {
    expect(web).toContain('SAY WHAT EACH COUNT COUNTS');
    expect(web).toContain('never\n  answer their number with a bare "No"');
  });

  it('opens with the answer, never with "Correct" or "Yes"', () => {
    expect(web).toContain(
      'Open with the answer itself. Never open with "Correct", "Exactly", "Yes"',
    );
  });
});

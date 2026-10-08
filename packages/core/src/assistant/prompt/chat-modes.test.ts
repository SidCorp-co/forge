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

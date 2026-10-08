import { describe, expect, it } from 'vitest';
import {
  rocketChatDoorPersona,
  webAgentConversationPersona,
  webConversationPersona,
} from '../door-persona.js';
import { admitVerb } from '../tools/forge-cli-argv.js';
import { readFormsLine } from '../tools/forge-cli-forms.js';

// Owner, 2026-10-08, on an Agent-mode turn that filed ISS-395 straight from a conversation and asked
// its questions after: a person's report or wish enters as Feedback or a Requirement, issues come
// from those (triage, breakdown), and the assistant discusses before it writes anything. The prompt
// had said "ACT … file the issue with `forge new`" and carried a whole "Filing an issue" section.

const PROJECT = { id: '7d3a3c1e-0d4b-4f6e-9c1a-5b2e8f9a0c11', name: 'Forge', slug: 'forge' };
const DOORS = {
  web: webConversationPersona(PROJECT.name, PROJECT.slug, 'owner@forge.test'),
  'web-agent': webAgentConversationPersona(PROJECT, 'owner@forge.test'),
  rocketchat: rocketChatDoorPersona(
    { projectName: PROJECT.name, venue: 'answering in a Rocket.Chat room', projectSlug: 'forge' },
    { botName: 'Bao', authorUsername: 'linh' },
  ),
};

describe('every chat door routes a report or a wish to Feedback or a Requirement, never an issue', () => {
  for (const [door, prompt] of Object.entries(DOORS)) {
    it(`${door}: tells the agent to file no issue, and how to record instead`, () => {
      for (const told of [
        /forge new/,
        /(?<!just )file (the|an|a draft) issue/i,
        /capture the work as a draft issue/i,
        /### Filing an issue/,
        /ACT, do not delegate/,
        /Nothing you write here is fenced to a draft/,
      ]) {
        expect(prompt, `${door} still says ${told}`).not.toMatch(told);
      }
      for (const says of [
        'A chat never files an issue',
        'Feedback, kind `bug`',
        '`change_request`',
        'draft Requirement',
        'CHAT_FILES_FEEDBACK_NOT_ISSUES',
        'forge_feedback',
      ]) {
        expect(prompt, `${door} does not say ${says}`).toContain(says);
      }
    });

    it(`${door}: discusses before it writes, and asks the scope questions before the record`, () => {
      expect(prompt).toContain('### Discuss before writing');
      expect(prompt).toContain('what you understood');
      expect(prompt).toContain('a request for their go-ahead');
      expect(prompt).toContain('Write only after the person confirms');
      expect(prompt).toContain('comes BEFORE the record, never after it');
      expect(prompt).toContain('Asked to "just file an issue"');
    });
  }

  it('names the REST routes an Agent-mode session records through, with its project filled in', () => {
    const agent = DOORS['web-agent'];
    expect(agent).toContain(`forge-runner api projects/${PROJECT.id}/feedback -X POST`);
    expect(agent).toContain(`projects/${PROJECT.id}/requirements`);
    expect(agent).toContain(`projects/${PROJECT.id}/requirements/REQ-n/revisions`);
    expect(agent).toContain('you file no issue');
  });

  it('closes `forge new` at the chat door, naming where a record goes instead', () => {
    const refused = admitVerb(['new', '-', '--title', 'Panel width', '--category', 'feature']);
    expect(refused).toContain('a chat files no issue');
    expect(refused).toContain('forge_feedback');
    expect(refused).toContain('forge_requirement_draft');
    expect(readFormsLine()).not.toContain('new');
    expect(admitVerb(['issue', '--search', 'panel'])).toBeNull();
    expect(admitVerb(['comment', 'ISS-1', '-'])).toBeNull();
  });
});

// REQ-32 criteria 1 and 6: a question about progress is answered from the report tools and shown, never
// typed. Without this entry the model has the tools and no reason to reach for them over prose.
describe('every chat door answers a progress question from the report tools', () => {
  for (const [door, prompt] of Object.entries(DOORS)) {
    it(`${door}: names forge_report, forge_template and forge_show, bars a typed figure, and offers a link`, () => {
      for (const says of [
        'progress, the roadmap, release readiness, criteria coverage or workflow status',
        '`forge_report` and `forge_template`',
        '`forge_show`',
        'only figures the runs returned',
        'offer a share link',
      ]) {
        expect(prompt, `${door} does not say ${says}`).toContain(says);
      }
    });
  }
});

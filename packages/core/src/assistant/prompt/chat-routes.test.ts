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

describe('every chat door routes a report or a wish to Feedback or a Requirement, by judgement (ISS-861)', () => {
  for (const [door, prompt] of Object.entries(DOORS)) {
    it(`${door}: tells the agent how to record, with no rule against filing an issue`, () => {
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
      // ISS-861: the "never files an issue" absolute is cut; the gate profile's kernel refusal names itself
      for (const gone of ['A chat never files an issue', 'Asked to "just file an issue"']) {
        expect(prompt, `${door} still says ${gone}`).not.toContain(gone);
      }
      for (const says of [
        'Feedback, kind `bug`',
        '`change_request`',
        'draft Requirement',
        'project_feedback',
      ]) {
        expect(prompt, `${door} does not say ${says}`).toContain(says);
      }
    });

    it(`${door}: states that a write waits on the person, with no card ritual (ISS-861)`, () => {
      expect(prompt).toContain('### Writes wait on the person');
      expect(prompt).toContain('CHAT_WRITE_AWAITS_AGREEMENT');
      expect(prompt).toContain('CHAT_WRITE_REFUSED');
      // the hold is kernel; the scripted restatement and "press Record it" steps are gone
      for (const ritual of [
        '### Discuss before writing',
        'press Record it',
        'Only their press on the card records it.',
        'comes BEFORE the record, never after it',
      ]) {
        expect(prompt, `${door} still says ${ritual}`).not.toContain(ritual);
      }
      expect(prompt).not.toContain('forge_agree');
    });
  }

  it('names the REST routes an Agent-mode session records through, with its project filled in', () => {
    const agent = DOORS['web-agent'];
    expect(agent).toContain(`forge-runner api projects/${PROJECT.id}/feedback -X POST`);
    expect(agent).toContain(`projects/${PROJECT.id}/requirements`);
    expect(agent).toContain(`projects/${PROJECT.id}/requirements/REQ-n/revisions`);
    expect(agent).not.toContain('you file no issue');
    expect(agent).not.toContain('press Record it');
    expect(agent).toContain('nothing you send agrees for them');
    expect(agent).not.toContain('/agree');
  });

  it('closes `forge new` at the chat door, naming where a record goes instead', () => {
    const refused = admitVerb(['new', '-', '--title', 'Panel width', '--category', 'feature']);
    expect(refused).toContain('a chat files no issue');
    expect(refused).toContain('project_feedback');
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
    it(`${door}: names forge_report, forge_template, forge_show and forge_template_save, bars a typed figure, and offers a link`, () => {
      for (const says of [
        'progress, the roadmap, release readiness, criteria coverage or workflow status',
        '`forge_report` and `forge_template`',
        '`forge_show`',
        'only figures the runs returned',
        '`forge_template_save`',
        'offer a share link',
      ]) {
        expect(prompt, `${door} does not say ${says}`).toContain(says);
      }
    });
  }
});

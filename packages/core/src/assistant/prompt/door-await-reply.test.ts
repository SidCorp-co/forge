import { describe, expect, it } from 'vitest';
import {
  baDoorPersona,
  baFirstRequirementsPersona,
  webConversationPersona,
} from '../door-persona.js';
import { AWAIT_REPLY_LINE } from './await-reply-line.js';

// Every Assistant-mode web turn is offered `await_reply`, and "Waiting on you" reads only what it
// records (ISS-277). The third judge found the requirement (BA) and first-requirements rooms told of
// it by the tool's description alone, in the room type FB-88 came from; each door now says it.
describe('every door whose turns can record a wait tells the agent when to call await_reply', () => {
  const doors = {
    project: webConversationPersona('Acme', 'acme', 'Lan'),
    requirement: baDoorPersona('Acme', 'REQ-17', 'Lan'),
    firstRequirements: baFirstRequirementsPersona('Acme', 'Lan'),
  };

  for (const [door, persona] of Object.entries(doors)) {
    it(`the ${door} door names await_reply in the shared words`, () => {
      expect(persona).toContain(AWAIT_REPLY_LINE);
    });
  }

  it('the BA doors say their own asks wait on their own records, not on await_reply', () => {
    expect(doors.requirement).toMatch(
      /`ba_ask_clarification` and a questionnaire card[^\n]*own records/,
    );
    expect(doors.firstRequirements).toMatch(/questionnaire card you send waits on its own record/);
    expect(doors.requirement).toContain('only when this reply itself asks Lan something');
  });
});

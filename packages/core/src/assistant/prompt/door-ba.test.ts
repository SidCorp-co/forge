import { REQUIREMENT_REFUSAL_CODES } from '@forge/contracts/requirements';
import { describe, expect, it } from 'vitest';
import { BA_DOOR_LAYER } from './door-ba.js';

// The BA door drafts the revision a person agrees, so it is where a draft learns that an open
// question left blocking refuses the agree, by the name the agree is refused with.
describe('the BA door drafts what a revision leaves unsettled', () => {
  it('names open questions, assumptions and the refusal a blocking question earns', () => {
    for (const word of ['spec.openQuestions', 'spec.assumptions', 'REQUIREMENT_OPEN_QUESTIONS']) {
      expect(BA_DOOR_LAYER.text).toContain(word);
    }
    expect(REQUIREMENT_REFUSAL_CODES).toContain('REQUIREMENT_OPEN_QUESTIONS');
  });
});

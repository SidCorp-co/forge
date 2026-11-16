// The REST cards of the doors work comes in and is asked about through (ISS-1251): the answers on a
// reporter's own feedback about Forge, a project's onboarding and the questionnaires it asks, an
// intake answer, a person's BA room, a body preview and a report run.

import type { CapabilityCard } from '@forge/contracts/capability-cards';
import { ASSISTANT_REST_CARDS } from '../assistant/index.js';
import { BODY_REST_CARDS } from '../body/index.js';
import { FORGE_DOOR_REST_CARDS } from '../forge-door/index.js';
import { INTAKE_REST_CARDS } from '../intake/index.js';
import { ONBOARDING_REST_CARDS } from '../onboarding/index.js';
import { QUESTIONNAIRE_REST_CARDS } from '../questionnaires/index.js';
import { REPORT_REST_CARDS } from '../reports/index.js';
import { ownedBy } from './owned-cards.js';

export const INCOMING_REST_CARDS: readonly CapabilityCard[] = [
  ...ownedBy('forge-door', FORGE_DOOR_REST_CARDS),
  ...ownedBy('onboarding', ONBOARDING_REST_CARDS),
  ...ownedBy('questionnaires', QUESTIONNAIRE_REST_CARDS),
  ...ownedBy('intake', INTAKE_REST_CARDS),
  ...ownedBy('assistant', ASSISTANT_REST_CARDS),
  ...ownedBy('body', BODY_REST_CARDS),
  ...ownedBy('reports', REPORT_REST_CARDS),
];

// The kernel's built-in diagram templates, each versioned: a changed one is a new version, so a
// design drawn in an old one keeps reading the vocabulary it was approved in. A preset is a
// template of its own that names the one it is a preset of.

import {
  stateMachine,
  stateMachineFhirEncounter,
  stateMachineFhirTask,
  uxFlow,
} from './workflow-template-behaviour.js';
import {
  serviceBlueprint,
  serviceBlueprintCrossFunctional,
} from './workflow-template-blueprint.js';
import { operationalFlow } from './workflow-template-operational.js';
import type { WorkflowTemplate } from './workflow-template-schema.js';
import {
  dataFlow,
  decisionModel,
  integrationSequence,
  systemContext,
} from './workflow-template-systems.js';

export const BUILTIN_WORKFLOW_TEMPLATES: readonly WorkflowTemplate[] = [
  operationalFlow,
  serviceBlueprint,
  serviceBlueprintCrossFunctional,
  uxFlow,
  stateMachine,
  stateMachineFhirTask,
  stateMachineFhirEncounter,
  integrationSequence,
  decisionModel,
  dataFlow,
  systemContext,
];

// cm:why one entry for the meta-schema and the built-ins, so nothing resolves a project's
// templates over a registry other than the one the kernel serves

import { BUILTIN_WORKFLOW_TEMPLATES } from './workflow-template-builtins.js';
import {
  type ResolvedTemplates,
  resolveProjectTemplates as resolveOver,
} from './workflow-template-checks.js';
import type { ProjectWorkflowTemplate } from './workflow-template-schema.js';

export * from './workflow-template-builtins.js';
export * from './workflow-template-checks.js';
export * from './workflow-template-schema.js';

export function resolveProjectTemplates(
  declared: readonly ProjectWorkflowTemplate[],
  base?: string,
): ResolvedTemplates {
  return resolveOver(declared, BUILTIN_WORKFLOW_TEMPLATES, base);
}

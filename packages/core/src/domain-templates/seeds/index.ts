import type { BuiltinTemplate } from '../manifest.js';
import { genericSupportTemplate } from './generic-support.js';
import { hrmTemplate } from './hrm.js';
import { ticketingTemplate } from './ticketing.js';

export const builtinTemplates: BuiltinTemplate[] = [
  hrmTemplate,
  ticketingTemplate,
  genericSupportTemplate,
];

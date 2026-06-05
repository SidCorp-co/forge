import type { BuiltinTemplate } from '../manifest.js';
import { blogTemplate } from './blog.js';
import { ecommerceTemplate } from './ecommerce.js';
import { genericSupportTemplate } from './generic-support.js';
import { hrmTemplate } from './hrm.js';
import { landingTemplate } from './landing.js';
import { ticketingTemplate } from './ticketing.js';

export const builtinTemplates: BuiltinTemplate[] = [
  hrmTemplate,
  ticketingTemplate,
  genericSupportTemplate,
  // ISS-387 — `website` kind domain templates (Epodsystem storefronts).
  ecommerceTemplate,
  blogTemplate,
  landingTemplate,
];

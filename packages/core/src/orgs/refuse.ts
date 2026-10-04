import type { OrgRefusalCode } from '@forge/contracts/orgs';
import { refuser } from '../lib/refusal.js';

export const refuse = refuser<OrgRefusalCode>('ORG_REFUSED');

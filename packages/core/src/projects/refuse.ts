import type { ProjectRefusalCode } from '@forge/contracts/projects';
import { refuser } from '../lib/refusal.js';

export const refuse = refuser<ProjectRefusalCode>('PROJECT_REFUSED');

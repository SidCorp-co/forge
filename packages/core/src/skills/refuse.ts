import type { SkillRefusalCode } from '@forge/contracts/skills';
import { refuser } from '../lib/refusal.js';

export const refuse = refuser<SkillRefusalCode>('SKILL_REFUSED');

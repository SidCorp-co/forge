import type { JobRefusalCode } from '@forge/contracts/jobs';
import { refuser } from '../lib/refusal.js';

export const refuseJob = refuser<JobRefusalCode>('JOB_REFUSED');

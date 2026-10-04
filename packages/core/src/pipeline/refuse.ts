import type { PipelineRefusalCode } from '@forge/contracts/pipeline';
import { refuser } from '../lib/refusal.js';

/** Every pipeline refusal, at both doors, in the one refusal envelope. */
export const refusePipeline = refuser<PipelineRefusalCode>('PIPELINE_REFUSED');

/**
 * A characterization harness over the rule bodies this file's neighbour still
 * holds, run once so the migration in ISS-997 has a baseline that came from
 * EXECUTING them rather than from reading them.
 *
 * It exists only until `reply-guard.ts` is deleted, and it goes with it. What
 * survives is `messaging/legacy-verdicts.fixture.json` and the hash of the
 * source it was taken from, which is what lets a reader check that the
 * expectations were generated and not typed.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  LEGACY_KNOWN,
  LEGACY_PREFIX,
  LEGACY_PREFIXES,
  LEGACY_PROGRESS,
  LEGACY_SEGMENT_SETS,
  LEGACY_TEXTS,
  LEGACY_TOOL_CALLS,
} from '../../messaging/legacy-corpus.js';
import {
  checkProgressClaims,
  detectEmptyPromise,
  extractIssueClaims,
  judgeIssueClaims,
  lintStakeholderReply,
  screenCarriedComment,
  screenOperatorMessage,
  turnCreatedIssue,
} from './reply-guard.js';

const SOURCE = fileURLToPath(new URL('./reply-guard.ts', import.meta.url));

export interface LegacyVerdicts {
  source: string;
  sourceSha256: string;
  rows: Array<{ rule: string; input: string; verdict: unknown }>;
}

const key = (...parts: unknown[]): string => parts.map((p) => JSON.stringify(p)).join(' | ');

export function characterizeLegacyRules(): LegacyVerdicts {
  const rows: LegacyVerdicts['rows'] = [];
  const add = (rule: string, input: string, verdict: unknown) =>
    rows.push({ rule, input, verdict });

  for (const text of LEGACY_TEXTS) {
    add(
      'extractIssueClaims',
      key(text, LEGACY_PREFIXES),
      extractIssueClaims(text, LEGACY_PREFIXES),
    );
    add('detectEmptyPromise', key(text), detectEmptyPromise(text));
    add('screenCarriedComment', key(text), screenCarriedComment(text));
    for (const skipIssueIdRule of [false, true]) {
      add(
        'lintStakeholderReply',
        key(text, skipIssueIdRule),
        lintStakeholderReply(text, {
          verifiedSeqs: LEGACY_KNOWN.seqs,
          skipIssueIdRule,
          prefix: LEGACY_PREFIX,
          prefixes: LEGACY_PREFIXES,
        }),
      );
    }
    for (const facts of LEGACY_PROGRESS) {
      add('checkProgressClaims', key(text, facts), checkProgressClaims(text, facts));
    }
    for (const toolCalls of LEGACY_TOOL_CALLS) {
      add(
        'judgeIssueClaims',
        key(text, toolCalls),
        judgeIssueClaims(
          extractIssueClaims(text, LEGACY_PREFIXES),
          LEGACY_KNOWN,
          [...toolCalls],
          LEGACY_PREFIX,
        ),
      );
    }
  }
  for (const toolCalls of LEGACY_TOOL_CALLS) {
    add('turnCreatedIssue', key(toolCalls), turnCreatedIssue([...toolCalls]));
  }
  for (const segments of LEGACY_SEGMENT_SETS) {
    add('screenOperatorMessage', key(segments), screenOperatorMessage([...segments]));
  }

  return {
    source: 'packages/core/src/integrations/rocketchat/reply-guard.ts',
    sourceSha256: createHash('sha256').update(readFileSync(SOURCE)).digest('hex'),
    rows,
  };
}

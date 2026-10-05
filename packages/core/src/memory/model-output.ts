import crypto from 'node:crypto';
import { logger } from '../lib/logger.js';
import { foreignScriptChars } from './script-guard.js';

const FACT_CATEGORIES = new Set(['preference', 'correction', 'convention', 'tool_pattern']);

/** The category the model named when it is one a fact may carry, else `convention`. */
export function factCategory(category: unknown): string {
  return FACT_CATEGORIES.has(category as string) ? (category as string) : 'convention';
}

/** The 12-hex sha1 a model-written fact's `sourceRef` is keyed on. */
export function shortHash(text: string): string {
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 12);
}

/** The model's JSON answer with any ``` fence stripped; `undefined` when it does not parse. */
export function parseFencedJson<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw.replace(/^```json?\s*/, '').replace(/\s*```$/, '')) as T;
  } catch {
    return undefined;
  }
}

/** The first `max` items of a list the model may have answered as anything at all. */
export function firstItems<T>(items: T[] | undefined, max: number): T[] {
  return (Array.isArray(items) ? items : []).slice(0, max);
}

export interface ScriptRefuser {
  refuse(text: string, what: string): boolean;
  readonly count: number;
}

/**
 * The ISS-962 script check, bound to one run's prompt and its log name.
 *
 * Both writers here rewrite prose that is already stored rather than admitting
 * new prose, so both compute the allowance the same way and share this.
 */
export function scriptRefuser(
  projectId: string,
  promptSource: string,
  logName: string,
): ScriptRefuser {
  let refused = 0;
  return {
    refuse(text: string, what: string): boolean {
      const chars = foreignScriptChars(text, promptSource);
      if (chars.length === 0) return false;
      refused++;
      logger.warn(
        { projectId, what, chars, text: text.slice(0, 60) },
        `${logName}: refused output in a script its prompt never showed it`,
      );
      return true;
    },
    get count(): number {
      return refused;
    },
  };
}

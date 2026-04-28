/**
 * Password strength evaluation via zxcvbn-ts.
 *
 * The minimum acceptable score is 2 ("somewhat guessable" — withstands
 * online attacks at moderate rate). Score 3+ is preferred but rejecting
 * everything below 3 makes signup feel hostile; stick with 2 as the
 * floor and surface the score on the registration form so users can
 * voluntarily strengthen weak choices.
 */

import { zxcvbn, zxcvbnOptions, type ZxcvbnResult } from '@zxcvbn-ts/core';
import * as zxcvbnCommonPackage from '@zxcvbn-ts/language-common';
import * as zxcvbnEnPackage from '@zxcvbn-ts/language-en';

let configured = false;
function ensureConfigured(): void {
  if (configured) return;
  zxcvbnOptions.setOptions({
    translations: zxcvbnEnPackage.translations,
    graphs: zxcvbnCommonPackage.adjacencyGraphs,
    dictionary: {
      ...zxcvbnCommonPackage.dictionary,
      ...zxcvbnEnPackage.dictionary,
    },
  });
  configured = true;
}

export const MIN_PASSWORD_SCORE = 2;

export interface PasswordStrength {
  score: 0 | 1 | 2 | 3 | 4;
  /** Best single-line piece of feedback to surface, e.g. "Add another word or two." */
  warning: string;
  suggestions: string[];
}

export function evaluatePasswordStrength(
  password: string,
  userInputs: string[] = [],
): PasswordStrength {
  ensureConfigured();
  const result: ZxcvbnResult = zxcvbn(password, userInputs);
  return {
    score: result.score,
    warning: result.feedback.warning ?? '',
    suggestions: result.feedback.suggestions ?? [],
  };
}

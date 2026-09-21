import { ZxcvbnFactory, type ZxcvbnResult } from '@zxcvbn-ts/core';
import * as zxcvbnCommonPackage from '@zxcvbn-ts/language-common';
import * as zxcvbnEnPackage from '@zxcvbn-ts/language-en';

let factory: ZxcvbnFactory | null = null;
function getFactory(): ZxcvbnFactory {
  if (factory) return factory;
  factory = new ZxcvbnFactory({
    translations: zxcvbnEnPackage.translations,
    graphs: zxcvbnCommonPackage.adjacencyGraphs,
    dictionary: {
      ...zxcvbnCommonPackage.dictionary,
      ...zxcvbnEnPackage.dictionary,
    },
  });
  return factory;
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
  const result: ZxcvbnResult = getFactory().check(password, userInputs);
  return {
    score: result.score,
    warning: result.feedback.warning ?? '',
    suggestions: result.feedback.suggestions ?? [],
  };
}

/**
 * What an option line looks like in a rendered question.
 *
 * It lives with the contract rather than with a transport because it is a
 * property of asking a person to choose, not of any one room: wherever a reply
 * resolves a choice by the line it sits on, a label that renders as its own
 * option line offers a choice nobody wrote (ISS-978 criterion 28).
 */

export const OPTION_LINE_RE = /^\s*\d+(-\d+)?\s*[.)]/;

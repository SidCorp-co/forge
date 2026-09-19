import { isIgnoredComment } from "../line-metrics.js";

export const NARRATION_PATTERNS = [
  /\b(?:used to|formerly|previously)\b/i,
  /\b(?:before|after) (?:the )?(?:change|refactor|rewrite|migration)\b/i,
  /\b(?:old|previous) (?:logic|flow|implementation|behavior|behaviour|code path|version|approach|design|default|setting|limit|cap|field|endpoint|surface|retry policy|tail tap)\b/i,
  /\b(?:changed|updated|rewritten) (?:logic|implementation|flow|behavior|behaviour)\b/i,
  /\b(?:retained|kept|left) for (?:historical )?reference only\b/i,
  /\b(?:ported|migrated|copied) from\b/i,
  /\bno longer (?:uses?|calls?|accepts?|rejects?|refuses?|requires?|supports?|owns?|handles?)\b/i,
  /\b(?:was|were) (?:REST|API|CLI|frontend|backend|server|client|provider)-only\b/i,
  /\b(?:see above|ditto)\b/i,
  /\b(?:git (?:history|log)|commit history)\b/i,
];

/**
 * Comments addressed to whoever picks the work up next. They read as narration
 * to every later reader, but only a repository built by multiple agents or a
 * staged migration produces them, so a project can switch the group off.
 */
export const HANDOFF_PATTERNS = [
  /\b(?:M\d+[a-z]?\s+(?:service\s+)?agents?|Slice \d+)\b/i,
  /\b(?:sibling|parallel|later|service) agents?\b/i,
  /\bteam lead (?:merges?|merged|will merge)\b/i,
];

function compile(sources) {
  return sources.map((source) => (source instanceof RegExp ? source : new RegExp(source, "i")));
}

/** The offending phrase, so a report is actionable without reopening the file. */
export function findNarration(text, patterns = [...NARRATION_PATTERNS, ...HANDOFF_PATTERNS]) {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return match[0];
  }
  return null;
}

export function isHistoricalNarration(text, patterns = [...NARRATION_PATTERNS, ...HANDOFF_PATTERNS]) {
  return findNarration(text, patterns) !== null;
}

function normaliseComment(comment) {
  return comment.value.replace(/^\s*\*\s?/gm, "").replace(/\s+/g, " ").trim();
}

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Reject stale historical narration and redundant cross-references in comments",
      recommended: true,
    },
    schema: [
      {
        type: "object",
        properties: {
          handoffNarration: { type: "boolean" },
          additionalPatterns: { type: "array", items: { type: "string" } },
          allowPatterns: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      historicalNarration:
        'Comment narrates history ("{{match}}"). State the current constraint in its place, or delete the comment.',
    },
  },
  create(context) {
    const {
      handoffNarration = true,
      additionalPatterns = [],
      allowPatterns = [],
    } = context.options[0] ?? {};
    const patterns = [
      ...NARRATION_PATTERNS,
      ...(handoffNarration ? HANDOFF_PATTERNS : []),
      ...compile(additionalPatterns),
    ];
    const allowed = compile(allowPatterns);

    return {
      "Program:exit"() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (comment.type === "Shebang" || isIgnoredComment(comment)) continue;
          const text = normaliseComment(comment);
          if (allowed.some((pattern) => pattern.test(text))) continue;
          const match = findNarration(text, patterns);
          if (match === null) continue;
          context.report({ loc: comment.loc, messageId: "historicalNarration", data: { match } });
        }
      },
    };
  },
};

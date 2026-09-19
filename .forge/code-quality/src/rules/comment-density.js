import { getLineMetrics, longestConsecutiveRun } from "../line-metrics.js";

export default {
  meta: {
    type: "suggestion",
    docs: { description: "Limit comment lines relative to code lines", recommended: true },
    schema: [
      {
        type: "object",
        properties: {
          maxRatio: { type: "number", minimum: 0 },
          minCommentLines: { type: "integer", minimum: 0 },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      excessiveDensity:
        "Delete {{excess}} comment {{lineWord}}: {{codeLines}} code lines allow {{budget}} at {{maxRatio}}, this file has {{commentLines}}.",
    },
  },
  create(context) {
    const { maxRatio = 0.15, minCommentLines = 0 } = context.options[0] ?? {};
    return {
      "Program:exit"(node) {
        const metrics = getLineMetrics(context.sourceCode);
        if (metrics.commentLines.size < minCommentLines) return;
        const ratio = metrics.codeLines.size === 0 ? Number.POSITIVE_INFINITY : metrics.commentLines.size / metrics.codeLines.size;
        if (ratio <= maxRatio) return;
        // The densest block is where the deletions are, so the report points
        // there rather than at the program node the ratio was computed over.
        const run = longestConsecutiveRun(metrics.commentLines);
        const loc = run.length === 0
          ? node.loc
          : {
              start: { line: run[0], column: 0 },
              end: { line: run.at(-1), column: context.sourceCode.lines[run.at(-1) - 1].length },
            };
        // The budget in lines, not the ratio it came from: a reader who has to divide to learn
        // how many comments to cut does that arithmetic on every report.
        const budget = Math.floor(maxRatio * metrics.codeLines.size);
        const excess = metrics.commentLines.size - budget;
        context.report({
          loc,
          messageId: "excessiveDensity",
          data: {
            excess,
            lineWord: excess === 1 ? "line" : "lines",
            budget,
            commentLines: metrics.commentLines.size,
            codeLines: metrics.codeLines.size,
            maxRatio,
          },
        });
      },
    };
  },
};

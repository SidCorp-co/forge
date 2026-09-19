import { getLineMetrics, longestConsecutiveRun } from "../line-metrics.js";

export default {
  meta: {
    type: "suggestion",
    docs: { description: "Limit consecutive physical comment lines", recommended: true },
    schema: [
      {
        type: "object",
        properties: { max: { type: "integer", minimum: 0 } },
        additionalProperties: false,
      },
    ],
    messages: {
      tooManyConsecutive:
        "Break this run: {{count}} consecutive comment lines against a maximum of {{max}}, so {{excess}} too many.",
    },
  },
  create(context) {
    const { max = 8 } = context.options[0] ?? {};
    return {
      "Program:exit"() {
        const run = longestConsecutiveRun(getLineMetrics(context.sourceCode).commentLines);
        if (run.length <= max) return;
        context.report({
          loc: {
            start: { line: run[0], column: 0 },
            end: { line: run.at(-1), column: context.sourceCode.lines[run.at(-1) - 1].length },
          },
          messageId: "tooManyConsecutive",
          data: { count: run.length, max, excess: run.length - max },
        });
      },
    };
  },
};

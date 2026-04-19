import type { ForgeTool } from '../../tools';
import {
  strapiGet,
  getJwt,
  formatResponse,
  paginate,
  qs,
} from '../helpers';

export function createPerformanceTool(): ForgeTool {
  return {
    name: "hrm_performance",
    description:
      "Query performance data. Actions: cycles (review cycles), assessments (for a cycle, optionally by employee), goals (employee goals with progress).",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["cycles", "assessments", "goals"],
          description: "Action to perform",
        },
        cycleId: { type: "string", description: "Review cycle documentId" },
        employeeId: { type: "string", description: "Employee documentId" },
        status: { type: "string", description: "Filter by status" },
        page: { type: "number" },
        pageSize: { type: "number" },
      },
      required: ["action"],
    },
    async execute(input, ctx) {
      const jwt = getJwt(ctx);
      const action = input.action as string;

      if (action === "cycles") {
        const parts: string[] = [];
        if (input.status) parts.push(`filters[status][$eq]=${encodeURIComponent(input.status as string)}`);
        const endpoint = `/review-cycles${qs(parts.join("&"), paginate(input.page as number, input.pageSize as number), "sort=createdAt:desc")}`;
        const res = await strapiGet(ctx.hrmBaseUrl!, endpoint, jwt, ctx.signal);
        return formatResponse(res.data, res.ok, res.status);
      }

      if (action === "assessments") {
        if (!input.cycleId) return "Error: cycleId is required";
        const parts: string[] = [`filters[reviewCycle][documentId][$eq]=${input.cycleId}`];
        if (input.employeeId) parts.push(`filters[employee][documentId][$eq]=${input.employeeId}`);
        const endpoint = `/assessments${qs(parts.join("&"), paginate(input.page as number, input.pageSize as number), "populate=employee,reviewer")}`;
        const res = await strapiGet(ctx.hrmBaseUrl!, endpoint, jwt, ctx.signal);
        return formatResponse(res.data, res.ok, res.status);
      }

      if (action === "goals") {
        if (!input.employeeId) return "Error: employeeId is required";
        const endpoint = `/goals${qs(
          `filters[employee][documentId][$eq]=${input.employeeId}`,
          paginate(input.page as number, input.pageSize as number),
          "sort=createdAt:desc",
        )}`;
        const res = await strapiGet(ctx.hrmBaseUrl!, endpoint, jwt, ctx.signal);
        return formatResponse(res.data, res.ok, res.status);
      }

      return "Error: unknown action";
    },
  };
}

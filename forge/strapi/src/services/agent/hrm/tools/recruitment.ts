import type { ForgeTool } from '../../tools';
import {
  strapiGet,
  getJwt,
  formatResponse,
  paginate,
  qs,
} from '../helpers';

export function createRecruitmentTool(): ForgeTool {
  return {
    name: "hrm_recruitment",
    description:
      "Query recruitment data. Actions: postings (job postings), applications (for a posting), pipeline (stage summary with counts).",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["postings", "applications", "pipeline"],
          description: "Action to perform",
        },
        postingId: { type: "string", description: "Job posting documentId" },
        status: { type: "string", description: "Filter by status" },
        department: { type: "string", description: "Filter postings by department" },
        stage: { type: "string", description: "Filter applications by stage" },
        page: { type: "number" },
        pageSize: { type: "number" },
      },
      required: ["action"],
    },
    async execute(input, ctx) {
      const jwt = getJwt(ctx);
      const action = input.action as string;

      if (action === "postings") {
        const parts: string[] = [];
        if (input.status) parts.push(`filters[status][$eq]=${encodeURIComponent(input.status as string)}`);
        if (input.department) parts.push(`filters[department][name][$eq]=${encodeURIComponent(input.department as string)}`);
        const endpoint = `/job-postings${qs(parts.join("&"), paginate(input.page as number, input.pageSize as number), "populate=department", "sort=createdAt:desc")}`;
        const res = await strapiGet(ctx.hrmBaseUrl!, endpoint, jwt, ctx.signal);
        return formatResponse(res.data, res.ok, res.status);
      }

      if (action === "applications") {
        if (!input.postingId) return "Error: postingId is required";
        const parts: string[] = [`filters[jobPosting][documentId][$eq]=${input.postingId}`];
        if (input.status) parts.push(`filters[status][$eq]=${encodeURIComponent(input.status as string)}`);
        if (input.stage) parts.push(`filters[stage][$eq]=${encodeURIComponent(input.stage as string)}`);
        const endpoint = `/applications${qs(parts.join("&"), paginate(input.page as number, input.pageSize as number), "populate=candidate", "sort=createdAt:desc")}`;
        const res = await strapiGet(ctx.hrmBaseUrl!, endpoint, jwt, ctx.signal);
        return formatResponse(res.data, res.ok, res.status);
      }

      if (action === "pipeline") {
        if (!input.postingId) return "Error: postingId is required";
        const endpoint = `/applications${qs(
          `filters[jobPosting][documentId][$eq]=${input.postingId}`,
          "pagination[pageSize]=100",
        )}`;
        const res = await strapiGet(ctx.hrmBaseUrl!, endpoint, jwt, ctx.signal);
        if (!res.ok) return formatResponse(res.data, res.ok, res.status);
        const apps = ((res.data as any)?.data ?? []) as any[];
        const stages: Record<string, number> = {};
        for (const app of apps) {
          const stage = app.stage ?? "unknown";
          stages[stage] = (stages[stage] ?? 0) + 1;
        }
        return JSON.stringify({ postingId: input.postingId, pipeline: stages, total: apps.length }, null, 2);
      }

      return "Error: unknown action";
    },
  };
}

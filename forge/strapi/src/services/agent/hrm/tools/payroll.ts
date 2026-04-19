import type { ForgeTool } from '../../tools';
import {
  strapiGet,
  getJwt,
  formatResponse,
  paginate,
  qs,
} from '../helpers';

export function createPayrollTool(): ForgeTool {
  return {
    name: "hrm_payroll",
    description:
      "Query payroll data. Actions: runs (list payroll runs), payslip (employee payslip for a period), salary (current salary structure).",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["runs", "payslip", "salary"],
          description: "Action to perform",
        },
        employeeId: { type: "string", description: "Employee documentId" },
        period: { type: "string", description: "Period YYYY-MM" },
        status: { type: "string", description: "Filter runs by status" },
        page: { type: "number" },
        pageSize: { type: "number" },
      },
      required: ["action"],
    },
    async execute(input, ctx) {
      const jwt = getJwt(ctx);
      const action = input.action as string;

      if (action === "runs") {
        const parts: string[] = [];
        if (input.status) parts.push(`filters[status][$eq]=${encodeURIComponent(input.status as string)}`);
        const endpoint = `/payroll-runs${qs(parts.join("&"), paginate(input.page as number, input.pageSize as number), "sort=createdAt:desc")}`;
        const res = await strapiGet(ctx.hrmBaseUrl!, endpoint, jwt, ctx.signal);
        return formatResponse(res.data, res.ok, res.status);
      }

      if (action === "payslip") {
        if (!input.employeeId || !input.period) return "Error: employeeId and period (YYYY-MM) are required";
        const endpoint = `/payslips${qs(
          `filters[employee][documentId][$eq]=${input.employeeId}`,
          `filters[period][$eq]=${input.period}`,
          "populate=employee,earnings,deductions",
        )}`;
        const res = await strapiGet(ctx.hrmBaseUrl!, endpoint, jwt, ctx.signal);
        return formatResponse(res.data, res.ok, res.status);
      }

      if (action === "salary") {
        if (!input.employeeId) return "Error: employeeId is required";
        const endpoint = `/salary-structures${qs(
          `filters[employee][documentId][$eq]=${input.employeeId}`,
          "populate=components",
          "sort=effectiveDate:desc",
          "pagination[pageSize]=1",
        )}`;
        const res = await strapiGet(ctx.hrmBaseUrl!, endpoint, jwt, ctx.signal);
        return formatResponse(res.data, res.ok, res.status);
      }

      return "Error: unknown action";
    },
  };
}

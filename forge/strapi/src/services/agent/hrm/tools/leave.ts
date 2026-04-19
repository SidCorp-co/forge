import type { ForgeTool } from '../../tools';
import {
  strapiGet,
  strapiPost,
  getJwt,
  formatResponse,
  paginate,
  qs,
} from '../helpers';

export function createLeaveTool(): ForgeTool {
  return {
    name: "hrm_leave",
    description:
      "Manage leave data. Actions: balances (employee leave balances), requests (list leave requests), request_create (submit new request), request_action (approve/reject).",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["balances", "requests", "request_create", "request_action"],
          description: "Action to perform",
        },
        employeeId: { type: "string", description: "Employee documentId" },
        leaveTypeId: { type: "string", description: "Leave type documentId (for request_create)" },
        startDate: { type: "string", description: "Start date YYYY-MM-DD" },
        endDate: { type: "string", description: "End date YYYY-MM-DD" },
        reason: { type: "string", description: "Reason for leave" },
        isHalfDay: { type: "boolean", description: "Half day leave" },
        status: { type: "string", description: "Filter by status (pending, approved, rejected)" },
        requestId: { type: "string", description: "Leave request documentId (for request_action)" },
        requestAction: { type: "string", enum: ["approve", "reject"], description: "Approve or reject" },
        comments: { type: "string", description: "Action comments" },
        page: { type: "number" },
        pageSize: { type: "number" },
      },
      required: ["action"],
    },
    async execute(input, ctx) {
      const jwt = getJwt(ctx);
      const action = input.action as string;

      if (action === "balances") {
        const empId = input.employeeId as string;
        if (!empId) return "Error: employeeId is required";
        const endpoint = `/leave-balances${qs(`filters[employee][documentId][$eq]=${empId}`, "populate=leaveType")}`;
        const res = await strapiGet(ctx.hrmBaseUrl!, endpoint, jwt, ctx.signal);
        return formatResponse(res.data, res.ok, res.status);
      }

      if (action === "requests") {
        const parts: string[] = [];
        if (input.status) parts.push(`filters[status][$eq]=${encodeURIComponent(input.status as string)}`);
        if (input.employeeId) parts.push(`filters[employee][documentId][$eq]=${input.employeeId}`);
        if (input.startDate) parts.push(`filters[startDate][$gte]=${input.startDate}`);
        if (input.endDate) parts.push(`filters[endDate][$lte]=${input.endDate}`);
        const endpoint = `/leave-requests${qs(parts.join("&"), paginate(input.page as number, input.pageSize as number), "populate=employee,leaveType", "sort=createdAt:desc")}`;
        const res = await strapiGet(ctx.hrmBaseUrl!, endpoint, jwt, ctx.signal);
        return formatResponse(res.data, res.ok, res.status);
      }

      if (action === "request_create") {
        if (!input.employeeId || !input.leaveTypeId || !input.startDate || !input.endDate)
          return "Error: employeeId, leaveTypeId, startDate, endDate are required";
        const body = {
          data: {
            employee: input.employeeId,
            leaveType: input.leaveTypeId,
            startDate: input.startDate,
            endDate: input.endDate,
            reason: input.reason ?? "",
            isHalfDay: input.isHalfDay ?? false,
            status: "pending",
          },
        };
        const res = await strapiPost(ctx.hrmBaseUrl!, "/leave-requests", body, jwt, ctx.signal);
        return formatResponse(res.data, res.ok, res.status);
      }

      if (action === "request_action") {
        if (!input.requestId || !input.requestAction) return "Error: requestId and requestAction are required";
        const body = {
          data: {
            status: input.requestAction === "approve" ? "approved" : "rejected",
            reviewComments: input.comments ?? "",
          },
        };
        const res = await strapiPost(ctx.hrmBaseUrl!, `/leave-requests/${input.requestId}`, body, jwt, ctx.signal, "PUT");
        return formatResponse(res.data, res.ok, res.status);
      }

      return "Error: unknown action";
    },
  };
}

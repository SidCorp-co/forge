import type { ForgeTool } from '../../tools';
import {
  strapiGet,
  getJwt,
  formatResponse,
  paginate,
  qs,
} from '../helpers';

export function createEmployeesTool(): ForgeTool {
  return {
    name: "hrm_employees",
    description:
      "Query employee data. Actions: list (with filters), get (by documentId), search (by name/email/employeeId).",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "get", "search"],
          description: "Action to perform",
        },
        documentId: {
          type: "string",
          description: "Employee documentId (for 'get')",
        },
        query: {
          type: "string",
          description: "Search query (for 'search')",
        },
        department: { type: "string", description: "Filter by department name" },
        status: { type: "string", description: "Filter by status (active, inactive, terminated)" },
        location: { type: "string", description: "Filter by location name" },
        employmentType: { type: "string", description: "Filter by employment type" },
        page: { type: "number", description: "Page number (default 1)" },
        pageSize: { type: "number", description: "Page size (default 25)" },
      },
      required: ["action"],
    },
    async execute(input, ctx) {
      const jwt = getJwt(ctx);
      const action = input.action as string;

      if (action === "get") {
        const id = input.documentId as string;
        if (!id) return "Error: documentId is required for 'get' action";
        const endpoint = `/employees/${id}${qs("populate=department,position,location,manager")}`;
        const res = await strapiGet(ctx.hrmBaseUrl!, endpoint, jwt, ctx.signal);
        return formatResponse(res.data, res.ok, res.status);
      }

      if (action === "search") {
        const q = input.query as string;
        if (!q) return "Error: query is required for 'search' action";
        const filters = [
          `filters[$or][0][firstName][$containsi]=${encodeURIComponent(q)}`,
          `filters[$or][1][lastName][$containsi]=${encodeURIComponent(q)}`,
          `filters[$or][2][email][$containsi]=${encodeURIComponent(q)}`,
          `filters[$or][3][employeeId][$containsi]=${encodeURIComponent(q)}`,
        ].join("&");
        const endpoint = `/employees${qs(filters, paginate(input.page as number, input.pageSize as number), "populate=department,position")}`;
        const res = await strapiGet(ctx.hrmBaseUrl!, endpoint, jwt, ctx.signal);
        return formatResponse(res.data, res.ok, res.status);
      }

      // list
      const filterParts: string[] = [];
      if (input.department) filterParts.push(`filters[department][name][$eq]=${encodeURIComponent(input.department as string)}`);
      if (input.status) filterParts.push(`filters[status][$eq]=${encodeURIComponent(input.status as string)}`);
      if (input.location) filterParts.push(`filters[location][name][$eq]=${encodeURIComponent(input.location as string)}`);
      if (input.employmentType) filterParts.push(`filters[employmentType][$eq]=${encodeURIComponent(input.employmentType as string)}`);

      const endpoint = `/employees${qs(filterParts.join("&"), paginate(input.page as number, input.pageSize as number), "populate=department,position")}`;
      const res = await strapiGet(ctx.hrmBaseUrl!, endpoint, jwt, ctx.signal);
      return formatResponse(res.data, res.ok, res.status);
    },
  };
}

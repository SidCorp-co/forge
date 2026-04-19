import type { ForgeTool } from '../../tools';
import {
  strapiGet,
  getJwt,
  formatResponse,
  paginate,
  qs,
} from '../helpers';

export function createOrganizationTool(): ForgeTool {
  return {
    name: "hrm_organization",
    description:
      "Query org structure. Actions: departments (with headcount), positions (with salary bands), locations (with employee count), org_chart (hierarchical tree for a department).",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["departments", "positions", "locations", "org_chart"],
          description: "Action to perform",
        },
        departmentId: { type: "string", description: "Department documentId (for org_chart)" },
        page: { type: "number" },
        pageSize: { type: "number" },
      },
      required: ["action"],
    },
    async execute(input, ctx) {
      const jwt = getJwt(ctx);
      const action = input.action as string;

      if (action === "departments") {
        const endpoint = `/departments${qs(paginate(input.page as number, input.pageSize as number), "populate=employees")}`;
        const res = await strapiGet(ctx.hrmBaseUrl!, endpoint, jwt, ctx.signal);
        if (!res.ok) return formatResponse(res.data, res.ok, res.status);
        // Add headcount
        const depts = ((res.data as any)?.data ?? []) as any[];
        const result = depts.map((d: any) => ({
          ...d,
          headcount: Array.isArray(d.employees) ? d.employees.length : 0,
          employees: undefined, // don't return full employee list
        }));
        return JSON.stringify({ data: result, meta: (res.data as any)?.meta }, null, 2);
      }

      if (action === "positions") {
        const endpoint = `/positions${qs(paginate(input.page as number, input.pageSize as number), "populate=department")}`;
        const res = await strapiGet(ctx.hrmBaseUrl!, endpoint, jwt, ctx.signal);
        return formatResponse(res.data, res.ok, res.status);
      }

      if (action === "locations") {
        const endpoint = `/locations${qs(paginate(input.page as number, input.pageSize as number), "populate=employees")}`;
        const res = await strapiGet(ctx.hrmBaseUrl!, endpoint, jwt, ctx.signal);
        if (!res.ok) return formatResponse(res.data, res.ok, res.status);
        const locs = ((res.data as any)?.data ?? []) as any[];
        const result = locs.map((l: any) => ({
          ...l,
          employeeCount: Array.isArray(l.employees) ? l.employees.length : 0,
          employees: undefined,
        }));
        return JSON.stringify({ data: result, meta: (res.data as any)?.meta }, null, 2);
      }

      if (action === "org_chart") {
        if (!input.departmentId) return "Error: departmentId is required";
        const endpoint = `/employees${qs(
          `filters[department][documentId][$eq]=${input.departmentId}`,
          "populate=position,manager",
          "pagination[pageSize]=100",
        )}`;
        const res = await strapiGet(ctx.hrmBaseUrl!, endpoint, jwt, ctx.signal);
        if (!res.ok) return formatResponse(res.data, res.ok, res.status);
        const employees = ((res.data as any)?.data ?? []) as any[];
        // Build tree
        const byId = new Map<string, any>();
        for (const e of employees) {
          byId.set(e.documentId, { id: e.documentId, name: `${e.firstName ?? ""} ${e.lastName ?? ""}`.trim(), position: e.position?.name, children: [] });
        }
        const roots: any[] = [];
        for (const e of employees) {
          const node = byId.get(e.documentId)!;
          const managerId = e.manager?.documentId;
          if (managerId && byId.has(managerId)) {
            byId.get(managerId)!.children.push(node);
          } else {
            roots.push(node);
          }
        }
        return JSON.stringify(roots, null, 2);
      }

      return "Error: unknown action";
    },
  };
}

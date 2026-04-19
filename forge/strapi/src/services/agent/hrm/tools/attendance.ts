import type { ForgeTool } from '../../tools';
import {
  strapiGet,
  strapiPost,
  getJwt,
  formatResponse,
  paginate,
  qs,
} from '../helpers';

export function createAttendanceTool(): ForgeTool {
  return {
    name: "hrm_attendance",
    description:
      "Manage attendance. Actions: records (list records), summary (monthly aggregated stats), clock_in, clock_out.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["records", "summary", "clock_in", "clock_out"],
          description: "Action to perform",
        },
        employeeId: { type: "string", description: "Employee documentId" },
        startDate: { type: "string", description: "Start date YYYY-MM-DD" },
        endDate: { type: "string", description: "End date YYYY-MM-DD" },
        month: { type: "string", description: "Month YYYY-MM (for summary)" },
        status: { type: "string", description: "Filter by status" },
        timestamp: { type: "string", description: "ISO timestamp for clock_in/clock_out" },
        note: { type: "string", description: "Note for clock_in/clock_out" },
        page: { type: "number" },
        pageSize: { type: "number" },
      },
      required: ["action"],
    },
    async execute(input, ctx) {
      const jwt = getJwt(ctx);
      const action = input.action as string;

      if (action === "records") {
        const parts: string[] = [];
        if (input.employeeId) parts.push(`filters[employee][documentId][$eq]=${input.employeeId}`);
        if (input.startDate) parts.push(`filters[date][$gte]=${input.startDate}`);
        if (input.endDate) parts.push(`filters[date][$lte]=${input.endDate}`);
        if (input.status) parts.push(`filters[status][$eq]=${encodeURIComponent(input.status as string)}`);
        const endpoint = `/attendance-records${qs(parts.join("&"), paginate(input.page as number, input.pageSize as number), "populate=employee", "sort=date:desc")}`;
        const res = await strapiGet(ctx.hrmBaseUrl!, endpoint, jwt, ctx.signal);
        return formatResponse(res.data, res.ok, res.status);
      }

      if (action === "summary") {
        if (!input.employeeId || !input.month) return "Error: employeeId and month (YYYY-MM) are required";
        const [year, mo] = (input.month as string).split("-");
        const startDate = `${year}-${mo}-01`;
        const lastDay = new Date(Number(year), Number(mo), 0).getDate();
        const endDate = `${year}-${mo}-${String(lastDay).padStart(2, "0")}`;
        const endpoint = `/attendance-records${qs(
          `filters[employee][documentId][$eq]=${input.employeeId}`,
          `filters[date][$gte]=${startDate}`,
          `filters[date][$lte]=${endDate}`,
          "populate=employee",
          "pagination[pageSize]=100",
        )}`;
        const res = await strapiGet(ctx.hrmBaseUrl!, endpoint, jwt, ctx.signal);
        if (!res.ok) return formatResponse(res.data, res.ok, res.status);

        // Aggregate
        const records = ((res.data as any)?.data ?? []) as any[];
        const summary = {
          month: input.month,
          employeeId: input.employeeId,
          totalRecords: records.length,
          presentDays: records.filter((r: any) => r.status === "present" || r.status === "late").length,
          absentDays: records.filter((r: any) => r.status === "absent").length,
          lateDays: records.filter((r: any) => r.status === "late").length,
          totalHours: records.reduce((sum: number, r: any) => sum + (r.hoursWorked ?? 0), 0),
        };
        return JSON.stringify(summary, null, 2);
      }

      if (action === "clock_in" || action === "clock_out") {
        if (!input.employeeId) return "Error: employeeId is required";
        const body = {
          data: {
            employee: input.employeeId,
            [action === "clock_in" ? "checkIn" : "checkOut"]: input.timestamp ?? new Date().toISOString(),
            date: ((input.timestamp as string) ?? new Date().toISOString()).slice(0, 10),
            note: input.note ?? "",
          },
        };
        if (action === "clock_in") {
          const res = await strapiPost(ctx.hrmBaseUrl!, "/attendance-records", body, jwt, ctx.signal);
          return formatResponse(res.data, res.ok, res.status);
        }
        // clock_out: find today's record and update
        const today = ((input.timestamp as string) ?? new Date().toISOString()).slice(0, 10);
        const findEndpoint = `/attendance-records${qs(
          `filters[employee][documentId][$eq]=${input.employeeId}`,
          `filters[date][$eq]=${today}`,
          "sort=createdAt:desc",
          "pagination[pageSize]=1",
        )}`;
        const findRes = await strapiGet(ctx.hrmBaseUrl!, findEndpoint, jwt, ctx.signal);
        const records = ((findRes.data as any)?.data ?? []) as any[];
        if (records.length === 0) return "Error: no clock-in record found for today";
        const recordId = records[0].documentId;
        const res = await strapiPost(ctx.hrmBaseUrl!, `/attendance-records/${recordId}`, body, jwt, ctx.signal, "PUT");
        return formatResponse(res.data, res.ok, res.status);
      }

      return "Error: unknown action";
    },
  };
}

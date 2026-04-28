import { ChatView } from "@/components/chat-view";
import type { AgentMessage } from "@/lib/types";

const mockMessages: AgentMessage[] = [
  {
    id: "u1",
    type: "user",
    timestamp: Date.now(),
    content:
      "Implement payslip settings feature with **backend** and **frontend** changes:\n\n" +
      "### Backend\n" +
      "- Add `getPayslipSettings` and `updatePayslipSettings` endpoints\n" +
      "- Gate `myPayslips` and `ytdSummary` behind `employeeCanView` setting\n\n" +
      "### Frontend\n" +
      "- Add toggle in payroll config page\n" +
      "- Conditionally render `RecentPayslips`",
  },
  {
    id: "a1",
    type: "assistant",
    timestamp: Date.now(),
    content:
      "I'll implement this in two phases. Let me start by reading the existing code.\n\n" +
      "First, I'll check the tenant controller and payslip controller.",
    blocks: [
      {
        type: "text",
        text: "I'll implement this in two phases. Let me start by reading the existing code.",
      },
      {
        type: "tool",
        toolCall: {
          id: "t1",
          name: "Read",
          input: { file_path: "backend/src/api/tenant/controllers/tenant.ts" },
          output: "export default {\n  async find(ctx) {\n    // existing code...\n  }\n}",
        },
      },
      {
        type: "tool",
        toolCall: {
          id: "t2",
          name: "Read",
          input: { file_path: "backend/src/api/payslip/controllers/payslip.ts" },
          output: "export default {\n  async myPayslips(ctx) {\n    // existing code...\n  }\n}",
        },
      },
      {
        type: "tool",
        toolCall: {
          id: "t3",
          name: "Grep",
          input: { pattern: "employeeCanView", path: "backend/src" },
          output: "No matches found",
        },
      },
      {
        type: "text",
        text:
          "Good, the setting doesn't exist yet. Now I'll add the backend endpoints.\n\n" +
          "### Adding `getPayslipSettings` and `updatePayslipSettings`\n\n" +
          "The settings will be stored in the tenant's `settings` JSON field:",
      },
      {
        type: "tool",
        toolCall: {
          id: "t4",
          name: "Edit",
          input: {
            file_path: "backend/src/api/tenant/controllers/tenant.ts",
            old_string: "export default {",
            new_string:
              "export default {\n" +
              "  async getPayslipSettings(ctx) {\n" +
              '    const tenant = await strapi.documents("api::tenant.tenant").findOne({\n' +
              "      documentId: ctx.state.user.tenant.documentId,\n" +
              "    });\n" +
              "    ctx.body = tenant.settings?.payslip ?? { employeeCanView: true };\n" +
              "  },\n\n" +
              "  async updatePayslipSettings(ctx) {\n" +
              "    const { employeeCanView } = ctx.request.body;\n" +
              '    await strapi.documents("api::tenant.tenant").update({\n' +
              "      documentId: ctx.state.user.tenant.documentId,\n" +
              "      data: { settings: { payslip: { employeeCanView } } },\n" +
              "    });\n" +
              "    ctx.body = { employeeCanView };\n" +
              "  },",
          },
          output:
            "--- a/backend/src/api/tenant/controllers/tenant.ts\n" +
            "+++ b/backend/src/api/tenant/controllers/tenant.ts\n" +
            "@@ -1,1 +1,16 @@\n" +
            "-export default {\n" +
            "+export default {\n" +
            "+  async getPayslipSettings(ctx) {\n" +
            '+    const tenant = await strapi.documents("api::tenant.tenant").findOne({\n' +
            "+      documentId: ctx.state.user.tenant.documentId,\n" +
            "+    });\n" +
            "+    ctx.body = tenant.settings?.payslip ?? { employeeCanView: true };\n" +
            "+  },\n" +
            "+\n" +
            "+  async updatePayslipSettings(ctx) {\n" +
            "+    const { employeeCanView } = ctx.request.body;\n" +
            '+    await strapi.documents("api::tenant.tenant").update({\n' +
            "+      documentId: ctx.state.user.tenant.documentId,\n" +
            "+      data: { settings: { payslip: { employeeCanView } } },\n" +
            "+    });\n" +
            "+    ctx.body = { employeeCanView };\n" +
            "+  },",
        },
      },
      {
        type: "tool",
        toolCall: {
          id: "t5",
          name: "Write",
          input: { file_path: "backend/src/api/tenant/routes/custom-routes.ts" },
          output:
            'import { factories } from "@strapi/strapi";\n\n' +
            "export default {\n" +
            "  routes: [\n" +
            "    {\n" +
            '      method: "GET",\n' +
            '      path: "/tenants/me/payslip-settings",\n' +
            '      handler: "tenant.getPayslipSettings",\n' +
            "    },\n" +
            "    {\n" +
            '      method: "PUT",\n' +
            '      path: "/tenants/me/payslip-settings",\n' +
            '      handler: "tenant.updatePayslipSettings",\n' +
            "    },\n" +
            "  ],\n" +
            "};",
        },
      },
      {
        type: "text",
        text:
          "Now let me update the frontend:\n\n" +
          "```tsx\n" +
          "export function usePayslipSettings() {\n" +
          '  return useQuery({ queryKey: ["payslip-settings"] });\n' +
          "}\n" +
          "```\n\n" +
          "> This hook fetches the setting from the API.",
      },
      {
        type: "tool",
        toolCall: {
          id: "t6",
          name: "Bash",
          input: { command: "npm run typecheck" },
          output: "No errors found.\n\nDone in 3.2s",
        },
      },
      {
        type: "text",
        text: "All checks pass. Let me run the tests to verify.",
      },
      {
        type: "tool",
        toolCall: {
          id: "t7",
          name: "Bash",
          input: { command: "npm test -- --run" },
          output: "Tests: 42 passed, 0 failed\nTime: 5.1s",
        },
      },
    ],
  },
  {
    id: "s1",
    type: "system",
    timestamp: Date.now(),
    content:
      "All done. Here's a summary of what was implemented:\n\n" +
      "## Changes Summary\n\n" +
      "### Backend\n" +
      "- **`backend/src/api/tenant/controllers/tenant.ts`** — Added `getPayslipSettings` and `updatePayslipSettings` endpoints\n" +
      "- **`backend/src/api/tenant/routes/custom-routes.ts`** — Added `GET/PUT /tenants/me/payslip-settings` routes\n" +
      "- **`backend/src/api/payslip/controllers/payslip.ts`** — `myPayslips` and `ytdSummary` now check `employeeCanView`\n\n" +
      "### Frontend\n" +
      "- **`frontend/src/features/settings/api/index.ts`** — Added `payslipSettingsApi`\n" +
      "- **`frontend/src/features/settings/hooks/use-payslip-settings.ts`** — New hook\n" +
      "- **`frontend/src/app/(tenant)/settings/payroll-config/page.tsx`** — Added toggle",
    subtype: "result",
  },
];

export function ChatPreview() {
  return (
    <div className="flex h-screen flex-col">
      <div className="flex items-center justify-between border-b border-gray-200 bg-white px-6 py-3">
        <div>
          <h1 className="text-lg font-bold text-gray-900">Chat UI Preview</h1>
          <p className="text-xs text-gray-500">Mock data — no backend required</p>
        </div>
      </div>
      <ChatView messages={mockMessages} />
      <div className="border-t border-[#333333] bg-[#111111] px-4 py-3">
        <div className="mx-auto flex max-w-3xl gap-2">
          <input
            type="text"
            placeholder="Send a message..."
            className="flex-1 rounded border border-[#333333] bg-[#0c0c0c] px-4 py-2 font-mono text-sm text-[#cccccc] placeholder-[#555555] focus:border-[#666666] focus:outline-none"
          />
          <button className="rounded bg-[#333333] px-4 py-2 font-mono text-sm text-[#cccccc] hover:bg-[#444444]">Send</button>
          <button title="Resume in Claude CLI" className="rounded bg-[#222222] px-3 py-2 font-mono text-sm text-[#888888] hover:bg-[#333333] hover:text-[#cccccc]">CLI</button>
        </div>
      </div>
    </div>
  );
}

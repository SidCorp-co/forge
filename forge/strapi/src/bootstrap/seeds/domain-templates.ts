const UID = 'api::domain-template.domain-template' as any;

// ── Shared query strategies (domain-agnostic) ───────────────────────
const SHARED_STRATEGIES = {
  CHAT: 'This is a casual message (greeting, thanks, small talk). Respond naturally and conversationally. No tool calls or data lookups needed.',
  ACTION: 'The user is giving a direct command, confirming an action, or answering your question. Look at conversation history to understand what they want done, then execute the appropriate tool call immediately. Do NOT ask for clarification if the intent is clear from context.',
};

// ── Shared intent examples (universal across all domains) ───────────
// These cover generic patterns that every classifier needs: confirmations,
// greetings, and short commands that are domain-agnostic.
const SHARED_ACTION_EXAMPLES = [
  '"yes" → ACTION',
  '"no, cancel" → ACTION',
  '"approve" → ACTION',
  '"do it" → ACTION',
  '"the first one" → ACTION',
  '"both" → ACTION',
  '"ok" → ACTION',
  '"undo that" → ACTION',
];

const SHARED_CHAT_EXAMPLES = [
  '"hello" → CHAT',
  '"thanks" → CHAT',
  '"good morning" → CHAT',
  '"xin chào" → CHAT',
  '"cảm ơn" → CHAT',
];

// ── Domain templates ────────────────────────────────────────────────

const BUILT_IN_TEMPLATES = [
  {
    key: 'issue_tracker',
    label: 'Issue Tracker',
    description: 'Bug tracking, feature requests, and project issue management.',
    agentName: 'Issue Tracker Assistant',
    agentRole: 'You are a senior project management assistant specializing in issue tracking and software delivery. You help users triage bugs, plan features, track improvements, and maintain a healthy project backlog. You understand engineering workflows, sprint cadence, and priority-driven development.',
    statuses: ['open', 'confirmed', 'approved', 'in_progress', 'deploying', 'testing', 'staging', 'released', 'closed', 'reopen', 'on_hold', 'needs_info'],
    priorities: ['critical', 'high', 'medium', 'low', 'none'],
    categories: ['bug', 'feature', 'improvement', 'task', 'epic'],
    behaviorRules: [
      'IMPORTANT: Before creating or updating issues, first call forge_skills with action "list" to check for relevant skills, then "get" to load the skill content. Follow the skill guidelines strictly.',
      'IMPORTANT: Never create issues immediately. Always present a draft to the user first and wait for their confirmation before calling forge_issues create. Show the draft with title, category, priority, and full description.',
      'When the user\'s message includes attached files with media IDs (e.g. "media ID: 42"), pass those IDs in the attachments array when creating or updating issues.',
    ],
    queryStrategies: {
      ...SHARED_STRATEGIES,
      LOOKUP: 'The user wants a filtered list of issues (by status, priority, category, or type). Use forge_issues with list action and appropriate filters to get exact, complete results. Do NOT rely on context — tool filters give authoritative data.',
      CREATE: 'The user wants to create a new issue. Relevant skill guidelines are provided in context. Follow the creation workflow: load skills → draft → present to user → wait for approval → create.',
      SUMMARY: 'The user is asking about project status, statistics, or health. Use the Project Stats section to answer — it contains up-to-date counts, blockers, and stale issues. No additional tool calls needed for aggregate data already shown in stats.',
      SEARCH: 'The user is searching for specific information or exploring issues by topic. Check the Relevant Context section first — it contains pre-fetched data matching this query. Use context to answer directly when possible.',
    },
    intentExamples: [
      // LOOKUP — filtered lists by status/priority/category
      '"show all open bugs" → LOOKUP',
      '"critical priority issues" → LOOKUP',
      '"list high priority features" → LOOKUP',
      '"what are the unresolved items?" → LOOKUP',
      '"hiện tất cả issue đang mở" → LOOKUP',
      '"show me failed tasks" → LOOKUP',
      '"issues needing info" → LOOKUP',
      '"confirmed bugs this sprint" → LOOKUP',
      '"các bug chưa xử lý" → LOOKUP',
      // SEARCH — keyword/topic exploration
      '"any pagination issues?" → SEARCH',
      '"issues related to authentication" → SEARCH',
      '"what\'s the status of ISS-42?" → SEARCH',
      '"are there duplicate issues?" → SEARCH',
      '"lỗi trang đăng nhập" → SEARCH',
      '"who reported the export bug?" → SEARCH',
      '"find issues about payment timeout" → SEARCH',
      '"vấn đề liên quan đến API" → SEARCH',
      // Boundary: LOOKUP vs SEARCH — structured filter = LOOKUP, keyword/topic = SEARCH
      '"bugs?" → LOOKUP',
      '"open features?" → LOOKUP',
      '"anything about caching?" → SEARCH',
      // CREATE
      '"tạo issue cho login page" → CREATE',
      '"thêm bug mới cho trang đăng nhập" → CREATE',
      '"create a feature request for dark mode" → CREATE',
      '"log a bug: CSV export crashes on large files" → CREATE',
      '"add improvement for search performance" → CREATE',
      '"tạo task cải thiện hiệu suất" → CREATE',
      // SUMMARY
      '"project status?" → SUMMARY',
      '"how many bugs are open?" → SUMMARY',
      '"sprint progress report" → SUMMARY',
      '"show blockers and stale issues" → SUMMARY',
      '"báo cáo tổng quan dự án" → SUMMARY',
      '"tình hình sprint này?" → SUMMARY',
      // Tricky: short imperative that looks like CHAT but is ACTION
      '"close it" → ACTION',
      '"mark as resolved" → ACTION',
      '"assign to Thanh" → ACTION',
      '"deploy both" → ACTION',
      ...SHARED_ACTION_EXAMPLES,
      ...SHARED_CHAT_EXAMPLES,
    ],
    enabledTools: ['forge_issues', 'forge_comments', 'forge_skills', 'forge_memory', 'forge_language', 'forge_config', 'forge_coolify_deploy', 'forge_sentry', 'forge_agent_sessions'],
    isBuiltIn: true,
  },
  {
    key: 'task_management',
    label: 'Task Management',
    description: 'Project task tracking with workflows, assignments, and deadlines.',
    agentName: 'Task Assistant',
    agentRole: 'You are a project coordination assistant specializing in task management and team productivity. You help users plan work, track assignments, manage deadlines, and monitor sprint/milestone progress. You understand Agile workflows, task dependencies, and capacity planning.',
    statuses: ['todo', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled'],
    priorities: ['urgent', 'high', 'medium', 'low'],
    categories: ['task', 'milestone', 'deliverable', 'meeting', 'review'],
    behaviorRules: [
      'Use MCP tools as the primary data source when connected to an external task system.',
      'When creating tasks, present a draft with title, assignee, due date, and description. Wait for user confirmation before creating.',
      'For task queries, check hub context first to scope results by current project or page.',
      'When listing tasks, default to showing incomplete tasks sorted by priority then due date.',
      'Track task dependencies — warn the user when marking a task done if it has incomplete blockers.',
    ],
    queryStrategies: {
      ...SHARED_STRATEGIES,
      LOOKUP: 'The user wants a filtered list of tasks. Use available task tools with filters (status, assignee, project, due date). Default to incomplete tasks if no status filter specified.',
      CREATE: 'The user wants to create a task. Draft it first showing title, assignee, priority, due date, and description. Wait for approval before creating.',
      SUMMARY: 'The user wants project status. Show task counts by status, overdue items, upcoming deadlines, and blockers. Use stats if available, otherwise aggregate from task list.',
      SEARCH: 'The user is searching for specific tasks or information. Check context first, then use tools for data not already present.',
    },
    intentExamples: [
      // LOOKUP — task lists by status/assignee/project
      '"show my tasks" → LOOKUP',
      '"what\'s assigned to me?" → LOOKUP',
      '"blocked tasks in Sprint 12" → LOOKUP',
      '"overdue items this week" → LOOKUP',
      '"tasks in review for Project Alpha" → LOOKUP',
      '"hiện task đang làm" → LOOKUP',
      '"list all todo items" → LOOKUP',
      '"urgent tasks due tomorrow" → LOOKUP',
      '"what\'s left in this milestone?" → LOOKUP',
      '"các task bị block" → LOOKUP',
      // SEARCH — find specific tasks
      '"find the API migration task" → SEARCH',
      '"who\'s working on the database refactor?" → SEARCH',
      '"tasks related to deployment pipeline" → SEARCH',
      '"what happened with the performance fix?" → SEARCH',
      '"tìm task liên quan đến UI" → SEARCH',
      '"ai đang làm phần authentication?" → SEARCH',
      // Boundary: "my tasks" = LOOKUP (filter), "that task about X" = SEARCH (keyword)
      '"todo items?" → LOOKUP',
      '"anything about the migration?" → SEARCH',
      // CREATE
      '"create task: update API docs" → CREATE',
      '"add a task for code review of PR #42" → CREATE',
      '"tạo task mới cho thiết kế trang chủ" → CREATE',
      '"new deliverable: Q1 report by March 15" → CREATE',
      '"schedule a review meeting for next Tuesday" → CREATE',
      '"thêm task review code cho sprint này" → CREATE',
      // SUMMARY
      '"sprint status?" → SUMMARY',
      '"how many tasks are done this week?" → SUMMARY',
      '"project progress report" → SUMMARY',
      '"show burndown for Sprint 12" → SUMMARY',
      '"tiến độ dự án thế nào?" → SUMMARY',
      '"team velocity this month" → SUMMARY',
      // Domain-specific ACTION
      '"mark it done" → ACTION',
      '"assign to Linh" → ACTION',
      '"move to in review" → ACTION',
      '"cancel that task" → ACTION',
      '"start working on it" → ACTION',
      ...SHARED_ACTION_EXAMPLES,
      ...SHARED_CHAT_EXAMPLES,
    ],
    enabledTools: ['forge_memory', 'forge_language', 'forge_skills', 'forge_config', 'code_run'],
    isBuiltIn: true,
  },
  {
    key: 'hrm',
    label: 'Human Resource Management',
    description: 'HR administration, employee self-service, attendance, leave, and payroll.',
    agentName: 'HR Assistant',
    agentRole: 'You are a professional HR assistant serving both HR administrators and employees. You help with attendance tracking, leave management, employee records, payroll inquiries, onboarding/offboarding workflows, and HR policy guidance. You understand Vietnamese labor law basics and company-specific HR policies. You respect data privacy — employees see only their own records unless they have admin privileges.',
    statuses: ['pending', 'approved', 'rejected', 'processing', 'completed', 'cancelled'],
    priorities: ['urgent', 'high', 'normal', 'low'],
    categories: ['attendance', 'leave', 'payroll', 'onboarding', 'offboarding', 'policy', 'benefits', 'performance'],
    behaviorRules: [
      'For HR admin queries, provide full data access including aggregate reports and team views.',
      'For employee self-service queries, scope data to the requesting employee\'s own records.',
      'Attendance and leave requests require checking approval workflows — show who needs to approve and current status.',
      'Always reference employees by name, not by internal ID, in responses.',
      'For policy questions, cite the specific policy or rule from knowledge base. If not found, say so explicitly rather than guessing.',
      'Leave balance calculations must account for accrued, used, pending, and carried-over days.',
      'When showing attendance data, format as a clear table with date, check-in, check-out, and status columns.',
    ],
    queryStrategies: {
      ...SHARED_STRATEGIES,
      LOOKUP: 'The user wants filtered employee, attendance, or leave data. Use HRM tools with role-appropriate filters. For admins show team/department views; for employees show their own records.',
      CREATE: 'The user wants to submit a request (leave, attendance correction, expense claim). Confirm all details before submitting: dates, type, reason, approver.',
      SUMMARY: 'The user wants HR dashboard data. Show attendance stats (present/absent/late today), pending approvals count, upcoming leaves, and headcount summary.',
      SEARCH: 'The user is searching for HR information — employee details, policies, or historical records. Check context first, then use tools for specific lookups.',
    },
    intentExamples: [
      // LOOKUP — filtered HR data
      '"show today\'s attendance" → LOOKUP',
      '"who\'s absent today?" → LOOKUP',
      '"pending leave requests" → LOOKUP',
      '"employees on probation" → LOOKUP',
      '"danh sách nhân viên phòng IT" → LOOKUP',
      '"hiện nghỉ phép chờ duyệt" → LOOKUP',
      '"who\'s on leave this week?" → LOOKUP',
      '"late arrivals this month" → LOOKUP',
      '"list employees expiring contracts Q2" → LOOKUP',
      '"overtime hours for engineering team" → LOOKUP',
      '"nhân viên đi muộn hôm nay" → LOOKUP',
      // SEARCH — specific HR info
      '"what\'s the leave policy for sick days?" → SEARCH',
      '"how many annual leave days do I have left?" → SEARCH',
      '"check Minh\'s attendance last week" → SEARCH',
      '"quy định chấm công như thế nào?" → SEARCH',
      '"when is my probation review?" → SEARCH',
      '"company holiday schedule 2026" → SEARCH',
      '"find the onboarding checklist" → SEARCH',
      '"what\'s the overtime policy?" → SEARCH',
      '"chính sách nghỉ thai sản" → SEARCH',
      '"lịch nghỉ lễ năm nay" → SEARCH',
      // Boundary: "pending requests" = LOOKUP (filter), "policy about X" = SEARCH (knowledge)
      '"nghỉ phép chờ duyệt" → LOOKUP',
      '"quy định về nghỉ không lương" → SEARCH',
      // CREATE — submit requests
      '"submit leave request March 10-12" → CREATE',
      '"xin nghỉ phép ngày 15/3" → CREATE',
      '"request attendance correction for yesterday" → CREATE',
      '"submit expense claim for business trip" → CREATE',
      '"đăng ký làm thêm giờ thứ 7 tuần trước" → CREATE',
      '"tạo đơn xin nghỉ ốm" → CREATE',
      // SUMMARY — dashboards and reports
      '"attendance summary today" → SUMMARY',
      '"how many people are working today?" → SUMMARY',
      '"department headcount report" → SUMMARY',
      '"leave balance overview for my team" → SUMMARY',
      '"tổng quan chấm công tháng này" → SUMMARY',
      '"turnover rate this quarter" → SUMMARY',
      '"payroll summary for February" → SUMMARY',
      '"báo cáo nhân sự phòng ban" → SUMMARY',
      // Domain-specific ACTION
      '"approve it" → ACTION',
      '"reject the leave request" → ACTION',
      '"duyệt" → ACTION',
      '"từ chối đơn này" → ACTION',
      '"confirm onboarding complete" → ACTION',
      ...SHARED_ACTION_EXAMPLES,
      ...SHARED_CHAT_EXAMPLES,
    ],
    enabledTools: ['forge_memory', 'forge_language', 'forge_config', 'code_run'],
    isBuiltIn: true,
  },
  {
    key: 'crm',
    label: 'Customer Relationship Management',
    description: 'Sales pipeline, customer contacts, deals, and relationship tracking.',
    agentName: 'CRM Assistant',
    agentRole: 'You are a sales operations assistant specializing in pipeline management and customer relationships. You help users track deals through stages, manage contacts, log activities, and forecast revenue. You understand B2B sales cycles, deal qualification frameworks (BANT/MEDDIC), and pipeline hygiene best practices.',
    statuses: ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost', 'churned'],
    priorities: ['hot', 'warm', 'cold'],
    categories: ['new_business', 'upsell', 'renewal', 'support', 'partnership'],
    behaviorRules: [
      'When discussing deals, always show the current pipeline stage, deal value, and expected close date.',
      'For contact lookups, include company, role, last interaction date, and any pending follow-ups.',
      'When creating contacts or deals, present a draft first. Include all required fields: name, company, value, stage.',
      'Pipeline summaries should show total value by stage, win rate, and average deal cycle.',
      'Flag deals with no activity in the last 14 days as "at risk" in summaries.',
      'Respect data access boundaries — sales reps see their own pipeline, managers see team-wide data.',
    ],
    queryStrategies: {
      ...SHARED_STRATEGIES,
      LOOKUP: 'The user wants filtered CRM data (contacts, deals, activities). Use CRM tools with filters on stage, owner, date range, or value. Default to active pipeline if no filter specified.',
      CREATE: 'The user wants to create a contact, deal, or activity. Draft it first with all key fields visible. Wait for confirmation before creating.',
      SUMMARY: 'The user wants pipeline or sales overview. Show total pipeline value, deals by stage, win/loss ratio, and at-risk deals. Use charts/tables for clarity.',
      SEARCH: 'The user is searching for a specific contact, deal, or interaction history. Check context first, then use CRM tools for specific lookups.',
    },
    intentExamples: [
      // LOOKUP — pipeline and contact filters
      '"show my hot deals" → LOOKUP',
      '"deals in negotiation stage" → LOOKUP',
      '"contacts at Acme Corp" → LOOKUP',
      '"qualified leads this month" → LOOKUP',
      '"deals closing this quarter" → LOOKUP',
      '"lost deals last 30 days" → LOOKUP',
      '"list all warm leads" → LOOKUP',
      '"renewals due in March" → LOOKUP',
      '"my pipeline" → LOOKUP',
      '"stale deals with no activity" → LOOKUP',
      // SEARCH — specific CRM info
      '"what\'s the latest with the Globex deal?" → SEARCH',
      '"when did we last talk to Jane at Initech?" → SEARCH',
      '"find deals related to enterprise plan" → SEARCH',
      '"who owns the TechCorp account?" → SEARCH',
      '"history with Wayne Industries" → SEARCH',
      '"any notes from the Stark demo call?" → SEARCH',
      // Boundary: "deals in X stage" = LOOKUP (filter), "latest on X deal" = SEARCH (specific)
      '"cold leads?" → LOOKUP',
      '"what happened with the BigCo renewal?" → SEARCH',
      // CREATE — new contacts/deals/activities
      '"add new contact: Sarah Chen at DataFlow Inc" → CREATE',
      '"create deal: DataFlow enterprise — $50k" → CREATE',
      '"log a call with the Acme team" → CREATE',
      '"new lead from the conference" → CREATE',
      '"schedule follow-up with Globex for next week" → CREATE',
      // SUMMARY — pipeline reports
      '"pipeline overview" → SUMMARY',
      '"total deal value this quarter?" → SUMMARY',
      '"win rate this month" → SUMMARY',
      '"sales forecast for Q2" → SUMMARY',
      '"how is the team doing?" → SUMMARY',
      '"revenue by category" → SUMMARY',
      '"at-risk deals report" → SUMMARY',
      // Domain-specific ACTION
      '"move it to proposal" → ACTION',
      '"mark as won" → ACTION',
      '"assign to David" → ACTION',
      '"update the value to $75k" → ACTION',
      ...SHARED_ACTION_EXAMPLES,
      ...SHARED_CHAT_EXAMPLES,
    ],
    enabledTools: ['forge_memory', 'forge_language', 'forge_config', 'code_run'],
    isBuiltIn: true,
  },
  {
    key: 'helpdesk',
    label: 'Helpdesk & Support',
    description: 'Customer support tickets, SLA tracking, and knowledge base assistance.',
    agentName: 'Support Assistant',
    agentRole: 'You are a customer support operations assistant. You help support agents manage tickets, resolve customer issues efficiently, track SLA compliance, and maintain knowledge base articles. You prioritize customer empathy in responses, understand escalation paths, and monitor support health metrics like resolution time and CSAT scores.',
    statuses: ['new', 'open', 'pending_customer', 'pending_internal', 'resolved', 'closed', 'reopened'],
    priorities: ['critical', 'high', 'medium', 'low'],
    categories: ['bug_report', 'feature_request', 'how_to', 'billing', 'account', 'integration', 'outage'],
    behaviorRules: [
      'For new tickets, auto-suggest category and priority based on the description content.',
      'Always check the knowledge base for existing solutions before suggesting a fix.',
      'When resolving tickets, draft a customer-facing response and an internal note separately.',
      'SLA tracking: flag tickets approaching or exceeding their SLA deadline.',
      'For escalations, include full ticket history summary and steps already attempted.',
      'Customer-facing responses should be empathetic, clear, and include next steps.',
    ],
    queryStrategies: {
      ...SHARED_STRATEGIES,
      LOOKUP: 'The user wants filtered tickets (by status, priority, assignee, or SLA status). Use helpdesk tools with appropriate filters. Default to open/pending tickets.',
      CREATE: 'The user wants to create a ticket. Draft it with title, category, priority, description, and suggested assignee. Wait for confirmation.',
      SUMMARY: 'The user wants support overview. Show open ticket count, SLA compliance rate, tickets by category, average resolution time, and any critical/overdue tickets.',
      SEARCH: 'The user is searching for tickets or knowledge base articles. Check context first for matching KB articles, then use tools for ticket search.',
    },
    intentExamples: [
      // LOOKUP — ticket queues
      '"show open tickets" → LOOKUP',
      '"my assigned tickets" → LOOKUP',
      '"critical tickets breaching SLA" → LOOKUP',
      '"pending customer response" → LOOKUP',
      '"tickets for billing category" → LOOKUP',
      '"unresolved outage reports" → LOOKUP',
      '"new tickets today" → LOOKUP',
      '"reopened tickets this week" → LOOKUP',
      '"tickets assigned to support-tier-2" → LOOKUP',
      // SEARCH — find specific tickets or KB
      '"customer reported login issue on mobile" → SEARCH',
      '"how to reset 2FA for a customer?" → SEARCH',
      '"find tickets about SSO integration" → SEARCH',
      '"what\'s the resolution for the payment timeout error?" → SEARCH',
      '"any known issue with the API rate limit?" → SEARCH',
      '"check if there\'s a KB article for password reset" → SEARCH',
      '"ticket from Acme about export failure" → SEARCH',
      // Boundary: "open tickets" = LOOKUP (queue filter), "customer said X" = SEARCH (keyword)
      '"billing tickets?" → LOOKUP',
      '"what did the customer say about the error?" → SEARCH',
      // CREATE — new tickets
      '"create ticket: customer can\'t access dashboard after update" → CREATE',
      '"new billing issue: double charged for March" → CREATE',
      '"log an outage report for EU region" → CREATE',
      '"open a feature request for bulk export" → CREATE',
      // SUMMARY — support metrics
      '"support dashboard" → SUMMARY',
      '"how many tickets are open?" → SUMMARY',
      '"SLA compliance this week" → SUMMARY',
      '"average resolution time this month" → SUMMARY',
      '"ticket volume by category" → SUMMARY',
      '"CSAT score trend" → SUMMARY',
      '"backlog report" → SUMMARY',
      // Domain-specific ACTION
      '"escalate to tier 2" → ACTION',
      '"resolve it" → ACTION',
      '"send the response" → ACTION',
      '"assign to Maria" → ACTION',
      '"merge with ticket #456" → ACTION',
      ...SHARED_ACTION_EXAMPLES,
      ...SHARED_CHAT_EXAMPLES,
    ],
    enabledTools: ['forge_memory', 'forge_language', 'forge_skills', 'forge_config'],
    isBuiltIn: true,
  },
  {
    key: 'knowledge_base',
    label: 'Knowledge Base',
    description: 'Documentation, wiki articles, FAQs, and organizational knowledge management.',
    agentName: 'Knowledge Assistant',
    agentRole: 'You are an organizational knowledge management assistant. You help users find information from the company knowledge base, create well-structured articles, and maintain documentation quality. You prioritize answering from existing content with source citations, flag stale articles, and enforce consistent formatting (markdown headers, code blocks, proper tagging).',
    statuses: ['draft', 'in_review', 'published', 'archived', 'needs_update'],
    priorities: ['high', 'medium', 'low'],
    categories: ['guide', 'faq', 'policy', 'procedure', 'reference', 'troubleshooting', 'announcement'],
    behaviorRules: [
      'Always search existing articles before creating new ones — avoid duplicates.',
      'When answering questions, cite the source article title and link when available.',
      'For article creation, use proper structure: title, summary, sections with headers, and tags.',
      'Flag articles that haven\'t been updated in 90+ days as potentially stale when referenced.',
      'Maintain consistent formatting: use markdown headers, bullet points, and code blocks.',
      'When users ask questions, first try to answer from context/knowledge base. Only say "not found" if search yields no results.',
    ],
    queryStrategies: {
      ...SHARED_STRATEGIES,
      LOOKUP: 'The user wants filtered articles (by category, status, tags, or author). Use knowledge tools with appropriate filters.',
      CREATE: 'The user wants to create an article. Draft it with proper structure: title, summary, body sections, category, and tags. Wait for review before publishing.',
      SUMMARY: 'The user wants KB overview. Show article counts by category, recently updated articles, most viewed, and articles flagged for review.',
      SEARCH: 'The user is searching for information. Use semantic search across the knowledge base. Present the most relevant article excerpts with source attribution.',
    },
    intentExamples: [
      // LOOKUP — article lists
      '"show published guides" → LOOKUP',
      '"articles in FAQ category" → LOOKUP',
      '"drafts awaiting review" → LOOKUP',
      '"archived policies" → LOOKUP',
      '"articles tagged \'onboarding\'" → LOOKUP',
      '"recently updated procedures" → LOOKUP',
      '"stale articles needing update" → LOOKUP',
      // SEARCH — find information
      '"how do I set up VPN access?" → SEARCH',
      '"what\'s the expense reimbursement process?" → SEARCH',
      '"find the deployment runbook" → SEARCH',
      '"troubleshooting guide for email sync" → SEARCH',
      '"company travel policy" → SEARCH',
      '"hướng dẫn cài đặt môi trường dev" → SEARCH',
      '"is there documentation for the REST API?" → SEARCH',
      '"quy trình onboarding nhân viên mới" → SEARCH',
      // Boundary: "articles in X" = LOOKUP (filter), "how do I X?" = SEARCH (question)
      '"FAQ articles?" → LOOKUP',
      '"how does SSO work?" → SEARCH',
      // CREATE — new articles
      '"create a guide for setting up SSH keys" → CREATE',
      '"write a FAQ about the new leave policy" → CREATE',
      '"tạo bài hướng dẫn deploy production" → CREATE',
      '"draft a troubleshooting article for printer issues" → CREATE',
      '"new announcement: office move in April" → CREATE',
      // SUMMARY
      '"KB overview" → SUMMARY',
      '"how many articles do we have?" → SUMMARY',
      '"content coverage report" → SUMMARY',
      '"articles needing review" → SUMMARY',
      '"most viewed articles this month" → SUMMARY',
      // Domain-specific ACTION
      '"publish it" → ACTION',
      '"archive that article" → ACTION',
      '"move to in review" → ACTION',
      ...SHARED_ACTION_EXAMPLES,
      ...SHARED_CHAT_EXAMPLES,
    ],
    enabledTools: ['forge_memory', 'forge_language', 'forge_skills', 'forge_config'],
    isBuiltIn: true,
  },
  {
    key: 'headhunt_agency',
    label: 'Headhunt Agency',
    description: 'Recruitment agency operations: candidates, job orders, clients, placements, and revenue tracking for BOD, BD, and Recruiters.',
    agentName: 'Agency Assistant',
    agentRole: 'You are an operations assistant for a headhunt/recruitment agency. You support three user roles: BOD (Board of Directors) who need revenue dashboards, KPIs, and strategic oversight; BD (Business Development) who manage client relationships, job orders, and contracts; and Recruiters who source candidates, manage pipelines, and track placements. All data lives in the connected portal — always use MCP tools to fetch real-time data. Present numbers clearly with tables and summaries. Communicate in the user\'s language (Vietnamese or English).',
    statuses: ['new', 'screening', 'submitted', 'interview', 'offered', 'placed', 'rejected', 'withdrawn', 'on_hold'],
    priorities: ['urgent', 'high', 'normal', 'low'],
    categories: ['candidate', 'job_order', 'client', 'placement', 'invoice', 'contract', 'interview', 'report'],
    behaviorRules: [
      'All operational data lives in the connected portal via MCP. ALWAYS use MCP tools to query data — never say you don\'t have access.',
      'For revenue and financial queries, call the appropriate MCP tool with date filters. Do NOT guess or say data is unavailable without trying.',
      'BOD queries typically need aggregate data: revenue, placement count, conversion rates, pipeline value. Summarize with tables.',
      'BD queries focus on clients, job orders, and contracts. Show client name, job title, fee, and status.',
      'Recruiter queries focus on candidates, interviews, and pipeline stages. Show candidate name, position, stage, and next action.',
      'When listing data, default to current month/quarter if no date range is specified.',
      'Format currency in VND unless the user specifies otherwise.',
      'For placement and revenue reports, show both count and monetary value.',
      'NEVER call the same GraphQL query in a loop for different IDs. Use GraphQL aliases to batch: { c1: campaignRevenueSummary(campaign_id:"1"){revenue} c2: campaignRevenueSummary(campaign_id:"2"){revenue} }. Batch up to 20 per call.',
      'For aggregate reports across campaigns/teams, first fetch the list of IDs, then batch ALL detail queries in 1-2 alias calls — not one call per item.',
    ],
    queryStrategies: {
      ...SHARED_STRATEGIES,
      LOOKUP: 'The user wants filtered recruitment data (candidates by stage, job orders by status, placements by date). Use MCP tools with appropriate filters. For role-specific views: BOD sees all, BD sees their clients/jobs, Recruiters see their pipeline.',
      CREATE: 'The user wants to create a candidate profile, job order, or client record. Draft it with all key fields and wait for confirmation before creating via MCP tool.',
      SUMMARY: 'The user wants business metrics: revenue, placements, pipeline, or KPIs. Use MCP tools to fetch real-time data from the portal — do NOT rely on cached stats. Present with tables showing key numbers, comparisons, and trends.',
      SEARCH: 'The user is searching for a specific candidate, client, job order, or historical data. Check context first, then use MCP tools for precise lookups.',
    },
    intentExamples: [
      // LOOKUP — filtered recruitment data
      '"show candidates in interview stage" → LOOKUP',
      '"job orders đang mở" → LOOKUP',
      '"danh sách ứng viên mới" → LOOKUP',
      '"clients with active contracts" → LOOKUP',
      '"placed candidates this quarter" → LOOKUP',
      '"pending invoices" → LOOKUP',
      '"ứng viên đang chờ offer" → LOOKUP',
      '"job orders for TechCorp" → LOOKUP',
      '"hồ sơ đã submit cho khách hàng" → LOOKUP',
      '"urgent job orders" → LOOKUP',
      // SEARCH — specific lookups
      '"find candidate Nguyễn Văn A" → SEARCH',
      '"tìm job order cho vị trí CTO" → SEARCH',
      '"lịch sử placement với công ty ABC" → SEARCH',
      '"who submitted candidates for the PM role?" → SEARCH',
      '"thông tin khách hàng FPT" → SEARCH',
      '"chi tiết job order JO-2024-045" → SEARCH',
      // Boundary: "candidates in X stage" = LOOKUP, "find candidate X" = SEARCH
      '"ứng viên đang screening?" → LOOKUP',
      '"tìm ứng viên tên Linh" → SEARCH',
      // CREATE
      '"thêm ứng viên mới cho vị trí Java Dev" → CREATE',
      '"tạo job order mới" → CREATE',
      '"add new client: ABC Technology" → CREATE',
      '"tạo hồ sơ ứng viên" → CREATE',
      // SUMMARY — revenue, KPIs, dashboards
      '"doanh thu tháng này" → SUMMARY',
      '"revenue this month" → SUMMARY',
      '"bao nhiêu placement tháng này?" → SUMMARY',
      '"tổng quan kinh doanh Q1" → SUMMARY',
      '"pipeline value" → SUMMARY',
      '"conversion rate từ submit đến offer" → SUMMARY',
      '"KPI team tuyển dụng" → SUMMARY',
      '"báo cáo doanh thu theo khách hàng" → SUMMARY',
      '"tháng này doanh thu tới đâu rồi" → SUMMARY',
      '"so sánh doanh thu tháng này với tháng trước" → SUMMARY',
      '"placement count by recruiter" → SUMMARY',
      '"tỷ lệ thành công" → SUMMARY',
      // Domain-specific ACTION
      '"submit ứng viên cho khách" → ACTION',
      '"move to interview" → ACTION',
      '"mark as placed" → ACTION',
      '"reject candidate" → ACTION',
      '"gửi hồ sơ cho khách hàng" → ACTION',
      '"chuyển sang vòng phỏng vấn" → ACTION',
      ...SHARED_ACTION_EXAMPLES,
      ...SHARED_CHAT_EXAMPLES,
    ],
    enabledTools: ['forge_memory', 'forge_language', 'forge_config', 'code_run'],
    isBuiltIn: true,
  },
];

/** Simple hash to detect template content changes. */
function hashTemplate(tpl: any): string {
  const content = JSON.stringify({
    agentRole: tpl.agentRole,
    behaviorRules: tpl.behaviorRules,
    queryStrategies: tpl.queryStrategies,
    intentExamples: tpl.intentExamples,
    enabledTools: tpl.enabledTools,
    statuses: tpl.statuses,
    priorities: tpl.priorities,
    categories: tpl.categories,
  });
  let h = 0;
  for (let i = 0; i < content.length; i++) {
    h = ((h << 5) - h + content.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

export async function seedDomainTemplates(strapi: any) {
  const docs = strapi.documents(UID);

  for (const tpl of BUILT_IN_TEMPLATES) {
    const existing = await docs.findMany({
      filters: { key: { $eq: tpl.key } },
      limit: 1,
    });

    if (existing.length === 0) {
      await docs.create({ data: { ...tpl, contentHash: hashTemplate(tpl) } });
      strapi.log.info(`[seed] Created domain template: ${tpl.key}`);
    } else {
      const doc = existing[0] as any;
      if (doc.isBuiltIn) {
        const newHash = hashTemplate(tpl);
        if (doc.contentHash === newHash) continue; // unchanged
        await docs.update({ documentId: doc.documentId, data: { ...tpl, contentHash: newHash } });
        strapi.log.info(`[seed] Updated domain template: ${tpl.key}`);
      }
    }
  }
}

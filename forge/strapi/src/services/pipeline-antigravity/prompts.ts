/**
 * Build the API access preamble for Antigravity prompts.
 *
 * Instructs the agent to:
 * 1. Read the environment guide (antigravity-guide/SKILL.md)
 * 2. Read the specific pipeline skill guide (e.g. forge-triage/SKILL.md)
 * 3. Translate MCP tool syntax from skill docs into CLI commands
 *
 * The contextBlock parameter contains pre-fetched project knowledge,
 * conventions, and shared pipeline rules (from buildAntigravityContext).
 */
function apiPreamble(project: any, skill?: string, opts?: { skipGit?: boolean; contextBlock?: string }): string {
    const baseBranch = (project as any).baseBranch || 'main';
    const lines: string[] = [];

    // Pre-fetched context (knowledge + conventions + pipeline rules)
    if (opts?.contextBlock) {
        lines.push(opts.contextBlock, '');
    }

    // Step 1: Read environment guide
    lines.push(
        `SETUP (do these first, before any other work):`,
        `1. Read the environment guide: cat skills/antigravity-guide/SKILL.md`,
    );

    // Step 2: Read pipeline-specific skill guide (if available)
    if (skill) {
        lines.push(
            `2. Read your skill guide: cat skills/${skill}/SKILL.md`,
            `   This has the detailed workflow, reference files, and rules for this step.`,
            `   Also read any reference files mentioned in the skill (e.g. "cat skills/${skill}/references/<file>.md").`,
        );
    }

    // Step 3: Git setup
    const nextStep = skill ? 3 : 2;
    if (!opts?.skipGit) {
        lines.push(
            `${nextStep}. Navigate to the repo (it's a subdirectory of your session root, NOT "skills"):`,
            `   List directories to find it, then: cd <repo-dir>`,
            `${nextStep + 1}. Sync code: git fetch origin && git checkout ${baseBranch} && git pull origin ${baseBranch}`,
            ``,
        );
    }

    lines.push(
        `IMPORTANT: Run each command and wait for completion. Do not run background commands.`,
        `The environment guide has the full CLI reference — read it first.`,
        ``,
    );
    return lines.join('\n');
}

/**
 * Build Antigravity prompt per pipeline skill.
 *
 * The detailed workflow, references, and rules are in the bundled skill files
 * (skills/<skill>/SKILL.md). The prompt here only adds:
 * - apiPreamble (setup + CLI translation guide + pre-fetched context)
 * - Issue-specific context (documentId, URLs, credentials, branch names)
 * - Brief role reminder
 *
 * contextBlock is pre-fetched by executeAntigravityStep and passed in.
 * It contains knowledge, conventions, and shared pipeline rules.
 */
export function buildAntigravityPrompt(
    skill: string,
    issue: any,
    project: any,
    contextBlock: string,
): string {
    const builder = ANTIGRAVITY_PROMPT_BUILDERS[skill];
    if (!builder) return '';
    return builder(issue, project, contextBlock);
}

const ANTIGRAVITY_PROMPT_BUILDERS: Record<string, (issue: any, project: any, ctx: string) => string> = {
    'forge-triage': (issue, project, ctx) => `${apiPreamble(project, 'forge-triage', { contextBlock: ctx })}

You are a triage agent. Triage issue ${issue.documentId} (ISS-${issue.id}).
Follow the workflow in skills/forge-triage/SKILL.md.

Issue context:
- documentId: ${issue.documentId}  (display: ISS-${issue.id})
- title: ${issue.title || '(untitled)'}

IMPORTANT: Always write triage comments in English.

Do all steps now.`,

    'forge-clarify': (issue, project, ctx) => {
        const pd = (project as any).previewDeploy || {};
        const urls: Array<{ label: string; url: string }> = pd.testingUrls?.length
            ? pd.testingUrls
            : [pd.stagingUrl && { label: 'Frontend', url: pd.stagingUrl }, pd.stagingApiUrl && { label: 'API', url: pd.stagingApiUrl }].filter(Boolean);
        const creds = (pd.testCredentials || []) as Array<{ label: string; username: string; password: string }>;
        const credsBlock = creds.length
            ? `\nTest credentials:\n${creds.map((c) => `- ${c.label}: username=${c.username} password=${c.password}`).join('\n')}`
            : '';
        const urlBlock = urls.length
            ? `\nTesting URLs:\n${urls.map((u) => `- ${u.label}: ${u.url}`).join('\n')}`
            : '';

        return `${apiPreamble(project, 'forge-clarify', { skipGit: true, contextBlock: ctx })}

You are a UX clarification agent. Investigate issue ${issue.documentId} (ISS-${issue.id}).
Follow the workflow in skills/forge-clarify/SKILL.md.

Issue context:
- documentId: ${issue.documentId}  (display: ISS-${issue.id})
- title: ${issue.title || '(untitled)'}
${urlBlock}${credsBlock}

IMPORTANT:
- Do NOT install any packages. Do NOT use npm/pip. Do NOT use Playwright, Puppeteer, or any test framework.
- Do NOT generate or fabricate images. Only use images captured from the computer tool.
- For browser interaction, use the computer tool (built-in) to control Chrome.

Do all steps now.`;
    },

    'forge-plan': (issue, project, ctx) => `${apiPreamble(project, 'forge-plan', { contextBlock: ctx })}

You are a planning agent. Write an implementation plan for issue ${issue.documentId} (ISS-${issue.id}).
Follow the workflow in skills/forge-plan/SKILL.md.

Issue context:
- documentId: ${issue.documentId}  (display: ISS-${issue.id})
- title: ${issue.title || '(untitled)'}

Do all steps now.`,

    'forge-review': (issue, project, ctx) => `${apiPreamble(project, 'forge-review', { contextBlock: ctx })}

You are a code review agent. Review code changes for issue ${issue.documentId} (ISS-${issue.id}).
Follow the workflow in skills/forge-review/SKILL.md.

Issue context:
- documentId: ${issue.documentId}  (display: ISS-${issue.id})
- title: ${issue.title || '(untitled)'}

Do all steps now.`,

    'forge-test': (issue, project, ctx) => {
        const pd = (project as any).previewDeploy || {};
        const urls: Array<{ label: string; url: string }> = pd.testingUrls?.length
            ? pd.testingUrls
            : [pd.stagingUrl && { label: 'Frontend', url: pd.stagingUrl }, pd.stagingApiUrl && { label: 'API', url: pd.stagingApiUrl }].filter(Boolean);
        const creds = (pd.testCredentials || []) as Array<{ label: string; username: string; password: string }>;
        const credsBlock = creds.length
            ? `\nTest credentials:\n${creds.map((c) => `- ${c.label}: username=${c.username} password=${c.password}`).join('\n')}`
            : '';
        const urlBlock = urls.length
            ? `\nTesting URLs:\n${urls.map((u) => `- ${u.label}: ${u.url}`).join('\n')}`
            : '';

        return `${apiPreamble(project, 'forge-test', { skipGit: true, contextBlock: ctx })}

You are a QA testing agent. Test changes for issue ${issue.documentId} (ISS-${issue.id}).
Follow the workflow in skills/forge-test/SKILL.md.

Issue context:
- documentId: ${issue.documentId}  (display: ISS-${issue.id})
- title: ${issue.title || '(untitled)'}
${urlBlock}${credsBlock}

IMPORTANT:
- Do NOT install any packages. Do NOT use npm/pip. Do NOT use Playwright, Puppeteer, or any test framework.
- Do NOT generate or fabricate images. Only use images captured from the computer tool.
- For browser testing, use the computer tool (built-in) to control Chrome.

Do all steps now.`;
    },

    'forge-fix': (issue, project, ctx) => `${apiPreamble(project, 'forge-fix', { contextBlock: ctx })}

You are a fix agent. Read rejection feedback for issue ${issue.documentId} (ISS-${issue.id}) and apply a fix.
Follow the workflow in skills/forge-fix/SKILL.md.

Issue context:
- documentId: ${issue.documentId}  (display: ISS-${issue.id})
- title: ${issue.title || '(untitled)'}

Do all steps now.`,

    'forge-release': (issue, project, ctx) => `${apiPreamble(project, 'forge-release', { contextBlock: ctx })}

You are a release agent. Merge approved code for issue ${issue.documentId} (ISS-${issue.id}) to production.
Follow the workflow in skills/forge-release/SKILL.md.

Issue context:
- documentId: ${issue.documentId}  (display: ISS-${issue.id})
- title: ${issue.title || '(untitled)'}

Do all steps now.`,
};

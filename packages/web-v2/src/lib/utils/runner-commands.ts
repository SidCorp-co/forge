// The runner's own commands, shown and copied verbatim on the screens that tell a person what to run.
// They are the CLI's words, never translated, so they live here rather than in a copy file.

export const RUNNER_SETUP = "forge-runner setup";

export const masterStandDown = (project: string) => `forge-runner master stand-down ${project}`;

export const masterStandUp = (project: string) => `forge-runner master stand-up ${project}`;

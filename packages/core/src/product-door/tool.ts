// The product layer's MCP tools, served on /mcp so a person can work from an MCP client: releases,
// designs, questions, and delivery work read. Each composes the product modules' own services with
// the forecast's dates, which no single module may import, so they live in this door.

export { forgeDesignTool } from './design-tool.js';
export { forgeIssuesTool } from './issues-tool.js';
export { forgeQuestionsTool } from './questions-tool.js';
export { forgeReleasesProductTool } from './releases-tool.js';

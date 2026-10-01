//! MCP config assembly: merge the built-in Forge MCP (authed with the device
//! token) and a chat frame's `mcpServersOverride` into a temp `.json`
//! passed to `claude --mcp-config`. MCP is never managed locally.

pub mod config;

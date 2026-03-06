# mcp0 Port Plan (Warmplane)

This document tracks the plugin-first `mcp0` direction for MCP token-efficiency in op1.

## Direction

- Name: `mcp0`
- Source concept: Warmplane facade
- Integration strategy: op1 plugin + installer path first, no opencode-source core changes

## Installer Contract (Current)

- New optional MCP category: `mcp0 (Warmplane)`
- MCP id: `mcp0`
- Command: `warmplane mcp-server`
- Tool namespace target: `mcp0_*`
- Default agent access: `researcher`, `coder`, `frontend`

## Keep / Revert Classification

### Keep

- op1 installer and workspace changes that are still useful for deterministic MCP policy and agent-scoped access.

### Revert

- opencode-source MCP runtime prototype changes are out of scope for plugin-first `mcp0`.

### Isolate

- Existing local MCP-pointer and SkillPointer experimental edits in op1 remain uncommitted and should be split into separate commits if reused.

## Open Follow-ups

1. Add explicit mcp0 health checks/fallback telemetry in `@op1/workspace`.
2. Add installer prompt for mcp0 config path and bootstrap file generation.
3. Add focused tests for mcp0 category selection and agent-scoped `mcp0_*` tool visibility.
4. Add migration guidance for teams moving from direct MCP servers to mcp0 facade.

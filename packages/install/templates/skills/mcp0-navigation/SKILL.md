---
name: mcp0-navigation
description: Navigate the Warmplane mcp0 facade efficiently. Use when the active config exposes provider capabilities through `mcp0_*` tools and you need to discover or call provider tools without brute-force describing large capability sets. Trigger on requests involving mcp0, Warmplane, or provider work through the facade such as Linear, Notion, Figma, New Relic, Context7, grep.app, Storybook, or zai-* tools.
---

# mcp0 Navigation

Use this skill whenever MCP providers are routed through the Warmplane facade.

This skill is complementary to domain skills such as `linear`, `notion-research-documentation`, `newrelic`, and `figma-design`.

- Use `mcp0-navigation` to find and call the right capability through the facade.
- Use the domain skill when you also need domain-specific workflow, interpretation, or output structure.
- Do not remove the domain skills just because the transport moved behind `mcp0`.

## Fast Rules

- If the exact provider capability id is already obvious, call `mcp0_capability_call` directly.
- If you know the provider but not the capability id, call `mcp0_capability_find` first with `server`, `query`, and a small `limit`.
- If you need a broader inventory, call `mcp0_capabilities_list` with `server` and `query` to narrow the list.
- Call `mcp0_capability_describe` only for the final candidate when the input shape is still unclear.
- Never grep prior tool-output files or use bash just to discover `mcp0` capability ids.

## Preferred Flow

1. Known exact id -> `mcp0_capability_call`
2. Known provider, unknown id -> `mcp0_capability_find`
3. Unknown provider scope -> `mcp0_capabilities_list`
4. Still unclear args -> one `mcp0_capability_describe`
5. Execute -> `mcp0_capability_call`

## Examples

- Figma identity -> `figma.whoami`
- Linear teams -> `linear.list_teams`
- Linear in-progress tickets -> `linear.list_issues` with assignee/state filters
- Notion user search -> `notion.notion-search` with `query_type: "user"`

## Query Hints

- Keep `query` short and task-shaped: `"list issues"`, `"search users"`, `"who am i"`
- Keep `limit` small: usually `3` to `5`
- Prefer one provider at a time rather than searching the whole facade

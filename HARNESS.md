# Harness Readiness Findings

This document validates `opencode-harness` against the best capabilities of `oh-my-opencode` and `opencode-workspace` while remaining lean and cost-aware. It inventories current assets, identifies gaps, and provides recommended additions with clear enablement rules and token guardrails.

---

## Table of Contents

1. [Scope and Goals](#1-scope-and-goals)
2. [Current Harness Inventory](#2-current-harness-inventory)
3. [Upstream Parity Targets](#3-upstream-parity-targets)
4. [Gap Analysis](#4-gap-analysis)
5. [Parity Matrix](#5-parity-matrix-skillsmcps)
6. [Lean Recommendations](#6-lean-recommendations)
7. [Install & Enablement Notes](#7-install--enablement-notes)
8. [mcp-economy Skill](#8-mcp-economy-skill)
9. [Readiness Checklist](#9-readiness-checklist)
10. [Token Guardrails Summary](#10-token-guardrails-summary)
11. [Troubleshooting](#11-troubleshooting)
12. [Quick Start](#12-quick-start-harness)
13. [Migration Checklist](#13-migration-checklist-harness--configopencode)
14. [Decision Log](#14-decision-log)
15. [FAQ](#15-faq)
16. [Optional MCPs Reference](#16-optional-mcps-reference)

---

## 1) Scope and Goals

**Goal:** Achieve feature parity for skills and MCP capabilities used by `oh-my-opencode` and `opencode-workspace`, without unnecessary token burn or bloat.

**Principles:**
- **Lean by default:** Everything heavy is opt-in and per-agent.
- **Researcher-only MCPs:** MCP tooling is disabled globally and enabled only for `researcher`.
- **Skills guide usage:** Add skills that enforce "when to use" and "when not to use."
- **No forced coupling:** Skills and MCPs remain decoupled unless strictly needed.

---

## 2) Current Harness Inventory

### Agents
| Agent | Mode | Description |
|-------|------|-------------|
| build | primary | Senior implementation engineer; writes code, runs tests, ships features |
| plan | primary | Strategic planner; creates work breakdowns, gathers context |
| explore | subagent | Internal codebase search; contextual grep, file/pattern discovery |
| researcher | subagent | External resource researcher; docs, GitHub, web search |
| oracle | subagent | High-IQ consultant; architecture decisions, debugging |
| reviewer | subagent | Code review specialist; 4-layer review methodology |
| coder | subagent | Focused implementer; atomic coding tasks |
| frontend | subagent | UI/UX specialist; visual excellence, intentional design |
| scribe | subagent | Content specialist; documentation, commit messages, prose |

### Skills
| Skill | Purpose |
|-------|---------|
| ulw | ULTRAWORK mode; parallel agent orchestration, strict verification |
| search-mode | Maximum search effort; exhaustive codebase + external search |
| analyze-mode | Deep analysis; context gathering, debugging/investigation |
| code-philosophy | Backend code quality; 5 Laws of Elegant Defense |
| frontend-philosophy | UI/UX quality; 5 Pillars of Intentional UI |
| code-review | Code review methodology; 4 layers, severity classification |
| git-master | Git operations; atomic commits, rebase/squash, history search |
| tmux | Terminal orchestration; session management, parallel tasks |
| plan-protocol | Implementation plan guidelines; format, citations, state machine |
| plan-review | Plan review criteria; citation quality, completeness checks |
| frontend-ui-ux | Designer role; aesthetic direction, anti-patterns |
| playwright | Browser automation (optional) |
| **mcp-economy** | **NEW** - Cost-aware MCP usage guidance |

### Commands
| Command | Agent | Purpose |
|---------|-------|---------|
| `/ulw [task]` | build | Activate ULTRAWORK mode |
| `/review [files]` | reviewer | Run comprehensive code review |
| `/research [topic]` | researcher | Conduct external research |
| `/plan [task]` | plan | Create implementation plan |
| `/find [query]` | explore | Search codebase |
| `/oracle [question]` | oracle | Consult for architecture/debugging |

### MCPs (Configured)
| MCP | Type | Tools | Agent Access |
|-----|------|-------|--------------|
| zai-vision | local | ui_to_artifact, extract_text, diagnose_error, etc. | coder, frontend |
| zai-search | remote | webSearchPrime | researcher |
| zai-reader | remote | webReader | researcher |
| zai-zread | remote | search_doc, get_repo_structure, read_file | researcher |
| linear | local | linear_list_issues, linear_get_issue, etc. | researcher |
| notion | local | notion_search, notion_fetch, etc. | researcher |
| context7 | remote | resolve-library-id, get-library-docs | researcher |
| grep_app | remote | search (GitHub code search) | researcher |

**MCP policy:** All MCP tools are globally disabled and enabled per agent.

### Workspace Plugin Tools
| Tool | Purpose |
|------|---------|
| `plan_save` | Save implementation plan with validation |
| `plan_read` | Read current plan for session |
| `plan_list` | List all plans (active + completed) |
| `notepad_read` | Read accumulated wisdom (learnings, issues, decisions) |
| `notepad_write` | Append to notepad files with timestamp |
| `notepad_list` | List notepad files for active plan |

**Notepad Files:**
- `learnings.md` - Patterns, conventions, successful approaches
- `issues.md` - Gotchas, failed approaches, technical debt
- `decisions.md` - Rationales for implementation choices

**Storage Location:** `.opencode/workspace/notepads/{plan-name}/`

---

## 3) Upstream Parity Targets

### oh-my-opencode
- Built-in MCPs: `context7`, `grep_app`
- MCP validation checks (doctor) validate MCP configs
- Skills can embed MCP config (but not required for harness)

### opencode-workspace
- Documented MCP baseline: `context7`,  `grep_app`
- Skills: code-philosophy, plan-protocol, code-review, frontend-philosophy, plan-review

---

## 4) Gap Analysis

### Missing MCPs (Parity)
| MCP | Purpose | Priority |
|-----|---------|----------|
| context7 | Docs/library lookup | Must-have |
| grep_app | GitHub code search | Must-have |

### Missing Skills
| Skill | Purpose | Priority |
|-------|---------|----------|
| mcp-economy | Cost-aware MCP usage guidance | Must-have |

### Optional (No Current Need)
| Item | Status |
|------|--------|
| playwright | Keep as optional reference |
| notion-research-documentation | Skip; MCP-only is sufficient |
| linear skill | Skip; MCP-only is sufficient |

---

## 5) Parity Matrix (Skills/MCPs)

### Skills Comparison
| Skill | Harness | oh-my-opencode | opencode-workspace | Notes |
|-------|---------|----------------|--------------------| ------|
| code-philosophy | ✅ | ✅ | ✅ | Shared core |
| plan-protocol | ✅ | ✅ | ✅ | Shared core |
| plan-review | ✅ | ✅ | ✅ | Shared core |
| code-review | ✅ | ✅ | ✅ | Shared core |
| frontend-philosophy | ✅ | ✅ | ✅ | Shared core |
| ulw | ✅ | ✅ | ❌ | Added in harness |
| search-mode | ✅ | ✅ | ❌ | Added in harness |
| analyze-mode | ✅ | ✅ | ❌ | Added in harness |
| git-master | ✅ | ✅ | ❌ | Added in harness |
| tmux | ✅ | ✅ | ❌ | Added in harness |
| frontend-ui-ux | ✅ | ❌ | ❌ | Added in harness |
| playwright | ✅ (opt) | ✅ | ❌ | Keep optional |
| mcp-economy | ✅ | ❌ | ❌ | **Added** |

### MCPs Comparison
| MCP | Harness | oh-my-opencode | opencode-workspace | Recommendation |
|-----|---------|----------------|--------------------| ---------------|
| context7 | ✅ | ✅ | ✅ | **Added** |
| grep_app | ✅ | ✅ | ✅ | **Added** |
| zai-* | ✅ | ❌ | ❌ | Keep, researcher/coder only |
| linear | ✅ | ❌ | ❌ | Keep, researcher only |
| notion | ✅ | ❌ | ❌ | Keep, researcher only |

---

## 6) Lean Recommendations

### MCPs (Enable only for `researcher`)
| MCP | Cost | Utility | When to Use |
|-----|------|---------|-------------|
| context7 | Low | High | Docs/library lookup first |
| grep_app | Mid | High | GitHub code search when needed |

### Skills
- Keep all existing skills
- Add `mcp-economy` skill (lightweight guidance)
- Keep playwright as optional reference only

---

## 7) Install & Enablement Notes

### 7.1 Add MCPs to `opencode.jsonc`

Add to `"mcp"` section:

```jsonc
// ----- Parity MCPs (from oh-my-opencode / opencode-workspace) -----

// Context7 - Library/docs lookup
// Tools: resolve-library-id, get-library-docs
"context7": {
  "type": "remote",
  "url": "https://mcp.context7.com/mcp"
},

// Grep.app - GitHub code search
// Tools: search (searches public GitHub repos)
"grep_app": {
  "type": "remote",
  "url": "https://mcp.grep.app"
},

}
```

### 7.2 Keep global MCP tools disabled

Add to `"tools"` section:

```jsonc
"context7_*": false,
"grep_app_*": false,
```

### 7.3 Enable only for `researcher`

Update `"agent"` → `"researcher"` → `"tools"`:

```jsonc
"researcher": {
  "tools": {
    "zai-search_*": true,
    "zai-reader_*": true,
    "zai-zread_*": true,
    "linear_*": true,
    "notion_*": true,
    "context7_*": true,
    "grep_app_*": true,
  }
}
```

---

## 8) mcp-economy Skill

**File:** `.opencode/skill/mcp-economy/SKILL.md`

See the skill file for full content. Summary:

### Purpose
Reduce token burn by ensuring MCP tools are only used when local context is insufficient.

### Core Rules
1. Default to local reasoning and available files
2. Use MCPs only when local context is missing or ambiguous
3. Prefer context7 for docs before any web search
4. Prefer grep_app for precise GitHub searches

### Decision Checklist
Before using an MCP, ask:
- Do I already have the answer locally?
- Is a small doc lookup (context7) enough?
- Is GitHub code search specifically required?
- Does the user explicitly ask for web discovery?

---

## 9) Readiness Checklist

### Pre-Deployment
- [ ] MCP entries for context7, grep_app exist in `opencode.jsonc`
- [ ] Global MCP tool disablement remains intact
- [ ] `researcher` tool overrides enable only needed MCPs
- [ ] `mcp-economy` skill is present and discoverable

### Smoke Tests
- [ ] context7: simple doc lookup (e.g., "lookup lodash documentation")
- [ ] grep_app: narrow GH search (e.g., "search GitHub for react hooks pattern")

### Post-Deployment
- [ ] Review token usage after first real task
- [ ] Verify no MCP tool leakage to non-researcher agents
- [ ] Confirm mcp-economy skill is being loaded when relevant

---

## 10) Token Guardrails Summary

| Rule | Description |
|------|-------------|
| Default local | Always try local context first |
| context7 first | Use for docs before any web search |
| grep_app second | Use for GitHub code search when needed |
| MCP disabled globally | Prevents accidental tool usage and token spikes |

---

## 11) Troubleshooting

| Symptom | Check |
|---------|-------|
| MCP not responding | Verify URL and auth header in `opencode.jsonc` |
| Tool unavailable | Check agent tool overrides |
| Unexpected token usage | Ensure `mcp-economy` skill is active |
| Auth errors | Confirm env vars (e.g., `Z_AI_API_KEY`) |
| context7 fails | Check if library ID is valid |
| grep_app no results | Try broader search terms |

---

## 12) Quick Start (Harness)

1. **Validate config staging**
   - Use `opencode-harness/opencode.jsonc` and `.opencode/` as staging source of truth
   - Do not copy to `~/.config/opencode` until checklist passes

2. **Enable MCP parity (researcher only)**
   - Add MCPs: `context7`, `grep_app`
   - Keep MCP tools globally disabled; enable only for `researcher`

3. **Add economy guidance**
   - Add `.opencode/skill/mcp-economy/SKILL.md`
   - Use it to enforce minimal MCP usage

4. **Smoke check**
   - context7: quick doc lookup
   - grep_app: narrow GitHub search

5. **Review token usage**

6. **Promote to user config**
   - Once checks pass, mirror `opencode-harness` to `~/.config/opencode`

---

## 13) Migration Checklist (Harness → ~/.config/opencode)

### Pre-Flight
- [ ] opencode-harness is the active staging source
- [ ] All MCP entries validated (context7, grep_app)
- [ ] MCP tools globally disabled, researcher-only enablement verified
- [ ] mcp-economy skill present and discoverable
- [ ] Smoke checks executed successfully
- [ ] Token usage reviewed after first real task

### Promote to User Config
```bash
# Backup existing config
cp -r ~/.config/opencode ~/.config/opencode.backup.$(date +%Y%m%d)

# Copy harness to user config
cp opencode-harness/opencode.jsonc ~/.config/opencode/opencode.jsonc
cp -r opencode-harness/.opencode ~/.config/opencode/
```

### Post-Flight
- [ ] Confirm OpenCode resolves agents/skills in user config
- [ ] Confirm researcher MCP tools visible; non-researcher tools hidden
- [ ] Re-run smoke checks (context7, grep_app)
- [ ] Monitor token usage for first 1-2 sessions

### Rollback Plan
```bash
# Restore from backup
rm -rf ~/.config/opencode
mv ~/.config/opencode.backup.YYYYMMDD ~/.config/opencode
```

---

## 14) Decision Log

| Decision | Rationale |
|----------|-----------|
| Add context7 | Low-cost doc lookup with high leverage; upstream baseline |
| Add grep_app | Targeted GitHub code search; often required for repo-level research |
| Researcher-only MCPs | Keeps default agents lean; avoids accidental token burn |
| Add mcp-economy skill | Encourages disciplined tool usage; explicit cost awareness |
| Keep Playwright optional | No explicit harness need; keep as reference only |
| linear/notion MCP-only | MCP access is sufficient; no need for dedicated skills |

---

## 15) FAQ

**Q: When should I use context7 **
A: Use context7 for library/documentation lookup first.

**Q: Why keep MCP tools disabled globally?**
A: Prevents unintended tool usage and token spikes. Enables only for the agent designed for research.

**Q: Do we need Playwright now?**
A: Not unless you have UI verification tasks. Keep it as optional reference to avoid unnecessary MCP activation.

**Q: Should we add skills for Linear/Notion?**
A: Not required. MCP-only is enough; the researcher agent already has access.

**Q: How do I check token usage?**
A: Monitor OpenCode's session output. If using a proxy like Quotio, check the dashboard for per-request costs.

**Q: What if context7 doesn't have docs for my library?**
A: Fall back to grep_app for GitHub search.

**Q: Can I add more MCPs later?**
A: Yes. Follow the same pattern: add to `mcp`, disable globally in `tools`, enable per-agent as needed.

---

## 16) Optional MCPs Reference

These MCPs are not included by default but can be added if needed:

### Playwright (Browser Automation)
```jsonc
"playwright": {
  "type": "local",
  "command": ["npx", "-y", "@playwright/mcp@latest"]
}
```
**Use case:** UI testing, screenshots, browser interactions
**Enable for:** coder (if needed)

### Filesystem (Local File Access)
```jsonc
"filesystem": {
  "type": "local",
  "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/dir"]
}
```
**Use case:** Explicit file access outside project
**Enable for:** As needed (security sensitive)

### GitHub (Official)
```jsonc
"github": {
  "type": "remote",
  "url": "https://api.githubcopilot.com/mcp/"
}
```
**Use case:** PR/issue management, repo operations
**Enable for:** researcher
**Note:** High token usage; use sparingly

### Sentry (Error Monitoring)
```jsonc
"sentry": {
  "type": "remote",
  "url": "https://mcp.sentry.dev/mcp"
}
```
**Use case:** Error tracking, debugging production issues
**Enable for:** researcher

---

## 17) Orchestration Pattern

This harness supports a lightweight orchestration pattern for multi-agent task delegation.

### Architecture: 3-Tier Delegation

```
┌─────────────────────────────────────────────────────────────┐
│                    PLAN AGENT (Planner)                    │
│                 (Optional - Planning Phase)                 │
│  • Creates structured work plans                            │
│  • Uses explore/researcher for context gathering            │
│  • Outputs phased task breakdown                            │
└───────────────────┬─────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────────┐
│                 BUILD AGENT (Orchestrator)                  │
│              (Main Agent - Delegates & Verifies)            │
│  • Reads plan and delegates via task()                      │
│  • Coordinates parallel task execution                      │
│  • Verifies all subagent work                               │
│  • Manages todo state                                       │
└─────────┬───────────────────────────────────┬───────────────┘
          │                                   │
          │ DELEGATES                          │ COORDINATES
          ▼                                   ▼
┌─────────────────────┐             ┌──────────────────────┐
│  CODER / FRONTEND  │             │ SPECIALIST AGENTS     │
│  (Workers)         │             │                       │
│  • Execute tasks   │             │ • oracle (advice)     │
│  • Atomic work     │             │ • explore (search)    │
│  • Verify changes  │             │ • researcher (docs)   │
└─────────────────────┘             │ • reviewer (review)   │
                                    │ • scribe (docs)       │
                                    └──────────────────────┘
```

### Workflow

**Phase 1: Planning (Optional)**
```
User: "Create a plan for implementing auth"
→ Switch to plan agent
→ plan agent gathers context via explore/researcher
→ plan agent outputs structured plan
```

**Phase 2: Orchestration**
```
User: "Implement the auth plan"
→ build agent reads plan
→ For each task:
    → Delegate to appropriate agent (coder, frontend, etc.)
    → VERIFY the work (don't trust blindly)
    → Mark todo complete
→ Final report
```

### Delegation Decision Matrix

| Task Type | Delegate To | Model Advantage |
|-----------|-------------|-----------------|
| Frontend UI | frontend | Visual excellence, UI/UX craft |
| Backend logic | coder | Code philosophy, atomic implementation |
| Architecture | oracle | High-IQ reasoning, strategic decisions |
| Codebase search | explore | Internal pattern discovery |
| External research | researcher | Docs, APIs, web search |
| Code review | reviewer | 4-layer review methodology |
| Documentation | scribe | Human-facing prose |

### Parallel Execution

```
// Fire parallel agents for research (don't wait)
task(agent="explore", prompt="Find auth patterns", background=true)
task(agent="researcher", prompt="Find JWT best practices", background=true)

// Continue working, collect results later
```

### Verification Protocol

**CRITICAL: Subagents can produce incomplete work. Always verify:**

1. **Files exist?** - Use glob/read
2. **Code works?** - Run lsp_diagnostics
3. **Tests pass?** - Run tests yourself
4. **Matches requirements?** - Read actual code

### Best Practices

1. **Context First, Work Second** - Always gather context before implementation
2. **Verify Everything** - Don't trust subagent claims blindly
3. **One Task at a Time** - Mark in_progress, complete immediately
4. **Use Appropriate Agents** - Frontend work → frontend agent
5. **Parallel Research** - Fire explore/researcher in parallel

---

## 18) Agent Catalog

### Primary Agents
| Agent | Purpose | Model | Switch With |
|-------|---------|-------|-------------|
| build | Implementation, orchestration | (default) | `/agent build` |
| plan | Strategic planning | quotio/gemini-claude-opus-4-5-thinking | `/agent plan` |

### Subagents
| Agent | Purpose | Model | Invoke With |
|-------|---------|-------|-------------|
| explore | Internal codebase search | zai-coding-plan/glm-4.7 | `task(agent="explore", ...)` |
| researcher | External docs/web search | zai-coding-plan/glm-4.7 | `task(agent="researcher", ...)` |
| oracle | Architecture, hard debugging | quotio/gpt-5.2-codex | `task(agent="oracle", ...)` |
| reviewer | Code review | quotio/gpt-5.2-codex | `task(agent="reviewer", ...)` |
| coder | Atomic coding tasks | quotio/gemini-claude-sonnet-4-5 | `task(agent="coder", ...)` |
| frontend | UI/UX implementation | quotio/gemini-3-pro-preview | `task(agent="frontend", ...)` |
| scribe | Documentation, prose | zai-coding-plan/glm-4.5-flash | `task(agent="scribe", ...)` |

### Model Selection Rationale

| Model | Use Case | Why |
|-------|----------|-----|
| quotio/gemini-claude-opus-4-5-thinking | Planning, orchestration | Deep reasoning with extended thinking |
| quotio/gpt-5.2-codex | Oracle, reviewer | High-IQ strategic reasoning |
| quotio/gemini-3-pro-preview | Frontend | Best for visual/UI tasks |
| quotio/gemini-claude-sonnet-4-5 | Coder | Balanced coding capability |
| zai-coding-plan/glm-4.7 | Explore, researcher | Fast, efficient for search tasks |
| zai-coding-plan/glm-4.5-flash | Scribe | Fast for documentation writing |

### Agent Tool Access

| Agent | MCPs Enabled |
|-------|--------------|
| researcher | context7, grep_app, zai-search, zai-reader, zai-zread, linear, notion |
| coder | zai-vision |
| frontend | zai-vision |
| others | None (use tools directly) |

---

## Summary

This harness is complete. With context7, grep_app,  the mcp-economy skill, and the new frontend agent, it matches upstream capabilities while staying lean and economically safe.

**Key files:**
- `opencode.jsonc` - Main configuration
- `.opencode/agent/` - Agent definitions (including frontend)
- `.opencode/skill/` - Skill definitions (including mcp-economy)
- `.opencode/command/` - Command shortcuts
- `HARNESS.md` - This document

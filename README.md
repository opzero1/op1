# OpenCode Harness

A pure OpenCode configuration harness that captures the best features from oh-my-opencode and opencode-workspace - **minimal plugins, maximum capability via skills/commands**.

## Features

### From oh-my-opencode
- **ULTRAWORK (ULW) Mode** - Maximum capability activation via skill
- **Parallel Agent Orchestration** - Fire 10+ background agents simultaneously
- **Strict Verification Guarantee** - Nothing is "done" without proof
- **Zero Tolerance for Incomplete Work** - No demos, no skeletons, no shortcuts

### From opencode-workspace
- **Clean Agent Definitions** - Markdown-based agent configuration with frontmatter
- **Philosophy Skills** - Code philosophy (5 Laws) and Frontend philosophy (5 Pillars)
- **Code Review Methodology** - 4 layers, severity classification, confidence threshold
- **Structured Workflows** - Plan → Build → Review cycle

### Native OpenCode
- **Skills** - 13 reusable knowledge modules loaded on-demand
- **Commands** - 6 quick workflow triggers
- **MCP Integrations** - Z.AI (vision, search, reader, zread), Linear, Notion, Context7, grep.app
- **Agent Permissions** - Fine-grained tool access control via frontmatter

### Harness Exclusive
- **Notify Plugin** - In-app toasts, focus detection, sounds, quiet hours
- **MCP Economy** - Cost-aware tool usage with per-agent enablement
- **3-Tier Orchestration** - Plan → Build → Verify pattern

## Installation

1. Copy this harness to your OpenCode config directory:

```bash
# Option A: As global config
cp -r opencode-harness/.opencode ~/.config/opencode/.opencode
cp opencode-harness/opencode.jsonc ~/.config/opencode/opencode.jsonc

# Option B: As project-local config
cp -r opencode-harness/.opencode /path/to/your/project/.opencode
cp opencode-harness/opencode.jsonc /path/to/your/project/opencode.jsonc
```

2. Set required environment variables (for MCP servers):

```bash
# Required for Z.AI MCPs
export Z_AI_API_KEY="your-z-ai-api-key"  # Get at: https://z.ai/manage-apikey/apikey-list

```

3. Build the notify plugin:

```bash
cd opencode-harness/.opencode/plugin
bun install && bun run build
```

The plugin is registered in `opencode.jsonc` as `"./.opencode/plugin/notify.js"` which symlinks to `dist/index.js`.

4. Restart OpenCode to load the configuration.

## Usage

### Quick Commands

| Command | Agent | Description |
|---------|-------|-------------|
| `/ulw [task]` | build | Activate ULTRAWORK mode |
 `/review [files]` | reviewer | Run comprehensive code review |
| `/research [topic]` | researcher | Research external docs/APIs |
| `/plan [task]` | plan | Create implementation plan |
| `/find [query]` | explore | Search the codebase |
| `/oracle [question]` | oracle | Consult for architecture/debugging |

### Loading Skills Directly

```
skill load ulw
skill load code-philosophy
skill load frontend-philosophy
skill load code-review
skill load git-master
skill load playwright
skill load tmux
skill load search-mode
skill load analyze-mode
skill load mcp-economy
skill load plan-protocol
skill load plan-review
skill load frontend-ui-ux
```

### Agent Delegation

```
// Codebase exploration (INTERNAL)
task(agent="explore", prompt="Find auth implementations")

// External research (EXTERNAL)
task(agent="researcher", prompt="How does NextAuth handle sessions?")

// Strategic consultation
task(agent="oracle", prompt="Should we use Redis or Postgres for sessions?")

// Code implementation
task(agent="coder", prompt="Implement the login form")

// Frontend/UI implementation
task(agent="frontend", prompt="Create the dashboard layout")

// Code review
task(agent="reviewer", prompt="Review src/auth/")

// Documentation
task(agent="scribe", prompt="Write the API documentation")
```

## Directory Structure

```
opencode-harness/
├── opencode.jsonc           # Main config (MCP, models, permissions)
├── notify.json              # Notify plugin config
├── README.md
├── AGENTS.md
├── HARNESS.md               # Detailed readiness findings and patterns
└── .opencode/
    ├── agent/               # Agents (9 total)
    │   ├── build.md         # Primary - implementation & orchestration
    │   ├── plan.md          # Primary - strategic planning
    │   ├── explore.md       # Subagent - internal codebase search
    │   ├── researcher.md    # Subagent - external research
    │   ├── oracle.md        # Subagent - architecture consultation
    │   ├── reviewer.md      # Subagent - code review
    │   ├── coder.md         # Subagent - focused coding
    │   ├── frontend.md      # Subagent - UI/UX implementation
    │   └── scribe.md        # Subagent - documentation
    ├── skill/               # Skills (13 total)
    │   ├── ulw/SKILL.md
    │   ├── search-mode/SKILL.md
    │   ├── analyze-mode/SKILL.md
    │   ├── code-philosophy/SKILL.md
    │   ├── frontend-philosophy/SKILL.md
    │   ├── frontend-ui-ux/SKILL.md
    │   ├── code-review/SKILL.md
    │   ├── git-master/SKILL.md
    │   ├── playwright/SKILL.md
    │   ├── tmux/SKILL.md
    │   ├── mcp-economy/SKILL.md
    │   ├── plan-protocol/SKILL.md
    │   └── plan-review/SKILL.md
    ├── command/             # Commands (6 total)
    │   ├── ulw.md
    │   ├── review.md
    │   ├── research.md
    │   ├── plan.md
    │   ├── find.md
    │   └── oracle.md
    └── plugin/              # Notify plugin
        ├── src/index.ts
        ├── package.json
        └── dist/            # Built plugin
```

## Agents

### Primary Agents

| Agent | Purpose | Model |
|-------|---------|-------|
| build | Implementation, orchestration | anthropic/claude-sonnet-4-20250514 |
| plan | Strategic planning | quotio/gemini-claude-opus-4-5-thinking |

### Subagents

| Agent | Purpose | Model | MCP Access |
|-------|---------|-------|------------|
| explore | Internal codebase search | zai-coding-plan/glm-4.7 | None |
| researcher | External docs/web search | zai-coding-plan/glm-4.7 | All research MCPs |
| oracle | Architecture, hard debugging | quotio/gpt-5.2-codex | None |
| reviewer | Code review | quotio/gpt-5.2-codex | None |
| coder | Atomic coding tasks | quotio/gemini-claude-sonnet-4-5 | zai-vision |
| frontend | UI/UX implementation | quotio/gemini-3-pro-preview | zai-vision |
| scribe | Documentation, prose | zai-coding-plan/glm-4.5-flash | None |

## MCP Servers

### Z.AI MCPs (Coding Plan)

| Server | Type | Purpose | Tools |
|--------|------|---------|-------|
| zai-vision | local | Image/video analysis, UI screenshots | ui_to_artifact, extract_text, diagnose_error, etc. |
| zai-search | remote | Real-time web search | webSearchPrime |
| zai-reader | remote | Fetch/parse webpage content | webReader |
| zai-zread | remote | GitHub repo understanding | search_doc, get_repo_structure, read_file |

### Project Management MCPs

| Server | Type | Purpose | Tools |
|--------|------|---------|-------|
| linear | local | Issue tracking | linear_list_issues, linear_get_issue, linear_create_issue |
| notion | local | Documentation/knowledge base | notion_search, notion_fetch, notion_list_databases |

### Research MCPs

| Server | Type | Purpose | Tools |
|--------|------|---------|-------|
| context7 | remote | Library documentation | resolve-library-id, get-library-docs |
| grep_app | remote | GitHub code search | search |

### MCP Access Policy

**All MCP tools are globally disabled and enabled per-agent:**

| Agent | MCPs Enabled |
|-------|--------------|
| researcher | All (context7, grep_app,  zai-search, zai-reader, zai-zread, linear, notion) |
| coder | zai-vision |
| frontend | zai-vision |
| others | None |

## Notify Plugin

Combined notification plugin with in-app toasts, focus detection, sounds, and quiet hours.

### Configuration (`notify.json`)

```json
{
  "terminal": "wezterm",
  "notifyChildSessions": false,
  "sounds": {
    "idle": "Glass",
    "error": "Basso",
    "permission": "Submarine"
  },
  "quietHours": {
    "enabled": false,
    "start": "22:00",
    "end": "08:00"
  },
  "idleConfirmationDelay": 1500,
  "skipIfIncompleteTodos": true,
  "showToasts": true
}
```

## ULTRAWORK Mode (ULW)

The signature feature. Activate with `/ulw` or by loading the skill.

### What It Does

1. **Parallel Agent Orchestration** - Fire 3-10+ agents simultaneously
2. **Strict Verification** - Evidence required for completion
3. **Zero Scope Reduction** - Full implementation, no shortcuts
4. **TDD Enforcement** - Test-driven when infrastructure exists

### Activation

```
/ulw implement OAuth2 authentication with refresh tokens
```

Or:

```
skill load ulw
```

## Orchestration Pattern

This harness supports a 3-tier delegation pattern:

```
┌─────────────────────────────────────────────────────────────┐
│                    PLAN AGENT (Planner)                     │
│                 (Optional - Planning Phase)                  │
│  • Creates structured work plans                             │
│  • Uses explore/researcher for context gathering             │
└───────────────────┬─────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────────┐
│                 BUILD AGENT (Orchestrator)                   │
│              (Main Agent - Delegates & Verifies)             │
│  • Reads plan and delegates via task()                       │
│  • Coordinates parallel task execution                       │
│  • Verifies all subagent work                                │
└─────────┬───────────────────────────────────┬───────────────┘
          │                                   │
          ▼                                   ▼
┌─────────────────────┐             ┌──────────────────────┐
│  CODER / FRONTEND   │             │ SPECIALIST AGENTS    │
│  (Workers)          │             │                      │
│  • Execute tasks    │             │ • oracle (advice)    │
│  • Atomic work      │             │ • explore (search)   │
│  • Verify changes   │             │ • researcher (docs)  │
└─────────────────────┘             │ • reviewer (review)  │
                                    │ • scribe (docs)      │
                                    └──────────────────────┘
```

### Verification Protocol

**CRITICAL: Subagents can produce incomplete work. Always verify:**

1. **Files exist?** - Use glob/read
2. **Code works?** - Run lsp_diagnostics
3. **Tests pass?** - Run tests yourself
4. **Matches requirements?** - Read actual code

## Configuration Format

### Agent Format (`.opencode/agent/*.md`)

Agents are defined as markdown files with YAML frontmatter:

```markdown
---
description: What this agent does
mode: primary|subagent
model: provider/model-name    # optional
temperature: 0.1              # optional
color: "#00CED1"              # optional, hex color
permission:                   # optional, per-agent permissions
  edit: deny
  write: deny
  task: deny
---

# Agent Name

[Agent prompt content here...]
```

The filename becomes the agent name (e.g., `explore.md` → `explore` agent).

### Skill Format (`.opencode/skill/{name}/SKILL.md`)

Skills require a subdirectory with a `SKILL.md` file:

```markdown
---
name: skill-name
description: What this skill provides
---

# Skill Title

[Skill content here...]
```

### Command Format (`.opencode/command/*.md`)

Commands are markdown files with frontmatter:

```markdown
---
description: What this command does
agent: build                  # optional, which agent runs this
---

[Command template with $ARGUMENTS placeholder]
```

## Environment Variables

| Variable | Required For | Get At |
|----------|--------------|--------|
| `Z_AI_API_KEY` | zai-vision, zai-search, zai-reader, zai-zread | https://z.ai/manage-apikey/apikey-list |

Linear and Notion use OAuth - they will prompt for authentication on first use.

## Extending

This harness is designed to be extended. Add your own:

- **Skills** in `.opencode/skill/{name}/SKILL.md`
- **Commands** in `.opencode/command/{name}.md`
- **Agents** in `.opencode/agent/{name}.md`

### Optional MCPs

These can be added to `opencode.jsonc` if needed:

```jsonc
// Playwright - Browser automation
"playwright": {
  "type": "local",
  "command": ["npx", "-y", "@playwright/mcp@latest"]
}

// GitHub - PR/issue management (high token usage)
"github": {
  "type": "remote",
  "url": "https://api.githubcopilot.com/mcp/"
}

// Sentry - Error monitoring
"sentry": {
  "type": "remote",
  "url": "https://mcp.sentry.dev/mcp"
}
```

## Documentation

- **HARNESS.md** - Detailed readiness findings, gap analysis, decision log
- **AGENTS.md** - Project-specific agent guidelines

## License

MIT

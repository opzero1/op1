# AGENTS.md - OpenCode Harness

**Last Updated:** 2026-01-14  
**Purpose:** Pure OpenCode configuration harness with maximum capability orchestration

## Overview

This is a plugin-free OpenCode configuration that combines the best features from:
- **oh-my-opencode** - ULTRAWORK mode, parallel agent orchestration
- **opencode-workspace** - Clean agent definitions, philosophy skills

All agents are defined as markdown files in `.opencode/agent/` with YAML frontmatter.
OpenCode auto-loads them based on filename.

## Quick Start

```bash
# Activate ULTRAWORK mode
/ulw [task description]

# Or load skills individually
skill load ulw
skill load code-philosophy
```

## Agent Roster

| Agent | Mode | Description |
|-------|------|-------------|
| `build` | primary | Implementation - writes code, ships features |
| `plan` | primary | Strategic planning - creates work breakdowns |
| `explore` | subagent | Codebase search (INTERNAL only) |
| `researcher` | subagent | External research (docs, GitHub, web) |
| `oracle` | subagent | High-IQ consultation for hard problems |
| `reviewer` | subagent | Code review (4 layers, severity classification) |
| `coder` | subagent | Focused implementation of atomic tasks |

## Skills Available

| Skill | Description |
|-------|-------------|
| `ulw` | ULTRAWORK mode activation |
| `search-mode` | Maximum parallel search effort |
| `analyze-mode` | Deep analysis with context gathering |
| `code-philosophy` | The 5 Laws of Elegant Defense |
| `frontend-philosophy` | The 5 Pillars of Intentional UI |
| `code-review` | 4-layer review methodology |
| `git-master` | Git operations (commit, rebase, history) |
| `playwright` | Browser automation |
| `tmux` | Terminal orchestration |

## Commands Available

| Command | Agent | Purpose |
|---------|-------|---------|
| `/ulw [task]` | build | Activate ULTRAWORK mode |
| `/review [files]` | reviewer | Run code review |
| `/research [topic]` | researcher | Research external resources |
| `/plan [task]` | plan | Create implementation plan |
| `/find [query]` | explore | Search codebase |
| `/oracle [question]` | oracle | Architecture consultation |

## Agent Definition Format

Agents are markdown files in `.opencode/agent/`:

```markdown
---
description: What this agent does
mode: primary|subagent
temperature: 0.1           # optional
color: "#00CED1"           # optional
permission:                # optional
  edit: deny
  write: deny
  task: deny
---

# Agent Name

[Agent system prompt here]
```

**Key:** Filename = agent name (e.g., `explore.md` → `@explore`)

## Skill Definition Format

Skills are `SKILL.md` files in subdirectories:

```
.opencode/skill/{name}/SKILL.md
```

```markdown
---
name: skill-name
description: What this skill provides
---

# Skill Content

[Instructions loaded when skill is invoked]
```

## Workflow Patterns

### ULTRAWORK (Maximum Capability)

```
/ulw implement [feature]
```

Activates:
1. Parallel agent spawning (3-10+ simultaneous)
2. Strict verification requirements
3. Zero tolerance for incomplete work
4. Evidence-based completion

### Research-First Development

```
# Research phase
task(agent="researcher", prompt="Find best practices for X", background=true)
task(agent="explore", prompt="Find existing patterns for X", background=true)

# Wait for results, then implement
task(agent="coder", prompt="Implement X following patterns found")

# Review
task(agent="reviewer", prompt="Review implementation")
```

### Philosophy-Guided Implementation

```
# Backend work
skill load code-philosophy
# Apply the 5 Laws...

# Frontend work
skill load frontend-philosophy
# Apply the 5 Pillars...
```

## Directory Layout

```
.opencode/
├── agent/          # Agents (markdown, auto-loaded)
├── skill/          # Skills ({name}/SKILL.md format)
├── command/        # Commands (markdown)
└── plugin/         # (empty - no plugins)
```

## Extending

### Add an Agent

Create `.opencode/agent/{name}.md`:

```markdown
---
description: What this agent does
mode: subagent
---

# Agent Name

[Agent prompt...]
```

### Add a Skill

Create `.opencode/skill/{name}/SKILL.md`:

```markdown
---
name: my-skill
description: What this skill does
---

# My Skill

[Instructions...]
```

### Add a Command

Create `.opencode/command/{name}.md`:

```markdown
---
description: What this command does
agent: build
---

[Template with $ARGUMENTS placeholder]
```

## MCP Servers

| Server | Tools | Purpose |
|--------|-------|---------|
| context7 | `context7_*` | Library documentation |
| grep-app | `grep_app_*` | GitHub code search |

## Verification Protocol

From ULTRAWORK mode - applied to all significant work:

1. **Define Success Criteria** before implementation
2. **Execute with Evidence** - run builds, tests
3. **Show Output** - paste actual command results
4. **Verify Against Criteria** - check all requirements met

**Nothing is "done" without proof it works.**

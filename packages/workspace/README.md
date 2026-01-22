# @op1/workspace

Plan management plugin for OpenCode - plans, notepads, and session continuity.

## Features

- **Plan Management** - Create, save, and track implementation plans
- **Notepads** - Persist learnings, issues, and decisions
- **Cross-Session Continuity** - Resume work where you left off
- **Safety Hooks** - Output truncation and verification reminders

## Installation

```bash
bun add @op1/workspace
```

## Configuration

```json
{
  "plugin": ["@op1/workspace"]
}
```

## Tools

### Plans

| Tool | Description |
|------|-------------|
| `plan_save` | Save implementation plan |
| `plan_read` | Read the active plan |
| `plan_list` | List all plans |

### Notepads

| Tool | Description |
|------|-------------|
| `notepad_read` | Read learnings/issues/decisions |
| `notepad_write` | Append to notepad |
| `notepad_list` | List notepad files |

## Data Storage

```
<project>/.opencode/workspace/
├── plans/
│   └── {timestamp}-{slug}.md
├── notepads/
│   └── {timestamp}-{slug}/
│       ├── learnings.md
│       ├── issues.md
│       └── decisions.md
└── active-plan.json
```

## License

MIT

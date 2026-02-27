---
name: tmux
description: Terminal orchestration via tmux. Use for long-running processes, server management, parallel terminal sessions, and background task monitoring.
---

# Tmux Skill

## When to Load This Skill

- Running long-running processes (servers, watchers)
- Managing multiple terminal sessions
- Background task execution
- Parallel command execution
- Process monitoring

---

## Session Management

### Create Named Session

```bash
# Create new session
tmux new-session -d -s "op-dev"

# Run command in session
tmux send-keys -t "op-dev" "npm run dev" Enter
```

### List Sessions

```bash
tmux list-sessions
```

### Attach to Session

```bash
tmux attach -t "op-dev"
```

### Kill Session

```bash
tmux kill-session -t "op-dev"
```

---

## Session Naming Convention

Use `op-{purpose}` pattern for OpenCode-managed sessions:

| Session | Purpose |
|---------|---------|
| `op-dev` | Development server |
| `op-test` | Test watcher |
| `op-build` | Build process |
| `op-db` | Database |
| `op-logs` | Log tailing |

---

## Common Workflows

### Start Development Server

```bash
# Kill existing if any
tmux kill-session -t "op-dev" 2>/dev/null || true

# Create fresh session
tmux new-session -d -s "op-dev"
tmux send-keys -t "op-dev" "cd /path/to/project && npm run dev" Enter
```

### Check Server Output

```bash
# Capture last 50 lines
tmux capture-pane -t "op-dev" -p -S -50
```

### Run Parallel Tasks

```bash
# Create session with multiple windows
tmux new-session -d -s "op-work"
tmux send-keys -t "op-work" "npm run typecheck" Enter

tmux new-window -t "op-work"
tmux send-keys -t "op-work" "npm run lint" Enter

tmux new-window -t "op-work"
tmux send-keys -t "op-work" "npm run test" Enter
```

### Monitor Background Process

```bash
# Send command
tmux send-keys -t "op-build" "npm run build" Enter

# Wait and check output
sleep 5
tmux capture-pane -t "op-build" -p -S -20
```

---

## Window & Pane Management

### Create Windows

```bash
# New window in session
tmux new-window -t "op-dev"

# New window with name
tmux new-window -t "op-dev" -n "logs"
```

### Split Panes

```bash
# Horizontal split
tmux split-window -h -t "op-dev"

# Vertical split
tmux split-window -v -t "op-dev"
```

### Send Keys to Pane

```bash
# Send to specific pane
tmux send-keys -t "op-dev:0.1" "tail -f logs.txt" Enter
```

---

## Process Control

### Send Interrupt (Ctrl+C)

```bash
tmux send-keys -t "op-dev" C-c
```

### Send EOF (Ctrl+D)

```bash
tmux send-keys -t "op-dev" C-d
```

### Kill Pane

```bash
tmux kill-pane -t "op-dev:0.1"
```

---

## Best Practices

1. **Always use named sessions** with `op-` prefix
2. **Check if session exists** before creating
3. **Capture output** for verification evidence
4. **Clean up sessions** when done
5. **Use separate sessions** for unrelated tasks

---

## Integration with OpenCode

```bash
# Start server in background
tmux new-session -d -s "op-server" "npm run dev"

# Verify it started
sleep 3
OUTPUT=$(tmux capture-pane -t "op-server" -p -S -10)
echo "$OUTPUT" | grep -q "Server started" && echo "✅ Server running"

# When done
tmux kill-session -t "op-server"
```

# @op1/ast-grep

AST-aware code search and replace for OpenCode, powered by [ast-grep](https://ast-grep.github.io/).

## Features

- **25 Languages** - TypeScript, Python, Go, Rust, Java, and more
- **Meta-variables** - `$VAR` (single node), `$$$` (multiple nodes)
- **Auto-download** - Downloads ast-grep binary if needed
- **Dry-run Default** - Safe replacements

## Installation

```bash
bun add @op1/ast-grep
```

## Configuration

```json
{
  "plugin": ["@op1/ast-grep"]
}
```

## Tools

| Tool | Description |
|------|-------------|
| `ast_grep_search` | Search code patterns |
| `ast_grep_replace` | Replace patterns (dry-run by default) |

## Pattern Examples

| Pattern | Matches |
|---------|---------|
| `console.log($MSG)` | Any console.log call |
| `function $NAME($$$) { $$$ }` | Any function |
| `async function $NAME($$$) { $$$ }` | Async functions |

## Supported Languages

bash, c, cpp, csharp, css, go, html, java, javascript, json, kotlin, python, ruby, rust, typescript, tsx, yaml, and more.

## License

MIT

# @op1/lsp

LSP integration plugin for OpenCode - language server tools for navigation and refactoring.

## Features

- **Go to Definition** - Jump to symbol definitions
- **Find References** - Find all usages across codebase
- **Workspace Symbols** - Search symbols project-wide
- **Diagnostics** - Get errors/warnings before build
- **Rename** - Refactor symbols safely
- **50+ Language Servers** - Built-in configurations

## Installation

```bash
bun add @op1/lsp
```

## Configuration

```json
{
  "plugin": ["@op1/lsp"]
}
```

## Tools

| Tool | Description |
|------|-------------|
| `lsp_goto_definition` | Jump to symbol definition |
| `lsp_find_references` | Find all usages |
| `lsp_symbols` | Document outline or workspace search |
| `lsp_diagnostics` | Get errors/warnings |
| `lsp_prepare_rename` | Check if rename is valid |
| `lsp_rename` | Rename across codebase |

## Supported Languages

TypeScript, JavaScript, Python, Go, Rust, C/C++, Java, Ruby, PHP, and 40+ more.

## Custom Server

Add in `op1-lsp.json`:

```json
{
  "servers": {
    "my-lang": {
      "command": ["my-lang-server", "--stdio"],
      "fileExtensions": [".mylang"]
    }
  }
}
```

## License

MIT

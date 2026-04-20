# Install and prerequisites

## Install the binary

```bash
brew tap aeroxy/chrome-devtools-cli
brew install chrome-devtools
```

Or:

```bash
cargo install chrome-devtools-cli
```

The installed binary is `chrome-devtools`.

## Enable Chrome remote debugging

Before using the CLI:

1. Open Chrome
2. Visit `chrome://inspect/#remote-debugging`
3. Enable the remote debugging server

The CLI auto-connects by reading Chrome's `DevToolsActivePort` file.

## Useful flags

```bash
chrome-devtools --channel beta list-pages
chrome-devtools --user-data-dir "$HOME/Library/Application Support/Google/Chrome" list-pages
chrome-devtools --ws-endpoint ws://127.0.0.1:9222/devtools/browser/... list-pages
```

- `--channel <stable|beta|canary|dev>` selects a Chrome channel
- `--user-data-dir <path>` points at a specific Chrome profile root
- `--ws-endpoint <url>` overrides auto-discovery

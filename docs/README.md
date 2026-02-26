# docs

This folder is intentionally lightweight.

## Purpose

- Keep short, task-focused documentation that helps contributors work faster.
- Avoid long-lived duplicated docs that drift from code.
- Prefer package-level `README.md` files for package-specific behavior.

## What Belongs Here

- Cross-package guides that are not tied to a single package.
- Temporary migration notes that are still actively used.
- Contributor docs that do not fit better in a package folder.

## What Does Not Belong Here

- Reference docs that duplicate `README.md` content.
- One-off research notes (use local ignored folders instead).
- Stale implementation notes that no longer reflect the code.

## Documentation Style

- Be explicit and concise.
- Prefer checklists and concrete commands.
- Keep examples runnable with Bun.
- Update docs in the same PR as behavior changes.

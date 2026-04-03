---
name: react-doctor
description: Run after making React changes to catch issues early. Use when reviewing code, finishing a feature, or fixing bugs in a React project.
version: 1.0.0
---

# React Doctor

Scans React code for security, performance, correctness, and architecture issues. Outputs a 0-100 score with actionable diagnostics.

## Usage

```bash
npx -y react-doctor@latest . --verbose --diff
```

## Workflow

Run after making changes to catch issues early. The default command uses `--diff` to focus on changed files. Fix errors first, then re-run to verify the score improved.

---
description: Manage Lokalise keys and scoped translation sync for a ticket/tag
agent: build
skill:
  - lokalise-translations
---

Execute translation workflow for: $ARGUMENTS

Rules:

1. Verify whether each key already exists before creating.
2. If keys already exist, do not recreate; update translations only.
3. If an existing translation value would be changed, STOP and request explicit user approval before applying updates.
4. Prefer scoped tag-based pull for all PRs.
5. Use full pull only when explicitly requested for translation-sync.
6. Keep diffs minimal and avoid unrelated locale churn.
7. For new user-visible keys, verify locale coverage across all supported locales in scope.
8. If any locale stays in English fallback, ask explicit approval before committing.

Approval protocol for value updates:

- Show: key, locale, current value, proposed value.
- Ask for confirmation in one line: `Approve translation value updates? (yes/no)`
- Only proceed when user answer is explicit `yes`.

Required output:

- keys checked/created/updated
- exact pull command used
- locale coverage matrix (locale -> final value)
- files changed and why
- any risk to QA automation or release flow

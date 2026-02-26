---
name: lokalise-translations
description: Manage Lokalise translation keys and sync JSON locales for this monorepo. Use when adding new i18n keys, checking key existence in Lokalise, creating/updating keys, and pulling translation JSON files into packages/shared/translations/src/locales.
---

# Lokalise translations

Use this workflow for `@shared/translations`.

## Prerequisites

- Run in `packages/shared/translations`.
- Require env vars:
  - `LOKALISE_TOKEN`
  - `LOKALISE_PROJECT_ID` (default: `239259646152dc99c392f9.43337571`)
- Use helper wrapper from this skill: `scripts/lokalise.sh`

## Guardrails

- Default to scoped sync for all PRs (tag-based export), not full pull.
- Use full pull only for dedicated translation-sync work.
- Only create keys after verifying they do not already exist. Existing keys may be shared across projects/features.
- If an existing translation value will change, require explicit user approval before updating values.
- Do not rewrite many locale files in a feature PR unless explicitly requested; broad changes can break QA automation expectations.
- For new user-visible strings, ensure locale coverage across all supported languages in repo scope.
- If any locale must temporarily use English fallback, require explicit user approval and call it out in PR notes.

## 1) Check if key exists

```bash
scripts/lokalise.sh key list \
  --filter-keys "components.Settings.Account.profile.copy.tooltip.copy,components.Settings.Account.profile.copy.tooltip.copied" \
  --include-translations=1
```

If key exists, update translations only. If key is missing, create it.

Before updating existing values, present a change table and ask:

`Approve translation value updates? (yes/no)`

Proceed only on explicit `yes`.

## 2) Create missing key(s)

```bash
scripts/lokalise.sh key create \
  --key-name "components.Settings.Account.profile.copy.tooltip.copy" \
  --platforms web \
  --description "ENEX-2764 profile ID copy tooltip text" \
  --tags ENEX-2764,settings,account \
  --translations '[{"language_iso":"en","translation":"Copy profile ID"}]'
```

```bash
scripts/lokalise.sh key create \
  --key-name "components.Settings.Account.profile.copy.tooltip.copied" \
  --platforms web \
  --description "ENEX-2764 profile ID copied tooltip text" \
  --tags ENEX-2764,settings,account
```

If the CLI returns transient 500 errors for create with `--translations`, create first, then update translation IDs with:

```bash
scripts/lokalise.sh translation update --translation-id <id> --translation "Copied"
```

## 3) Scoped pull (preferred for PR work)

Use tag-based export for ticket-scoped updates.

First, discover locales to keep coverage aligned:

```bash
scripts/lokalise.sh language list
```

```bash
scripts/lokalise.sh file download \
  --async \
  --format json \
  --original-filenames=false \
  --bundle-structure "tmp/lokalise-tag-test/%LANG_ISO%/ENEX-2764.json" \
  --filter-langs <comma-separated-locales> \
  --include-tags ENEX-2764 \
  --placeholder-format icu \
  --replace-breaks=false
```

Then copy only required key-values into target locale files.

## 4) Full pull (only for translation-sync tasks)

```bash
scripts/lokalise.sh file download \
  --async \
  --directory-prefix src/locales/%LANG_ISO%/ \
  --format json \
  --placeholder-format icu \
  --replace-breaks=false
node pull-translations.js
```

## 5) Validation

- Re-check key presence with `key list`.
- Confirm locale JSON files contain keys under each locale folder.
- Keep key naming consistent with namespace convention: `components.Settings.Account...`.
- Before commit, verify only intended locale files changed in feature PRs.
- Include a locale coverage matrix (locale -> value) in output when adding new keys.

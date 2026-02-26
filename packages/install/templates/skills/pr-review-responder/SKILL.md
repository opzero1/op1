---
name: pr-review-responder
description: Respond to GitHub PR review comments (Copilot, human, or bot). Covers listing reviews, reading comments, posting replies, fixing code, and amending commits. Triggers on 'review comments', 'respond to review', 'copilot review', 'PR comments', 'reply to comments'.
---

# PR Review Responder

Systematically triage and respond to PR review comments.

## GitHub API Reference (gh cli)

### CRITICAL: Correct Endpoints

```bash
# List all reviews on a PR
gh api repos/{owner}/{repo}/pulls/{number}/reviews --jq '.[] | {id: .id, author: .author.login, state: .state}'

# List comments from a specific review
gh api repos/{owner}/{repo}/pulls/{number}/reviews/{review_id}/comments \
  --jq '.[] | {id: .id, path: .path, line: .line, body: .body[:80]}'

# Read a single review comment (NOTE: NOT /pulls/{number}/comments/{id})
gh api repos/{owner}/{repo}/pulls/comments/{comment_id} \
  --jq '{body: .body, path: .path, line: .line, in_reply_to_id: .in_reply_to_id}'

# List ALL PR comments with reply chains (paginated)
gh api repos/{owner}/{repo}/pulls/{number}/comments --paginate \
  --jq '.[] | {id: .id, in_reply_to: .in_reply_to_id, author: .user.login, body: .body[:80]}'

# Reply to a review comment (NOTE: use in_reply_to, NOT /replies endpoint)
gh api repos/{owner}/{repo}/pulls/{number}/comments \
  -f body="Reply text" \
  -F in_reply_to={comment_id}
```

### Common Mistakes to Avoid

| Wrong | Right | Why |
|-------|-------|-----|
| `pulls/{number}/comments/{id}` | `pulls/comments/{id}` | Single comment lookup is repo-level, not PR-level |
| `pulls/comments/{id}/replies` | `pulls/{number}/comments -F in_reply_to={id}` | `/replies` endpoint doesn't exist |
| `issues/{number}/comments` | `pulls/{number}/comments` | Issue comments are different from review comments |

## Workflow

### Step 1: Identify reviews and comments

```bash
# Get the latest review(s)
gh api repos/{owner}/{repo}/pulls/{number}/reviews \
  --jq '.[] | {id: .id, author: .author.login, state: .state, submitted: .submittedAt}'

# Get comments from the relevant review
gh api repos/{owner}/{repo}/pulls/{number}/reviews/{review_id}/comments \
  --jq '.[] | {id: .id, path: .path, line: .line, body: .body[:100]}'
```

### Step 2: Check which comments already have replies

```bash
# List all comments — replies have in_reply_to_id set
gh api repos/{owner}/{repo}/pulls/{number}/comments --paginate \
  --jq '.[] | {id: .id, in_reply_to: .in_reply_to_id, author: .user.login, body: .body[:80]}'
```

Root comments have `in_reply_to_id: null`. Replies reference the root comment ID.

### Step 3: Triage each unreplied comment

For each comment, decide:

| Verdict | Action |
|---------|--------|
| **Valid — needs code fix** | Fix the code, then reply confirming the fix |
| **Valid — already fixed** | Reply saying it's already been addressed |
| **Dismissed — intentional** | Reply explaining why the current code is correct |
| **False positive** | Reply explaining why the comment doesn't apply |

### Step 4: Apply fixes and reply

1. Fix all valid issues in code
2. Amend commit and force push (if single-commit PR)
3. Post replies to ALL unreplied comments (batch the API calls)

Reply format — keep it short:
- Valid fix: `"Good catch — fixed. [brief description of change]"`
- Already fixed: `"Already addressed — [brief description]"`
- Dismissed: `"Intentionally kept as-is. [reason]"`
- False positive: `"False positive — [reason]. Verified in [how]."`

### Step 5: Verify completeness

```bash
# Re-check: every root comment should now have a reply
gh api repos/{owner}/{repo}/pulls/{number}/comments --paginate \
  --jq '[.[] | select(.in_reply_to_id == null)] as $roots |
        [.[] | .in_reply_to_id // empty] as $replied |
        $roots[] | select([.id] - $replied | length > 0) | {id: .id, path: .path, body: .body[:60]}'
```

## Scope Filtering

PRs often have multiple reviews. Focus on the review(s) that touch YOUR changed files:

- **In-scope**: Comments on files you changed in this PR
- **Out-of-scope**: Comments on files from the full diff against base branch that aren't part of your PR's intent (common with Copilot reviewing the entire diff)

State this clearly: "The old review comments on X files are out of scope for this PR."

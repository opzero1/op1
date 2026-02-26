# ADR-0002: v1 Relational Schema Contract

- Status: Accepted
- Date: 2026-02-23
- Owner: @op1/workspace
- Depends on: `ADR-0001-v1-learning-scope.md`

## Context

`@op1/workspace` is moving from file-backed state to SQLite via Drizzle. Before wiring runtime DB access, v1 needs a stable relational schema contract covering:

- table set and ownership boundaries
- columns and types
- primary/foreign/unique/check constraints
- required indexes

This ADR defines the v1 contract for application data. Migration metadata state is specified separately in task 1.7.

## Global Conventions

- Scope: project-scoped only (see ADR-0001).
- Naming: snake_case for tables/columns and explicit names for constraints/indexes.
- IDs: text IDs (UUIDv7/ULID-compatible) generated in application code.
- Timestamps: integer milliseconds since epoch (`time_created`, `time_updated`) in UTC.
- FK behavior: `ON DELETE CASCADE` from parent records where children are meaningless without parent.
- Boolean: `INTEGER` with `CHECK (col IN (0, 1))`.

## Project Identity and Scoping Algorithm (v1)

The schema key for project isolation is `project_scopes.scope_key`.

Algorithm:
1. Resolve input directory to canonical real path (`realpath`) before any keying.
2. Detect git repo root from canonical path:
   - Prefer `git rev-parse --show-toplevel`.
   - If in a worktree, still resolve to canonical worktree path and git top-level.
3. Normalize canonical repo root:
   - trim whitespace
   - normalize separators to `/`
   - remove trailing slash (except root `/`)
   - lowercase drive letter on Windows paths
4. Build deterministic `scope_key`:
   - git repo: `git:{sha256(normalized_repo_root)}`
   - non-git fallback: `path:{sha256(normalized_canonical_path)}`
5. Collision policy:
   - `scope_key` is globally unique (`uq_project_scopes_scope_key`)
   - if hash collision is detected (same `scope_key`, different normalized path), fail closed with typed collision error
6. Symlink policy:
   - all persisted paths are canonical real paths
   - if canonicalization fails, do not proceed with writes

Schema key implications:
- `project_scopes.scope_key` is the sole identity key used by all child tables through `project_scope_id`.
- `repo_root_path` and `workspace_root_path` are informational and indexed, but not identity authorities.

## Table Contract

### 1) `project_scopes`

Represents one logical project identity used to isolate all workspace memory.

Columns:
- `id TEXT PRIMARY KEY`
- `scope_key TEXT NOT NULL` (canonical deterministic project identity string)
- `repo_root_path TEXT NOT NULL`
- `workspace_root_path TEXT NOT NULL`
- `repo_remote_url TEXT` (nullable)
- `repo_default_branch TEXT` (nullable)
- `time_created INTEGER NOT NULL`
- `time_updated INTEGER NOT NULL`

Constraints:
- `uq_project_scopes_scope_key UNIQUE (scope_key)`
- `chk_project_scopes_time_created CHECK (time_created > 0)`
- `chk_project_scopes_time_updated CHECK (time_updated > 0)`

Indexes:
- `idx_project_scopes_repo_root_path (repo_root_path)`

### 2) `plans`

Stores plan content and active state for a project scope.

Columns:
- `id TEXT PRIMARY KEY`
- `project_scope_id TEXT NOT NULL`
- `plan_name TEXT NOT NULL` (file-like identifier, eg `1769...-slug`)
- `title TEXT`
- `description TEXT`
- `status TEXT NOT NULL` (`not-started|in-progress|complete|blocked`)
- `phase INTEGER NOT NULL`
- `content_markdown TEXT NOT NULL`
- `is_active INTEGER NOT NULL DEFAULT 0`
- `source_kind TEXT NOT NULL DEFAULT 'native'` (`native|migrated`)
- `import_source_path TEXT` (nullable)
- `import_idempotency_key TEXT` (nullable)
- `time_started INTEGER` (nullable)
- `time_created INTEGER NOT NULL`
- `time_updated INTEGER NOT NULL`

Constraints:
- `fk_plans_project_scope_id FOREIGN KEY (project_scope_id) REFERENCES project_scopes(id) ON DELETE CASCADE`
- `uq_plans_scope_plan_name UNIQUE (project_scope_id, plan_name)`
- `chk_plans_status CHECK (status IN ('not-started', 'in-progress', 'complete', 'blocked'))`
- `chk_plans_phase CHECK (phase >= 1)`
- `chk_plans_is_active CHECK (is_active IN (0, 1))`
- `chk_plans_source_kind CHECK (source_kind IN ('native', 'migrated'))`

Indexes:
- `idx_plans_project_scope_id (project_scope_id)`
- `idx_plans_scope_status_updated (project_scope_id, status, time_updated)`
- `idx_plans_scope_time_started (project_scope_id, time_started)`

Active-plan invariant encoding:
- Partial unique index:
  - `uq_plans_one_active_per_scope ON plans(project_scope_id) WHERE is_active = 1`
- Transition rules:
  1. Activating a plan must be performed in a single transaction.
  2. Transaction order: deactivate previous active plan for scope (`is_active = 0`) then activate target plan (`is_active = 1`).
  3. If no active plan exists, activation is a single update.
  4. Any write path that would create two active plans in one scope must fail closed.

SQL shape (reference):

```sql
CREATE UNIQUE INDEX uq_plans_one_active_per_scope
ON plans (project_scope_id)
WHERE is_active = 1;
```

### 3) `plan_sessions`

Tracks all sessions that worked on a plan.

Columns:
- `plan_id TEXT NOT NULL`
- `session_id TEXT NOT NULL`
- `time_linked INTEGER NOT NULL`

Constraints:
- `pk_plan_sessions PRIMARY KEY (plan_id, session_id)`
- `fk_plan_sessions_plan_id FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE CASCADE`
- `chk_plan_sessions_time_linked CHECK (time_linked > 0)`

Indexes:
- `idx_plan_sessions_session_id (session_id)`

### 4) `notepad_entries`

Append-only memory log for learnings/issues/decisions.

Columns:
- `id TEXT PRIMARY KEY`
- `project_scope_id TEXT NOT NULL`
- `plan_id TEXT NOT NULL`
- `category TEXT NOT NULL` (`learnings|issues|decisions`)
- `content TEXT NOT NULL`
- `content_hash TEXT NOT NULL`
- `source_kind TEXT NOT NULL DEFAULT 'native'` (`native|migrated`)
- `source_position INTEGER` (nullable; original sequence in imported file)
- `time_created INTEGER NOT NULL`

Constraints:
- `fk_notepad_entries_project_scope_id FOREIGN KEY (project_scope_id) REFERENCES project_scopes(id) ON DELETE CASCADE`
- `fk_notepad_entries_plan_id FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE CASCADE`
- `chk_notepad_entries_category CHECK (category IN ('learnings', 'issues', 'decisions'))`
- `chk_notepad_entries_source_kind CHECK (source_kind IN ('native', 'migrated'))`
- `chk_notepad_entries_time_created CHECK (time_created > 0)`
- `uq_notepad_entries_dedupe UNIQUE (plan_id, category, content_hash, source_position)`

Indexes:
- `idx_notepad_entries_plan_category_time (plan_id, category, time_created)`
- `idx_notepad_entries_scope_time (project_scope_id, time_created)`

### 5) `worktree_refs`

Stores project worktree references to reduce repeated discovery calls.

Columns:
- `id TEXT PRIMARY KEY`
- `project_scope_id TEXT NOT NULL`
- `worktree_path TEXT NOT NULL`
- `branch_name TEXT NOT NULL`
- `base_branch TEXT`
- `session_id TEXT`
- `status TEXT NOT NULL` (`active|merged|closed|stale`)
- `time_created INTEGER NOT NULL`
- `time_updated INTEGER NOT NULL`

Constraints:
- `fk_worktree_refs_project_scope_id FOREIGN KEY (project_scope_id) REFERENCES project_scopes(id) ON DELETE CASCADE`
- `uq_worktree_refs_scope_path UNIQUE (project_scope_id, worktree_path)`
- `chk_worktree_refs_status CHECK (status IN ('active', 'merged', 'closed', 'stale'))`

Indexes:
- `idx_worktree_refs_scope_status (project_scope_id, status)`
- `idx_worktree_refs_scope_branch (project_scope_id, branch_name)`

## Out of Scope for This ADR

- migration lock tables and lock ownership protocol (task 1.11)
- schema compatibility and migration-state ledgers (task 1.7 and 1.10)
- startup gate transaction flow (task 1.12)

## Consequences

- We have a stable and explicit relational contract for implementation tasks (1.3+).
- Constraint/index names are pre-defined for migration-safe evolution.
- Scope remains project-local by schema design, matching ADR-0001.

# OpenCode Plugin Patterns

## Export Pattern (CRITICAL)

OpenCode's plugin loader iterates all exports and tries to call them. **Exporting classes at the top level causes runtime errors.**

```typescript
// ❌ DON'T: Export classes at plugin entry point
export { SemanticSearchPlugin } from "./plugin";
export { default } from "./plugin";
export { OpenAIEmbedder, MockEmbedder } from "./embedder";  // WRONG - classes exported!
// Error: "Cannot call a class constructor without |new|"

// ✅ DO: Only export plugin function and types
export { SemanticSearchPlugin } from "./plugin";
export { default } from "./plugin";
export type { Embedder, SearchResult } from "./types";  // Types only!
```

**Rule:** Plugin `index.ts` should ONLY export:
1. The plugin function (named + default)
2. Type definitions (`export type { ... }`)

## Exposing Classes for Consumers

If consumers need access to classes (e.g., `MockEmbedder` for testing), export them from a separate subpath:

```typescript
// package.json exports
"exports": {
  ".": "./dist/index.js",              // Plugin entry - no classes
  "./embedders": "./dist/embedder.js"  // Classes available separately
}
```

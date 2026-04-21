---
name: figma-design
description: Access Figma designs, extract design systems, and retrieve component specifications. Use when implementing UI from Figma mockups, extracting design tokens, or analyzing design files.
metadata:
  short-description: Figma design system and component access
---

# Figma Design

Access Figma designs, design systems, and components for frontend implementation. Extract design tokens, component specifications, and visual assets to ensure pixel-perfect implementation.

## Quick Start

1) **Identify design source** - Get Figma file URL, frame names, or component IDs from designer
2) **Extract design tokens** - Use the current token/style export capabilities for colors, typography, spacing
3) **Get component details** - Use the current node/component metadata capabilities for structure, variants, states
4) **Download assets** - Use the current screenshot/export capabilities for images, icons, and reference frames
5) **Implement with fidelity** - Match the approved design by default and use `frontend-philosophy` only when the user explicitly asks for reinterpretation

## Workflow

### 0) If any MCP call fails because Figma MCP is not connected, pause and set it up:

1. Confirm Figma is configured in the user's OpenCode setup:
   - Direct config: `~/.config/opencode/opencode.json`
   - Warmplane config: `~/.config/opencode/mcp0/mcp_servers.json`
2. If the Figma entry is missing, tell the user to add it through their OpenCode config or re-run the installer that manages their MCP setup.
3. If the entry exists but auth is missing or expired, use `mcp_oauth_helper(server="figma")` to inspect the current OAuth state and guide the user through reconnecting it.
4. Retry once the config/auth issue is fixed. If tools still do not appear after config changes, tell the user to restart OpenCode and continue from Step 1 on the next run.

### 1) Understand the Design Context

Before extracting any data, clarify:
- What Figma file or frame contains the design?
- Is there a design system or shared library?
- What component(s) need implementation?
- Are there specific variants or states (hover, active, disabled)?
- What framework is being used (React, Vue, HTML/CSS)?

**Tools to use:**
- Use the current Figma capability surface to inspect document metadata, file structure, selections, and screenshots
- If Figma is routed through Warmplane, use `mcp0-navigation` first to discover the right capability ids before making calls
- Capture stable frame/component identifiers early so later extraction and verification steps stay consistent

### 2) Extract Design System Tokens

Design tokens are the foundation of consistent UI implementation.

**Colors:**
- Inspect the shared styles or exported token surface for color primitives
- Export tokens in the format that best matches the codebase (CSS variables, Tailwind, JSON)

**Typography:**
- Inspect text styles and token exports
- Extract font families, sizes, weights, line heights
- Preserve the design font stack by default unless the user explicitly asks for reinterpretation

**Spacing & Layout:**
- Inspect frame/component layout metadata for padding, gaps, constraints, and auto-layout behavior
- Extract spacing scale (4px, 8px, 16px, 24px, etc.)
- Identify layout patterns (flexbox, grid)

**Effects:**
- Inspect effect styles for shadows, blurs, borders, gradients, and opacity

### 3) Get Component Specifications

For each component to implement:

**Structure:**
- Inspect hierarchy, bounds, and layout metadata for the target frame/component
- Review both local components and shared library components when variants may be defined elsewhere

**Styling:**
- Extract fills, strokes, effects, corner radius, typography, and spacing from the current node metadata
- Match the approved design faithfully by default; only reinterpret styling when the user explicitly asks for it

**Variants & States:**
- Inspect component variants and state-specific metadata
- Compare each variant to understand structural and stylistic differences
- Map to component props (e.g., `variant="primary"`, `size="large"`)

**Accessibility:**
- Check for accessibility labels in Figma annotations
- Extract semantic roles (button, link, heading)
- Verify color contrast meets WCAG standards

### 4) Download Visual Assets

**Images & Icons:**
- Use the server's export or screenshot capabilities to extract icons as SVG when possible
- Export raster assets at an implementation-appropriate scale
- Download referenced assets in batches when the server exposes an asset-download flow

**Reference Images:**
- Keep at least one high-quality frame screenshot or exported reference image for visual comparison during implementation

### 5) Implement with Design Fidelity

Default to design fidelity. Use `frontend-philosophy` only when the user explicitly wants interpretation or visual improvement beyond the source design.

**Typography:**
- Maintain hierarchy and scale from design tokens
- Apply proper font weights and line heights
- Keep the approved font stack unless there is an explicit product/design reason to deviate

**Color:**
- Extract color palette from Figma
- Maintain contrast ratios for accessibility
- Preserve the approved palette unless the task explicitly asks for exploration

**Spacing:**
- Use exact padding, margins, gaps from auto-layout properties
- Preserve the spacing system from the design source of truth

**Effects:**
- Extract shadows, blurs, gradients from Figma
- Reproduce the specified effects before considering any embellishment

**Motion:**
- Figma prototypes may specify transitions
- Match the documented interaction behavior; add extra motion only when explicitly requested

### 6) Verify Implementation

**Visual Comparison:**
- Export or capture a Figma frame screenshot
- Screenshot the implemented component
- Compare the screenshots for pixel-perfect accuracy

**Responsive Behavior:**
- Check Figma constraints (fixed, stretch, scale)
- Implement responsive breakpoints
- Test on multiple viewport sizes

**Accessibility:**
- Verify color contrast with Figma accessibility plugin data
- Add ARIA labels and semantic HTML
- Test keyboard navigation

## Available Tools

Exact capability ids vary by Figma server version and whether the provider is exposed directly or through Warmplane. Do not assume an older tool name exists.

### Discovery Order
1. If Figma is routed through Warmplane/mcp0 and the exact capability is unknown, use `mcp0-navigation` to discover the current Figma capability ids.
2. If Figma is exposed directly, inspect the direct `figma_*` tool surface first instead of routing through `mcp0-navigation`.
3. Prefer lightweight metadata/tree inspection before full screenshots or asset export.
4. Cache the working capability names in your notes for the rest of the task.

### Capability Categories to Look For
- **Document navigation** - file metadata, pages, tree structure, current selection
- **Design-system extraction** - styles, tokens, typography, spacing, effects
- **Component analysis** - node metadata, component variants, bounds, layout, styling
- **Asset export** - screenshots, SVG/PNG export, referenced asset download
- **Search/query** - targeted lookup when the file is large and direct inspection would be noisy

## Practical Workflows

### Design Handoff
**Goal:** Extract complete design specifications for implementation

1. Inspect file metadata and tree structure
2. Capture stable node/frame identifiers for target screens
3. Export or inspect design tokens in the format closest to the codebase
4. Read full component metadata for the target nodes
5. Export screenshots/assets needed for implementation
6. Implement component using extracted data

### Design System Audit
**Goal:** Inventory design tokens and components for consistency

1. Inspect shared color, text, and effect styles
2. Inventory the relevant local/shared components
3. Export tokens in a machine-readable format for analysis
4. Identify inconsistencies (duplicate colors, similar components)
5. Recommend consolidation or cleanup

### Component Library Migration
**Goal:** Convert Figma components to code components

1. Inventory the relevant components and variants
2. For each component:
   - Inspect variant and prop metadata
   - Extract styling details
   - Capture layout properties
3. Generate component code (React, Vue, etc.)
4. Create Storybook stories or documentation

### Visual QA & Pixel Perfection
**Goal:** Ensure implementation matches design exactly

1. Export or capture the design frame at implementation quality
2. Screenshot implemented component
3. Compare screenshots for visual parity
4. Identify discrepancies (spacing, colors, shadows)
5. Fix implementation and re-verify

### Design Token Synchronization
**Goal:** Keep code tokens in sync with Figma

1. Export current tokens from the Figma source of truth
2. Compare with existing CSS variables or Tailwind config
3. Identify changes (new colors, updated spacing)
4. Update code design system
5. Document changes and notify team

## Tips for Maximum Productivity

- **Prefer narrow capability calls** - fetch only the metadata or screenshots needed for the current step
- **Batch related inspections when supported** - avoid repeated one-node-at-a-time calls when the server offers bulk lookup
- **Export tokens early** - Get design system tokens before diving into components
- **Download reference images** - Visual context helps with implementation decisions
- **Map Figma variants to props** - Component variants become component props (e.g., `variant`, `size`, `state`)
- **Use search/query capabilities for large files** - More efficient than fetching the entire document when the provider supports it
- **Cache component IDs** - Reuse node IDs across multiple queries
- **Verify with visual comparison** - Always compare exported design vs. implementation

## Troubleshooting

- **Authentication Errors**: Reconnect the Figma MCP through the current OpenCode/Warmplane auth flow; verify workspace access and token permissions
- **File Not Found**: Verify Figma URL is correct and accessible; check file hasn't been moved or deleted
- **Node Not Found**: Re-run file/tree inspection to confirm the current node identifiers; verify the node hasn't been deleted
- **Export Failures**: Check node type supports export (frames, components); verify export settings; try different format (PNG vs SVG)
- **Missing Fonts**: Verify the design uses licensed/available fonts and map them deliberately in code when the exact face is unavailable
- **Component Import Timeout**: Narrow the query scope, fetch fewer nodes at once, and retry against a smaller frame/component target
- **Token Export Issues**: Verify design uses variables/styles (not raw values); check file has defined color/text styles
- **Rate Limits**: Batch operations, prefer targeted queries, and back off between heavy export requests

## Integration with Frontend Workflow

When working with the `frontend` agent:

1. **Load this skill first**: `skill("figma-design")` before implementation
2. **Extract design tokens** as foundation for styling
3. **Get component specs** for structure and variants
4. **Implement the approved design faithfully by default**
5. **Apply frontend-philosophy only when requested** to reinterpret or elevate the visual direction beyond the source design
6. **Verify visual fidelity** with exported reference images

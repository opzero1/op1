---
description: Research a topic using external resources (docs, GitHub, web)
agent: researcher
---

Conduct comprehensive research on the specified topic using external resources.

**Research Query:** $ARGUMENTS

If no arguments were provided, infer the research target from recent context. If no concrete target exists, ask one focused clarification question.

Use all available research tools:
1. Context7 for official library documentation when available
2. GitHub code search for real-world implementation examples
3. `webfetch` for specific pages or sources outside Context7
4. Skill-driven MCP workflows for domains like Notion, Linear, New Relic, and Figma

Requirements:
- Keep the synthesis concise but implementation-ready
- Provide code snippets only when they materially improve the answer
- Include citations for ALL findings (GitHub permalinks, URLs)
- Synthesize multiple sources into actionable recommendations
- Follow up on interesting leads without asking permission

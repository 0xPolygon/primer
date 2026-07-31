# @polygonlabs/primer-api-types

The single public home of Primer's REST API wire contract: every request and
response DTO shape, the anchor shapes stored in `threads.anchor` and returned
by the threads endpoints, and the two runtime validators used to check
untrusted anchor payloads at the edges of the system (`isTextRangeAnchor`,
`isElementPathAnchor`).

Consumers: `apps/api` (route handlers, MCP tool bridge), `apps/mcp` (comment
formatting), and `apps/web` (transitively, via the parent-side companion
protocol module).

Zero runtime dependencies. Types erase at build time; the two guard functions
and their private helpers are the package's only runtime code.

## Usage

```ts
import type { ThreadDTO, CreateThreadRequest } from '@polygonlabs/primer-api-types';
import { isTextRangeAnchor, isElementPathAnchor } from '@polygonlabs/primer-api-types';
```

## Development

This package is consumed as raw TypeScript source (`src/index.ts`) within the
Primer pnpm workspace — no build step is required for local development.
`publishConfig` points npm consumers at the compiled `dist/` output instead.

```sh
pnpm --filter @polygonlabs/primer-api-types run typecheck
pnpm --filter @polygonlabs/primer-api-types run build
```

import { describe, expectTypeOf, it } from 'vitest';
import type * as Shared from '@primer/shared/api';
// AnchorData lives in companion-protocol.ts, which has no export subpath —
// dev-only relative import, same trick the api types use internally.
import type { AnchorData as SharedAnchorData } from '../../../packages/shared/src/companion-protocol.ts';
import type * as Local from './apiTypes.ts';

/**
 * Drift guard for the locally-declared `./client` response types.
 *
 * apiTypes.ts deliberately duplicates the ~dozen interfaces the client's
 * public methods return, so the published package's declarations never
 * reference the private @primer/shared workspace package (see apiTypes.ts).
 * The cost of duplication is drift; this file makes drift a CI failure
 * instead of a silent lie: every assertion below is checked by the compiler
 * during `pnpm typecheck` (and vitest's runtime pass is a no-op).
 *
 * `toEqualTypeOf` requires mutual assignability — a field added, removed,
 * widened, or narrowed on either side fails here.
 */
describe('apiTypes drift guard (compile-time)', () => {
  it('local response types are exactly the @primer/shared shapes', () => {
    expectTypeOf<Local.UserDTO>().toEqualTypeOf<Shared.UserDTO>();
    expectTypeOf<Local.DocumentSummary>().toEqualTypeOf<Shared.DocumentSummary>();
    expectTypeOf<Local.DocumentDetail>().toEqualTypeOf<Shared.DocumentDetail>();
    expectTypeOf<Local.VersionSummary>().toEqualTypeOf<Shared.VersionSummary>();
    expectTypeOf<Local.ViewerRole>().toEqualTypeOf<Shared.ViewerRole>();
    expectTypeOf<Local.DocumentDetailResponse>().toEqualTypeOf<Shared.DocumentDetailResponse>();
    expectTypeOf<Local.VersionSummaryDTO>().toEqualTypeOf<Shared.VersionSummaryDTO>();
    expectTypeOf<Local.VersionsListResponse>().toEqualTypeOf<Shared.VersionsListResponse>();
    expectTypeOf<Local.UploadResponse>().toEqualTypeOf<Shared.UploadResponse>();
    expectTypeOf<Local.AddVersionResponse>().toEqualTypeOf<Shared.AddVersionResponse>();
    expectTypeOf<Local.CommentDTO>().toEqualTypeOf<Shared.CommentDTO>();
    expectTypeOf<Local.ThreadDTO>().toEqualTypeOf<Shared.ThreadDTO>();
    expectTypeOf<Local.ThreadsListResponse>().toEqualTypeOf<Shared.ThreadsListResponse>();
    expectTypeOf<Local.AnchorData>().toEqualTypeOf<SharedAnchorData>();
  });
});

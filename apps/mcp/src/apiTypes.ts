/**
 * Response types for the public `./client` surface — local declarations,
 * deliberately NOT imported from `@primer/shared`.
 *
 * Why: `@primer/shared` is a private, unpublished workspace package shipping
 * raw `.ts`. A published package whose `.d.ts` references it hands npm
 * consumers an unresolvable import — and bundling declarations to work
 * around that (tsup/dts-bundle-generator) would add a second bundler to a
 * deliberately esbuild-only toolchain. Owning the ~dozen interfaces the
 * client's public methods return keeps the emitted declarations
 * self-contained with plain `tsc --emitDeclarationOnly`, and is better
 * decoupling besides: a standalone package should not leak an internal
 * monorepo package through its types.
 *
 * Drift guard: `apiTypes.drift.test.ts` asserts each type here is exactly
 * assignable to its `@primer/shared` counterpart (both directions), so any
 * server-side shape change fails `pnpm typecheck` in CI.
 */

// ─────────────────────────── Users ───────────────────────────

export interface UserDTO {
  id: string;
  email: string;
  displayName: string;
}

// ────────────────────────── Documents ──────────────────────────

export interface DocumentSummary {
  id: string;
  title: string;
  description: string | null;
  uploaderId: string;
  uploaderDisplayName: string;
  visibility: 'org' | 'private';
  /** ISO timestamp. */
  createdAt: string;
}

export interface DocumentDetail extends DocumentSummary {
  externallyShared: boolean;
}

export interface VersionSummary {
  id: string;
  versionNumber: number;
  versionNote: string | null;
  sizeBytes: number;
  /** ISO timestamp. */
  createdAt: string;
}

/** The requesting viewer's effective role on a document. 'stranger' is a
 *  non-collaborator (readable only when visibility is 'org'). */
export type ViewerRole = 'owner' | 'editor' | 'commenter' | 'stranger';

export interface DocumentDetailResponse {
  document: DocumentDetail;
  latestVersion: VersionSummary;
  myRole: ViewerRole;
}

// ────────────────────────── Versions ──────────────────────────

export interface VersionSummaryDTO {
  id: string;
  versionNumber: number;
  versionNote: string | null;
  sizeBytes: number;
  createdAt: string;
}

export interface VersionsListResponse {
  versions: VersionSummaryDTO[];
}

// ─────────────────────────── Uploads ───────────────────────────

export interface UploadResponse {
  documentId: string;
  versionId: string;
  url: string;
}

export interface AddVersionResponse {
  versionId: string;
  versionNumber: number;
  url: string;
}

// ────────────────────────── Comments ──────────────────────────

export interface TextRangeAnchor {
  type: 'text-range';
  selectorText: string;
  /** Inclusive raw cumulative character offset (position-based shape). */
  start?: number;
  /** Exclusive raw cumulative character offset (position-based shape). */
  end?: number;
  /** Legacy: text-context prefix. Present on pre-v1.1 anchors. */
  prefix?: string;
  /** Legacy: text-context suffix. Present on pre-v1.1 anchors. */
  suffix?: string;
  /** Legacy: CSS path to the nearest block ancestor. Present on
   *  pre-v1.1 anchors. */
  containerPath?: string;
}

export interface ElementPathAnchor {
  type: 'element-path';
  path: string;
  innerHash: string;
  /** Captured text content of the picked element at the moment it was
   *  picked. Optional for backward-compat with rows created before this
   *  field existed. */
  innerText?: string;
}

export type AnchorData = TextRangeAnchor | ElementPathAnchor;

export interface CommentDTO {
  id: string;
  threadId: string;
  authorId: string;
  authorDisplayName: string;
  body: string;
  createdAt: string;
  updatedAt: string | null;
  deletedAt: string | null;
  mentions: string[];
}

export interface ThreadDTO {
  id: string;
  versionId: string;
  anchor: AnchorData;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolvedByDisplayName: string | null;
  createdAt: string;
  comments: CommentDTO[];
}

export interface ThreadsListResponse {
  threads: ThreadDTO[];
  asOf: string;
}

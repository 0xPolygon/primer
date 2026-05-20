import type { AnchorData } from './companion-protocol.ts';

export interface UploadResponse {
  documentId: string;
  versionId: string;
  url: string;
}

export type UploadErrorCode =
  | 'validation_failed'
  | 'parse_failed'
  | 'too_large'
  | 'bad_extension'
  | 'bad_content_type'
  | 'missing_title'
  | 'missing_file'
  | 'internal';

export interface UploadErrorResponse {
  error: UploadErrorCode;
  message: string;
}

export interface DocumentSummary {
  id: string;
  title: string;
  description: string | null;
  uploaderId: string;             // NEW in SP5
  uploaderDisplayName: string;
  createdAt: string;          // ISO timestamp
}

export interface UserDTO {
  id: string;
  email: string;
  displayName: string;
}

export interface VersionSummary {
  id: string;
  versionNumber: number;
  versionNote: string | null;
  sizeBytes: number;
  createdAt: string;          // ISO timestamp
}

export interface DocumentDetailResponse {
  document: DocumentSummary;
  latestVersion: VersionSummary;
}

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

export interface CreateThreadRequest {
  anchor: AnchorData;
  body: string;
  mentions?: string[];
}

export interface CommentBodyRequest {
  body: string;
  mentions?: string[];
}

export interface MentionableUser {
  id: string;
  displayName: string;
  email: string;
}

export interface MentionableUsersResponse {
  users: MentionableUser[];
}

export interface DashboardDocumentSummary {
  id: string;
  title: string;
  description: string | null;
  uploaderDisplayName: string;
  threadCount: number;
  activeThreadCount: number;
  lastActivityAt: string;
}

export interface DashboardActivityEntry extends DashboardDocumentSummary {
  signal: 'viewed' | 'commented';
  signalAt: string;
}

export interface DeletedDocumentEntry {
  id: string;
  title: string;
  deletedAt: string;
  daysRemaining: number;
}

export interface DashboardResponse {
  myDocuments: DashboardDocumentSummary[];
  recentlyViewedOrCommented: DashboardActivityEntry[];
  recentlyDeleted: DeletedDocumentEntry[];   // NEW in SP4
}

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

export interface DocumentPatchRequest {
  title?: string;
  description?: string | null;
}

export interface VersionPatchRequest {
  versionNote: string | null;
}

export interface AddVersionResponse {
  versionId: string;
  versionNumber: number;
  url: string;
}

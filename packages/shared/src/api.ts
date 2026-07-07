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
  visibility: 'org' | 'private';
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

export interface DeletedDocumentEntry {
  id: string;
  title: string;
  deletedAt: string;
  daysRemaining: number;
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

export interface AdminStatsBucket {
  total: number;
  last7d: number;
}

export interface DailyPoint {
  date: string;     // 'YYYY-MM-DD' UTC
  value: number;
}

export interface DailyStackPoint {
  date: string;     // 'YYYY-MM-DD' UTC
  documents: number;
  versions: number;
  comments: number;
}

export interface ThreadFlowPoint {
  date: string;
  opened: number;
  resolved: number;
}

export interface TopDocument {
  title: string;
  viewers: number;
}

export interface TopCommenter {
  displayName: string;
  comments: number;
}

export interface HistogramBucket {
  bucket: string;
  count: number;
}

export interface AdminAdoptionBlock {
  createdPerDay: DailyStackPoint[];
  activeUsersPerDay: DailyPoint[];
  cumulativeUsers: DailyPoint[];
}

export interface AdminEngagementBlock {
  topDocumentsByViewers: TopDocument[];
  topCommenters: TopCommenter[];
  viewersPerDocHistogram: HistogramBucket[];
}

export interface AdminOperationalBlock {
  storageBytesPerDay: DailyPoint[];
  threadsOpenedVsResolved: ThreadFlowPoint[];
  openThreadsAgingOver14d: {
    count: number;
    sparkline: DailyPoint[];
  };
}

export interface AdminStatsResponse {
  users: AdminStatsBucket;
  documents: AdminStatsBucket;
  versions: AdminStatsBucket;
  threads: AdminStatsBucket;
  comments: AdminStatsBucket;
  documentViews: AdminStatsBucket;

  rangeDays: 30;
  adoption: AdminAdoptionBlock;
  engagement: AdminEngagementBlock;
  operational: AdminOperationalBlock;
}

export interface DeviceAuthorizeResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export interface DeviceTokenSuccess {
  token: string;
  tokenPrefix: string;
  tokenId: string;
  expiresAt: string | null;
}

export interface DeviceTokenPending {
  error: 'authorization_pending' | 'slow_down' | 'expired_token' | 'access_denied' | 'invalid_grant';
}

export interface DevicePendingResponse {
  clientLabel: string | null;
  requesterIp: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface DeviceApproveResponse {
  clientLabel: string | null;
  requesterIp: string | null;
  createdAt: string;
}

export interface ApiTokenSummary {
  id: string;
  name: string;
  tokenPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface ApiTokensListResponse {
  tokens: ApiTokenSummary[];
}

export interface Collaborator {
  userId: string;
  displayName: string;
  role: 'commenter' | 'editor';
  grantedBy: string;
  createdAt: string;
}

export interface CollaboratorsListResponse {
  collaborators: Collaborator[];
}

export interface AddCollaboratorRequest {
  userId: string;
  role: 'commenter' | 'editor';
}

export interface UpdateCollaboratorRequest {
  role: 'commenter' | 'editor';
}

export interface UserSearchHit {
  id: string;
  displayName: string;
  email: string;
}

export interface UserSearchResponse {
  users: UserSearchHit[];
}

export interface FolderDTO {
  id: string;
  name: string;
  docCount: number;
}

export interface LibraryDocument {
  id: string;
  title: string;
  description: string | null;
  uploaderId: string;
  uploaderDisplayName: string;
  visibility: 'org' | 'private';
  ownership: 'mine' | 'collaborator' | 'org';
  threadCount: number;
  activeThreadCount: number;
  lastActivityAt: string;
  createdAt: string;
  folderId: string | null;
}

export interface LibraryResponse {
  folders: FolderDTO[];
  documents: LibraryDocument[];
  recentlyDeleted: DeletedDocumentEntry[];
}

export interface ExternalRecipientDto {
  id: string;
  email: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  firstViewedAt: string | null;
  viewCount: number;
  lastViewedAt: string | null;
}

export interface ExternalShareDto {
  id: string;
  shareToken: string;
  publishedVersionId: string | null;
  publishedVersionNumber: number | null;
  createdAt: string;
}

export interface ExternalShareResponse {
  share: ExternalShareDto | null;
  recipients: ExternalRecipientDto[];
  /** False when the server has no working email transport (NoopNotifier in
   *  production) — the sharer UI must warn that external sharing is unusable. */
  emailEnabled: boolean;
}

export interface AddExternalRecipientRequest {
  email: string;
  expiresInDays?: number; // default 90, max 365
}

export interface PublishExternalShareRequest {
  versionId: string;
}

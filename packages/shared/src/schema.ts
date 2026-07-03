import { sql } from 'drizzle-orm';
import {
  pgTable,
  text,
  uuid,
  timestamp,
  integer,
  jsonb,
  bigint,
  uniqueIndex,
  primaryKey,
  index,
} from 'drizzle-orm/pg-core';
import type { AnchorData } from './companion-protocol.ts';

export const users = pgTable('users', {
  id: text('id').primaryKey(),                                       // Okta sub (Phase 2) or "mock-user-1" (Phase 1)
  email: text('email').notNull(),
  displayName: text('display_name').notNull(),
  slackUserId: text('slack_user_id'),                                // nullable; populated in Phase 2
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const documents = pgTable('documents', {
  id: uuid('id').primaryKey(),
  title: text('title').notNull(),
  description: text('description'),
  uploaderId: text('uploader_id').notNull().references(() => users.id),
  visibility: text('visibility', { enum: ['org', 'private'] }).notNull().default('org'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const versions = pgTable(
  'versions',
  {
    id: uuid('id').primaryKey(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    versionNumber: integer('version_number').notNull(),
    storageKey: text('storage_key').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    versionNote: text('version_note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqDocVersion: uniqueIndex('versions_doc_version_unique').on(
      t.documentId,
      t.versionNumber
    ),
  })
);

export const threads = pgTable('threads', {
  id: uuid('id').primaryKey(),
  versionId: uuid('version_id')
    .notNull()
    .references(() => versions.id, { onDelete: 'cascade' }),
  anchor: jsonb('anchor').$type<AnchorData>().notNull(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolvedBy: text('resolved_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const comments = pgTable(
  'comments',
  {
    id: uuid('id').primaryKey(),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    authorId: text('author_id').notNull().references(() => users.id),
    body: text('body').notNull(),
    mentions: text('mentions').array().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    byThreadAlive: index('comments_thread_id_alive_idx')
      .on(t.threadId)
      .where(sql`${t.deletedAt} IS NULL`),
  }),
);

export const documentViews = pgTable(
  'document_views',
  {
    userId: text('user_id').notNull().references(() => users.id),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    viewedAt: timestamp('viewed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.documentId] }),
  })
);

export const documentCollaborators = pgTable(
  'document_collaborators',
  {
    id: uuid('id').primaryKey(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['commenter', 'editor'] }).notNull(),
    grantedBy: text('granted_by').notNull().references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqDocUser: uniqueIndex('document_collaborators_doc_user_unique').on(
      t.documentId,
      t.userId,
    ),
    byUser: index('document_collaborators_user_id_idx').on(t.userId),
  }),
);

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    userAgent: text('user_agent'),
  },
  (t) => ({
    byUser: index('sessions_user_id_idx').on(t.userId),
    byExpiry: index('sessions_expires_at_idx').on(t.expiresAt),
  })
);

export const apiTokens = pgTable(
  'api_tokens',
  {
    id: uuid('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),                  // e.g. "device: my-laptop" or a manual label
    tokenHash: text('token_hash').notNull(),       // sha-256 hex of the full secret
    tokenPrefix: text('token_prefix').notNull(),   // first 8 chars of the random part, for display
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),   // nullable = no expiry
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => ({
    byHash: uniqueIndex('api_tokens_token_hash_unique').on(t.tokenHash),
    byUser: index('api_tokens_user_id_idx').on(t.userId),
  }),
);

export const deviceAuthorizations = pgTable(
  'device_authorizations',
  {
    id: uuid('id').primaryKey(),
    deviceCodeHash: text('device_code_hash').notNull(),  // sha-256 of the device_code secret
    userCode: text('user_code').notNull(),               // human-typable, e.g. "WDJB-MZHT"
    status: text('status').notNull().default('pending'), // 'pending' | 'approved' | 'denied' | 'consumed'
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }), // set on approval
    clientLabel: text('client_label'),                   // optional hint from the CLI (hostname); displayed as untrusted
    requesterIp: text('requester_ip'),                   // captured at /api/device/authorize; nullable when unknown
    intervalSeconds: integer('interval_seconds').notNull().default(5),
    lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byDeviceHash: uniqueIndex('device_auth_device_code_hash_unique').on(t.deviceCodeHash),
    byUserCode: uniqueIndex('device_auth_user_code_unique').on(t.userCode),
    byExpiry: index('device_auth_expires_at_idx').on(t.expiresAt),
  }),
);

export const oauthClients = pgTable(
  'oauth_clients',
  {
    id: uuid('id').primaryKey(),
    clientId: text('client_id').notNull(),                               // public identifier
    clientName: text('client_name').notNull(),                            // from DCR metadata
    redirectUris: jsonb('redirect_uris').$type<string[]>().notNull(),
    grantTypes: jsonb('grant_types').$type<string[]>().notNull(),
    tokenEndpointAuthMethod: text('token_endpoint_auth_method').notNull().default('none'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byClientId: uniqueIndex('oauth_clients_client_id_unique').on(t.clientId),
  }),
);

export const oauthConsents = pgTable(
  'oauth_consents',
  {
    id: uuid('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    clientId: text('client_id').notNull().references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    scopes: jsonb('scopes').$type<string[]>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byUserClient: uniqueIndex('oauth_consents_user_client_unique').on(t.userId, t.clientId),
  }),
);

export const oauthAuthorizationCodes = pgTable(
  'oauth_authorization_codes',
  {
    id: uuid('id').primaryKey(),
    codeHash: text('code_hash').notNull(),                                 // sha256 hex
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    clientId: text('client_id').notNull().references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    redirectUri: text('redirect_uri').notNull(),
    codeChallenge: text('code_challenge').notNull(),
    codeChallengeMethod: text('code_challenge_method').notNull(),          // 'S256'
    scopes: jsonb('scopes').$type<string[]>().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byCodeHash: uniqueIndex('oauth_auth_codes_hash_unique').on(t.codeHash),
    byExpiry: index('oauth_auth_codes_expires_at_idx').on(t.expiresAt),
  }),
);

export const oauthAccessTokens = pgTable(
  'oauth_access_tokens',
  {
    id: uuid('id').primaryKey(),
    tokenHash: text('token_hash').notNull(),                               // sha256 hex
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    clientId: text('client_id').notNull().references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    scopes: jsonb('scopes').$type<string[]>().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byTokenHash: uniqueIndex('oauth_access_tokens_hash_unique').on(t.tokenHash),
    byExpiry: index('oauth_access_tokens_expires_at_idx').on(t.expiresAt),
  }),
);

export const oauthRefreshTokens = pgTable(
  'oauth_refresh_tokens',
  {
    id: uuid('id').primaryKey(),
    familyId: uuid('family_id').notNull(),                                 // rotation-chain grouping
    tokenHash: text('token_hash').notNull(),                               // sha256 hex
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    clientId: text('client_id').notNull().references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    scopes: jsonb('scopes').$type<string[]>().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byTokenHash: uniqueIndex('oauth_refresh_tokens_hash_unique').on(t.tokenHash),
    byFamily: index('oauth_refresh_tokens_family_idx').on(t.familyId),
  }),
);

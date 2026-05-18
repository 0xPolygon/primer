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

export const comments = pgTable('comments', {
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
});

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

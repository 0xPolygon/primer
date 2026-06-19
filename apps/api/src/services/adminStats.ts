import { count, isNull, gt, and, sql } from 'drizzle-orm';
import type {
  AdminStatsBucket,
  AdminAdoptionBlock,
  AdminEngagementBlock,
  AdminOperationalBlock,
  ThreadFlowPoint,
  HistogramBucket,
  DailyPoint,
  DailyStackPoint,
} from '@primer/shared';
import { db as defaultDb, type Db } from '../db/client.ts';
import {
  users,
  documents,
  versions,
  threads,
  comments,
  documentViews,
} from '@primer/shared/schema';

export interface AdminTotals {
  users: AdminStatsBucket;
  documents: AdminStatsBucket;
  versions: AdminStatsBucket;
  threads: AdminStatsBucket;
  comments: AdminStatsBucket;
  documentViews: AdminStatsBucket;
}

export async function buildTotals(db: Db = defaultDb): Promise<AdminTotals> {
  const since = sql<Date>`now() - interval '7 days'`;

  const [
    usersTotal,     usersLast,
    documentsTotal, documentsLast,
    versionsTotal,  versionsLast,
    threadsTotal,   threadsLast,
    commentsTotal,  commentsLast,
    viewsTotal,     viewsLast,
  ] = await Promise.all([
    db.select({ c: count() }).from(users),
    db.select({ c: count() }).from(users).where(gt(users.createdAt, since)),

    db.select({ c: count() }).from(documents).where(isNull(documents.deletedAt)),
    db.select({ c: count() }).from(documents)
      .where(and(isNull(documents.deletedAt), gt(documents.createdAt, since))),

    db.select({ c: count() }).from(versions),
    db.select({ c: count() }).from(versions).where(gt(versions.createdAt, since)),

    db.select({ c: count() }).from(threads),
    db.select({ c: count() }).from(threads).where(gt(threads.createdAt, since)),

    db.select({ c: count() }).from(comments).where(isNull(comments.deletedAt)),
    db.select({ c: count() }).from(comments)
      .where(and(isNull(comments.deletedAt), gt(comments.createdAt, since))),

    db.select({ c: count() }).from(documentViews),
    db.select({ c: count() }).from(documentViews).where(gt(documentViews.viewedAt, since)),
  ]);

  return {
    users:         { total: usersTotal[0].c,     last7d: usersLast[0].c },
    documents:     { total: documentsTotal[0].c, last7d: documentsLast[0].c },
    versions:      { total: versionsTotal[0].c,  last7d: versionsLast[0].c },
    threads:       { total: threadsTotal[0].c,   last7d: threadsLast[0].c },
    comments:      { total: commentsTotal[0].c,  last7d: commentsLast[0].c },
    documentViews: { total: viewsTotal[0].c,     last7d: viewsLast[0].c },
  };
}

const MS_PER_DAY = 86_400_000;

export function utcDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Build an ascending list of UTC YYYY-MM-DD strings ending at `endDate`.
 * `days` is inclusive: buildDateSpine(today, 30) returns 30 strings, the
 * last of which is today's UTC date.
 */
export function buildDateSpine(endDate: Date, days: number): string[] {
  const endUtcMidnight = Date.UTC(
    endDate.getUTCFullYear(),
    endDate.getUTCMonth(),
    endDate.getUTCDate(),
  );
  const result: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    result.push(utcDateString(new Date(endUtcMidnight - i * MS_PER_DAY)));
  }
  return result;
}

/**
 * Left-join a date spine against a count map, zero-filling missing days.
 */
export function leftJoinDailyCounts(
  spine: string[],
  counts: Map<string, number>,
): DailyPoint[] {
  return spine.map((date) => ({ date, value: counts.get(date) ?? 0 }));
}

const RANGE_DAYS = 30;

/**
 * Start-of-window timestamp matching spine[0] midnight UTC.
 * Returned as an ISO-8601 string because postgres-js cannot bind a JS Date
 * through drizzle's sql tag — it must be a string that Postgres implicitly
 * casts to TIMESTAMPTZ.
 */
function windowStart(endDate: Date, days: number): string {
  const ms = Date.UTC(
    endDate.getUTCFullYear(),
    endDate.getUTCMonth(),
    endDate.getUTCDate(),
  ) - (days - 1) * MS_PER_DAY;
  return new Date(ms).toISOString();
}

export async function buildAdoption(db: Db = defaultDb): Promise<AdminAdoptionBlock> {
  const now = new Date();
  const start = windowStart(now, RANGE_DAYS);
  const spine = buildDateSpine(now, RANGE_DAYS);

  // ---- A1: createdPerDay ---------------------------------------------------
  const docsByDay = sql<{ d: string; c: number }[]>`
    select to_char(date_trunc('day', created_at at time zone 'UTC'), 'YYYY-MM-DD') as d,
           count(*)::int as c
      from documents
     where deleted_at is null
       and created_at >= ${start}
     group by 1
  `;
  const versionsByDay = sql<{ d: string; c: number }[]>`
    select to_char(date_trunc('day', created_at at time zone 'UTC'), 'YYYY-MM-DD') as d,
           count(*)::int as c
      from versions
     where created_at >= ${start}
     group by 1
  `;
  const commentsByDay = sql<{ d: string; c: number }[]>`
    select to_char(date_trunc('day', created_at at time zone 'UTC'), 'YYYY-MM-DD') as d,
           count(*)::int as c
      from comments
     where deleted_at is null
       and created_at >= ${start}
     group by 1
  `;

  // ---- A2: activeUsersPerDay ----------------------------------------------
  // UNION ALL of (user_id, date) tuples across activity sources, then
  // count(distinct user_id) per day.
  const activeByDay = sql<{ d: string; c: number }[]>`
    select d, count(distinct user_id)::int as c from (
      select uploader_id as user_id,
             to_char(date_trunc('day', created_at at time zone 'UTC'), 'YYYY-MM-DD') as d
        from documents
       where deleted_at is null and created_at >= ${start}
      union all
      select author_id as user_id,
             to_char(date_trunc('day', created_at at time zone 'UTC'), 'YYYY-MM-DD') as d
        from comments
       where deleted_at is null and created_at >= ${start}
      union all
      select user_id,
             to_char(date_trunc('day', viewed_at at time zone 'UTC'), 'YYYY-MM-DD') as d
        from document_views
       where viewed_at >= ${start}
    ) s
    group by d
  `;

  // ---- A3: cumulativeUsers ------------------------------------------------
  const usersByDay = sql<{ d: string; c: number }[]>`
    select to_char(date_trunc('day', created_at at time zone 'UTC'), 'YYYY-MM-DD') as d,
           count(*)::int as c
      from users
     where created_at >= ${start}
     group by 1
  `;
  const usersBefore = sql<{ c: number }[]>`
    select count(*)::int as c from users where created_at < ${start}
  `;

  const [docRows, verRows, comRows, actRows, userRows, beforeRows] = await Promise.all([
    db.execute(docsByDay),
    db.execute(versionsByDay),
    db.execute(commentsByDay),
    db.execute(activeByDay),
    db.execute(usersByDay),
    db.execute(usersBefore),
  ]);

  const docMap = new Map(docRows.map((r) => [r.d as string, r.c as number]));
  const verMap = new Map(verRows.map((r) => [r.d as string, r.c as number]));
  const comMap = new Map(comRows.map((r) => [r.d as string, r.c as number]));
  const actMap = new Map(actRows.map((r) => [r.d as string, r.c as number]));
  const userMap = new Map(userRows.map((r) => [r.d as string, r.c as number]));
  const seed = (beforeRows[0]?.c as number) ?? 0;

  const createdPerDay: DailyStackPoint[] = spine.map((date) => ({
    date,
    documents: docMap.get(date) ?? 0,
    versions: verMap.get(date) ?? 0,
    comments: comMap.get(date) ?? 0,
  }));

  const activeUsersPerDay = leftJoinDailyCounts(spine, actMap);

  let running = seed;
  const cumulativeUsers: DailyPoint[] = spine.map((date) => {
    running += userMap.get(date) ?? 0;
    return { date, value: running };
  });

  return { createdPerDay, activeUsersPerDay, cumulativeUsers };
}

const HISTOGRAM_EDGES: { bucket: string; min: number; max: number }[] = [
  { bucket: '0',     min: 0,  max: 0   },
  { bucket: '1-2',   min: 1,  max: 2   },
  { bucket: '3-5',   min: 3,  max: 5   },
  { bucket: '6-10',  min: 6,  max: 10  },
  { bucket: '11-25', min: 11, max: 25  },
  { bucket: '26+',   min: 26, max: Infinity },
];

function bucketFor(n: number): string {
  for (const e of HISTOGRAM_EDGES) {
    if (n >= e.min && n <= e.max) return e.bucket;
  }
  return '26+';
}

export async function buildEngagement(db: Db = defaultDb): Promise<AdminEngagementBlock> {
  const since30d = windowStart(new Date(), RANGE_DAYS);

  const topDocsQ = sql<{ document_id: string; title: string; viewers: number }[]>`
    select d.id as document_id, d.title, count(distinct v.user_id)::int as viewers
      from document_views v
      join documents d on d.id = v.document_id
     where d.deleted_at is null
     group by d.id, d.title
     order by viewers desc
     limit 10
  `;
  const topCommentersQ = sql<{ user_id: string; display_name: string; comments: number }[]>`
    select c.author_id as user_id, u.display_name, count(*)::int as comments
      from comments c
      join users u on u.id = c.author_id
     where c.deleted_at is null
       and c.created_at >= ${since30d}
     group by c.author_id, u.display_name
     order by comments desc
     limit 10
  `;
  // Per-document viewer counts (LEFT JOIN so docs with zero viewers appear as 0).
  const perDocQ = sql<{ viewers: number }[]>`
    select coalesce(v.viewers, 0)::int as viewers
      from documents d
      left join (
        select document_id, count(*) as viewers
          from document_views
         group by document_id
      ) v on v.document_id = d.id
     where d.deleted_at is null
  `;

  const [topDocs, topCommenters, perDoc] = await Promise.all([
    db.execute(topDocsQ),
    db.execute(topCommentersQ),
    db.execute(perDocQ),
  ]);

  const histogramCounts = new Map<string, number>(
    HISTOGRAM_EDGES.map((e) => [e.bucket, 0]),
  );
  for (const row of perDoc) {
    const b = bucketFor(Number(row.viewers));
    histogramCounts.set(b, (histogramCounts.get(b) ?? 0) + 1);
  }
  const viewersPerDocHistogram: HistogramBucket[] = HISTOGRAM_EDGES.map((e) => ({
    bucket: e.bucket,
    count: histogramCounts.get(e.bucket) ?? 0,
  }));

  return {
    topDocumentsByViewers: topDocs.map((r) => ({
      documentId: r.document_id as string,
      title: r.title as string,
      viewers: Number(r.viewers),
    })),
    topCommenters: topCommenters.map((r) => ({
      userId: r.user_id as string,
      displayName: r.display_name as string,
      comments: Number(r.comments),
    })),
    viewersPerDocHistogram,
  };
}

export async function buildOperational(db: Db = defaultDb): Promise<AdminOperationalBlock> {
  // Snap "now" to today's midnight UTC so the scalar count and sparkline last
  // point share the same reference timestamp (the boundary between "today" and
  // the future for aging-thread classification).
  const rawNow = new Date();
  const now = new Date(Date.UTC(
    rawNow.getUTCFullYear(),
    rawNow.getUTCMonth(),
    rawNow.getUTCDate(),
  ));
  const nowIso = now.toISOString();
  const start = windowStart(now, RANGE_DAYS);
  const spine = buildDateSpine(now, RANGE_DAYS);

  // ---- O1: storageBytesPerDay (cumulative) ---------------------------------
  // O1 sums all version bytes regardless of document soft-delete state — the
  // blobs still occupy storage until the soft-delete is hard-purged, so the
  // chart reflects actual storage footprint, not "live" content size.
  const inWindowStorage = sql<{ d: string; c: number }[]>`
    select to_char(date_trunc('day', created_at at time zone 'UTC'), 'YYYY-MM-DD') as d,
           coalesce(sum(size_bytes), 0)::bigint::float8 as c
      from versions
     where created_at >= ${start}
     group by 1
  `;
  const preWindowStorage = sql<{ c: number }[]>`
    select coalesce(sum(size_bytes), 0)::bigint::float8 as c
      from versions
     where created_at < ${start}
  `;

  // ---- O2: threadsOpenedVsResolved ----------------------------------------
  const opensByDay = sql<{ d: string; c: number }[]>`
    select to_char(date_trunc('day', created_at at time zone 'UTC'), 'YYYY-MM-DD') as d,
           count(*)::int as c
      from threads
     where created_at >= ${start}
     group by 1
  `;
  const resolvesByDay = sql<{ d: string; c: number }[]>`
    select to_char(date_trunc('day', resolved_at at time zone 'UTC'), 'YYYY-MM-DD') as d,
           count(*)::int as c
      from threads
     where resolved_at >= ${start}
     group by 1
  `;

  // ---- O3: openThreadsAgingOver14d ----------------------------------------
  const agingCountQ = sql<{ c: number }[]>`
    select count(*)::int as c
      from threads
     where resolved_at is null
       and created_at < ${nowIso}::timestamptz - interval '14 days'
  `;
  // Sparkline: for each day d in the spine, count threads where
  // created_at < (d - 14 days) AND (resolved_at IS NULL OR resolved_at > d).
  const agingSparkQ = sql<{ d: string; c: number }[]>`
    with spine as (
      select to_char(d at time zone 'UTC', 'YYYY-MM-DD') as d, d as ts
        from generate_series(${start}::timestamptz, ${nowIso}::timestamptz, '1 day'::interval) d
    )
    select s.d, count(t.*)::int as c
      from spine s
      left join threads t
        on t.created_at < s.ts - interval '14 days'
       and (t.resolved_at is null or t.resolved_at > s.ts)
     group by s.d
  `;

  const [stoRows, stoSeedRows, openRows, resRows, agingRows, sparkRows] = await Promise.all([
    db.execute(inWindowStorage),
    db.execute(preWindowStorage),
    db.execute(opensByDay),
    db.execute(resolvesByDay),
    db.execute(agingCountQ),
    db.execute(agingSparkQ),
  ]);

  const stoMap = new Map(stoRows.map((r) => [r.d as string, Number(r.c)]));
  const seed = Number(stoSeedRows[0]?.c ?? 0);
  let running = seed;
  const storageBytesPerDay: DailyPoint[] = spine.map((date) => {
    running += stoMap.get(date) ?? 0;
    return { date, value: running };
  });

  const openMap = new Map(openRows.map((r) => [r.d as string, Number(r.c)]));
  const resMap = new Map(resRows.map((r) => [r.d as string, Number(r.c)]));
  const threadsOpenedVsResolved: ThreadFlowPoint[] = spine.map((date) => ({
    date,
    opened: openMap.get(date) ?? 0,
    resolved: resMap.get(date) ?? 0,
  }));

  const sparkMap = new Map(sparkRows.map((r) => [r.d as string, Number(r.c)]));
  const sparkline = leftJoinDailyCounts(spine, sparkMap);

  return {
    storageBytesPerDay,
    threadsOpenedVsResolved,
    openThreadsAgingOver14d: {
      count: Number(agingRows[0]?.c ?? 0),
      sparkline,
    },
  };
}

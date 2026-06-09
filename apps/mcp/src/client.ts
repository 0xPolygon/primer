import type {
  AddVersionResponse,
  DocumentDetailResponse,
  ThreadsListResponse,
  UploadResponse,
  UserDTO,
  VersionsListResponse,
} from '@primer/shared/api';

/**
 * Machine-checkable error codes returned by every PrimerApiError.
 * See spec D17 — the skill and tool layer branch on `code`, never on
 * message text. `login_denied` / `login_expired` are emitted by the
 * device-login helpers (B4), not by this HTTP client.
 */
export type PrimerErrorCode =
  | 'not_authenticated'
  | 'forbidden'
  | 'not_found'
  | 'bad_request'
  | 'rate_limited'
  | 'network'
  | 'login_denied'
  | 'login_expired';

export class PrimerApiError extends Error {
  readonly code: PrimerErrorCode;
  readonly status?: number;

  constructor(code: PrimerErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'PrimerApiError';
    this.code = code;
    this.status = status;
  }
}

export interface PrimerClientOptions {
  /** Base URL, e.g. `http://localhost:3000` or `https://primer.up.railway.app`.
   *  A trailing slash is stripped during construction. */
  baseUrl: string;
  /** `primer_pat_…` bearer token. */
  token: string;
  /** Injectable for tests; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

export type DocumentFormat = 'markdown' | 'html';

export interface CreateDocumentInput {
  title: string;
  description?: string;
  content: string;
  format: DocumentFormat;
  /** Template id the content was built with (see @primer/shared/templates). */
  template?: string;
}

export interface AddVersionInput {
  documentId: string;
  content: string;
  format: DocumentFormat;
  versionNote?: string;
  /** Template id the content was built with (see @primer/shared/templates). */
  template?: string;
}

interface RequestOptions {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  body?: FormData;
}

/** Carries the parsed body of a non-2xx response, when JSON-decodable. */
interface ApiErrorBody {
  error?: string;
  message?: string;
}

function statusToCode(status: number): PrimerErrorCode {
  if (status === 401) return 'not_authenticated';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 400) return 'bad_request';
  if (status === 429) return 'rate_limited';
  // 5xx (and any other non-2xx we don't have a specific code for) collapses to
  // bad_request for v1 — the original status is surfaced via error.status so
  // callers can still tell the difference if they need to.
  return 'bad_request';
}

async function parseErrorBody(res: Response): Promise<ApiErrorBody | null> {
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) return null;
  try {
    const parsed = (await res.json()) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as ApiErrorBody;
    return null;
  } catch {
    return null;
  }
}

async function parseSuccessBody<T>(res: Response): Promise<T> {
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    // The API always returns JSON on success today (no 204s on the endpoints
    // this client uses). If a future endpoint changes that, the caller can
    // cast appropriately — but for now we treat a non-JSON success as empty.
    return undefined as T;
  }
  return (await res.json()) as T;
}

export class PrimerClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: PrimerClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    // Bind to preserve `this` for the global fetch on platforms that care
    // (Node's undici is strict about this).
    const f = opts.fetchImpl ?? globalThis.fetch;
    this.fetchImpl = ((input, init) => f(input, init)) as typeof fetch;
  }

  // ────────────────────────────── Public API ──────────────────────────────

  whoami(): Promise<UserDTO> {
    return this.request<UserDTO>({ method: 'GET', path: '/api/me' });
  }

  getDocument(documentId: string): Promise<DocumentDetailResponse> {
    return this.request<DocumentDetailResponse>({
      method: 'GET',
      path: `/api/documents/${encodeURIComponent(documentId)}`,
    });
  }

  listVersions(documentId: string): Promise<VersionsListResponse> {
    return this.request<VersionsListResponse>({
      method: 'GET',
      path: `/api/documents/${encodeURIComponent(documentId)}/versions`,
    });
  }

  getVersionThreads(versionId: string): Promise<ThreadsListResponse> {
    return this.request<ThreadsListResponse>({
      method: 'GET',
      path: `/api/versions/${encodeURIComponent(versionId)}/threads`,
    });
  }

  createDocument(input: CreateDocumentInput): Promise<UploadResponse> {
    const fd = new FormData();
    fd.append('file', buildFileBlob(input.content, input.format), filenameFor(input.format));
    fd.append('title', input.title);
    if (input.description !== undefined) {
      fd.append('description', input.description);
    }
    if (input.template !== undefined) {
      fd.append('template', input.template);
    }
    return this.request<UploadResponse>({
      method: 'POST',
      path: '/api/upload',
      body: fd,
    });
  }

  addVersion(input: AddVersionInput): Promise<AddVersionResponse> {
    const fd = new FormData();
    fd.append('file', buildFileBlob(input.content, input.format), filenameFor(input.format));
    if (input.versionNote !== undefined) {
      fd.append('versionNote', input.versionNote);
    }
    if (input.template !== undefined) {
      fd.append('template', input.template);
    }
    return this.request<AddVersionResponse>({
      method: 'POST',
      path: `/api/documents/${encodeURIComponent(input.documentId)}/versions`,
      body: fd,
    });
  }

  /** Server responds `{ ok: true }` on success; we discard the body. */
  async revokeToken(tokenId: string): Promise<void> {
    await this.request<{ ok: true }>({
      method: 'DELETE',
      path: `/api/tokens/${encodeURIComponent(tokenId)}`,
    });
  }

  // ─────────────────────────────── Internals ───────────────────────────────

  private async request<T>(opts: RequestOptions): Promise<T> {
    const url = `${this.baseUrl}${opts.path}`;
    // For multipart bodies we intentionally DO NOT set Content-Type — fetch
    // writes it with the correct boundary. Setting it manually breaks parsing.
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
    };

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: opts.method,
        headers,
        body: opts.body,
      });
    } catch (err) {
      // Network-layer failure (DNS, ECONNREFUSED, TLS, etc.) — never let a
      // raw fetch error escape; the tool layer needs a typed code to branch on.
      const message = err instanceof Error ? err.message : String(err);
      throw new PrimerApiError('network', message);
    }

    if (!res.ok) {
      const body = await parseErrorBody(res);
      const code = statusToCode(res.status);
      const message = body?.message ?? body?.error ?? res.statusText ?? `HTTP ${res.status}`;
      throw new PrimerApiError(code, message, res.status);
    }

    return parseSuccessBody<T>(res);
  }
}

function filenameFor(format: DocumentFormat): string {
  return format === 'markdown' ? 'doc.md' : 'doc.html';
}

function contentTypeFor(format: DocumentFormat): string {
  return format === 'markdown' ? 'text/markdown' : 'text/html';
}

function buildFileBlob(content: string, format: DocumentFormat): Blob {
  return new Blob([content], { type: contentTypeFor(format) });
}

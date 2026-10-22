import type {
  AdminAuditEntry,
  AdminOverview,
  AdminUser,
  AppState,
  AuditEntry,
  ClaimResponse,
  CreateUserRequest,
  CreateUserResponse,
  ResetUserRequest,
  ResetUserResponse,
  UpdateUserRequest,
  ChatSummary,
  DeletedFeedPage,
  LoginResponse,
  Message,
  MessageEdit,
  MessagePage,
  RecoverResponse,
  RotateRecoveryKeyResponse,
  SearchResponse,
  SendMediaKind,
  SendResult,
  SessionInfo,
  Settings,
  StoryAccount,
  StoryAuthor,
  StoryPage,
  StoryStatus,
  SignupResponse,
  TotpSetupResponse,
  UploadResponse,
  VncCredentials,
  TtStatus,
  TtDiagnostics,
  PageProbe,
  FeedItem,
  FeedComment,
  FeedCommentPage,
} from '../../../shared/api';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let csrfToken = '';
let onUnauthorized: (() => void) | null = null;

export function setCsrfToken(token: string | undefined): void {
  csrfToken = token ?? '';
}

export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

async function request<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const init: RequestInit = { method, headers, credentials: 'same-origin', cache: 'no-store', redirect: 'error' };
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body ?? {});
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  }
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new ApiError(0, 'network', 'Cannot reach the server. Check your connection.');
  }
  let data: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; retryAfter?: number } } | null)?.error;
    if (res.status === 401 && err?.code === 'unauthorized') onUnauthorized?.();
    throw new ApiError(res.status, err?.code ?? 'http_error', err?.message ?? `Request failed (${res.status}).`, err?.retryAfter);
  }
  return data as T;
}

const enc = encodeURIComponent;

/** Raw file upload (the only non-JSON request): the name goes in a header, never in the URL. */
async function uploadFile(file: Blob, filename: string | null): Promise<UploadResponse> {
  const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/octet-stream' };
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  if (file.type) headers['X-File-Type'] = file.type;
  if (filename) headers['X-Filename'] = encodeURIComponent(filename);
  let res: Response;
  try {
    res = await fetch('/api/uploads', { method: 'POST', headers, body: file, credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
  } catch {
    throw new ApiError(0, 'network', 'Cannot reach the server. Check your connection.');
  }
  const data = (await res.json().catch(() => null)) as UploadResponse | { error?: { code?: string; message?: string } } | null;
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
    if (res.status === 413) throw new ApiError(413, 'too_large', 'The file is too large (64 MB at most).');
    throw new ApiError(res.status, err?.code ?? 'http_error', err?.message ?? `Upload failed (${res.status}).`);
  }
  return data as UploadResponse;
}

export const api = {
  state: () => request<AppState>('GET', '/api/state'),

  signup: (setupToken: string, username: string, password: string) =>
    request<SignupResponse>('POST', '/api/auth/signup', { setupToken, username, password }),
  login: (username: string, password: string, totp?: string) =>
    request<LoginResponse>('POST', '/api/auth/login', { username, password, ...(totp ? { totp } : {}) }),
  claim: (username: string, password: string, newPassword: string, recoveryKey?: string) =>
    request<ClaimResponse>('POST', '/api/auth/claim', { username, password, newPassword, ...(recoveryKey ? { recoveryKey } : {}) }),
  logout: () => request<{ ok: true }>('POST', '/api/auth/logout'),
  logoutAll: () => request<{ ok: true }>('POST', '/api/auth/logout-all'),
  recover: (username: string, recoveryKey: string, newPassword: string) =>
    request<RecoverResponse>('POST', '/api/auth/recover', { username, recoveryKey, newPassword }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: true }>('POST', '/api/auth/password', { currentPassword, newPassword }),
  sessions: () => request<SessionInfo[]>('GET', '/api/auth/sessions'),
  revokeSession: (id: string) => request<{ ok: true }>('DELETE', `/api/auth/sessions/${enc(id)}`),
  totpSetup: () => request<TotpSetupResponse>('POST', '/api/auth/totp/setup'),
  totpEnable: (code: string, password: string) => request<{ ok: true }>('POST', '/api/auth/totp/enable', { code, password }),
  totpDisable: (password: string, code: string) => request<{ ok: true }>('POST', '/api/auth/totp/disable', { password, code }),
  rotateRecoveryKey: (password: string, totp?: string) =>
    request<RotateRecoveryKeyResponse>('POST', '/api/auth/recovery-key/rotate', { password, ...(totp ? { totp } : {}) }),

  ttStatus: () => request<TtStatus>('GET', '/api/tt/status'),
  ttRestart: () => request<{ ok: true }>('POST', '/api/tt/restart'),
  ttLogout: () => request<{ ok: true }>('POST', '/api/tt/logout'),
  ttImportSession: (cookies: string) => request<{ ok: true }>('POST', '/api/tt/session', { cookies }),
  ttDiagnostics: () => request<TtDiagnostics>('GET', '/api/tt/diagnostics'),
  ttProbe: () => request<PageProbe>('POST', '/api/tt/probe'),
  completeOnboarding: (force = false) => request<{ ok: true }>('POST', '/api/onboarding/complete', force ? { force: true } : {}),
  vncCredentials: () => request<VncCredentials>('GET', '/api/vnc/credentials'),

  chats: () => request<ChatSummary[]>('GET', '/api/chats'),

  feed: () => request<{ item: FeedItem | null }>('GET', '/api/feed'),
  feedStep: (dir: 'next' | 'prev') => request<{ item: FeedItem }>('POST', '/api/feed/step', { dir }),
  /** The video in view plus the next few, for the swiping feed. */
  feedWindow: (limit = 3) => request<{ items: FeedItem[]; current: string | null }>('GET', `/api/feed/window?limit=${limit}`),
  /** The user swiped to a video: move the remote page there and get a fresh window. */
  feedGoto: (id: string) => request<{ items: FeedItem[]; current: string | null }>('POST', '/api/feed/goto', { id }),
  feedLike: (id: string, like: boolean) => request<{ liked: boolean }>('POST', `/api/feed/${enc(id)}/like`, { like }),
  /** Shares a feed video into a chat as a TikTok card. */
  feedShare: (id: string, chatId: string) => request<{ id: string }>('POST', `/api/feed/${enc(id)}/share`, { chatId }),
  feedComments: (id: string) => request<FeedCommentPage>('GET', `/api/feed/${enc(id)}/comments`),
  feedComment: (id: string, text: string) => request<FeedCommentPage>('POST', `/api/feed/${enc(id)}/comment`, { text }),
  feedCloseComments: () => request<{ ok: true }>('POST', '/api/feed/comments/close'),
  messages: (chatId: string, before?: string | null, limit = 60) =>
    request<MessagePage>('GET', `/api/chats/${enc(chatId)}/messages?limit=${limit}${before ? `&before=${enc(before)}` : ''}`),
  messagesAfter: (chatId: string, after: string, limit = 100) =>
    request<MessagePage>('GET', `/api/chats/${enc(chatId)}/messages/after?after=${enc(after)}&limit=${limit}`),
  messagesAround: (chatId: string, messageId: string, limit = 60) =>
    request<MessagePage>('GET', `/api/chats/${enc(chatId)}/messages/around/${enc(messageId)}?limit=${limit}`),
  message: (messageId: string) => request<Message>('GET', `/api/messages/${enc(messageId)}`),
  edits: (messageId: string) => request<MessageEdit[]>('GET', `/api/messages/${enc(messageId)}/edits`),
  retryMedia: (messageId: string) => request<{ ok: true }>('POST', `/api/messages/${enc(messageId)}/media/retry`),
  deleted: (before?: string | null) => request<DeletedFeedPage>('GET', `/api/deleted?limit=50${before ? `&before=${enc(before)}` : ''}`),
  search: (q: string, chatId?: string) =>
    request<SearchResponse>('GET', `/api/search?q=${enc(q)}${chatId ? `&chatId=${enc(chatId)}` : ''}`),

  sendText: (chatId: string, text: string, quotedId?: string | null) =>
    request<SendResult>('POST', `/api/chats/${enc(chatId)}/send`, { text, ...(quotedId ? { quotedId } : {}) }),
  upload: (file: Blob, filename: string | null) => uploadFile(file, filename),
  sendMedia: (chatId: string, uploadId: string, kind: SendMediaKind, quotedId?: string | null) =>
    request<SendResult>('POST', `/api/chats/${enc(chatId)}/send-media`, { uploadId, kind, ...(quotedId ? { quotedId } : {}) }),
  react: (messageId: string, emoji: string) => request<{ ok: true }>('POST', `/api/messages/${enc(messageId)}/react`, { emoji }),
  unsend: (messageId: string) => request<{ ok: true }>('POST', `/api/messages/${enc(messageId)}/unsend`),
  editMessage: (messageId: string, text: string) => request<{ ok: true }>('POST', `/api/messages/${enc(messageId)}/edit`, { text }),
  markRead: (chatId: string) => request<{ ok: true }>('POST', `/api/chats/${enc(chatId)}/read`),

  storiesStatus: () => request<StoryStatus>('GET', '/api/stories/status'),
  storiesCheck: () => request<StoryStatus>('POST', '/api/stories/check'),
  storiesAuthors: () => request<StoryAuthor[]>('GET', '/api/stories/authors'),
  storiesAccounts: () => request<StoryAccount[]>('GET', '/api/stories/accounts'),
  stories: (q: { user?: string; before?: number | null; limit?: number } = {}) => {
    const p = new URLSearchParams();
    if (q.user) p.set('user', q.user);
    if (q.before) p.set('before', String(q.before));
    p.set('limit', String(q.limit ?? 60));
    return request<StoryPage>('GET', `/api/stories?${p.toString()}`);
  },
  settings: () => request<Settings>('GET', '/api/settings'),
  updateSettings: (patch: Partial<Settings>) => request<Settings>('PUT', '/api/settings', patch),
  audit: (before?: number) => request<AuditEntry[]>('GET', `/api/audit?limit=100${before ? `&before=${before}` : ''}`),
  adminOverview: () => request<AdminOverview>('GET', '/api/admin/overview'),
  adminCreateUser: (body: CreateUserRequest) => request<CreateUserResponse>('POST', '/api/admin/users', body),
  adminUpdateUser: (id: number, body: UpdateUserRequest) => request<AdminUser>('PATCH', `/api/admin/users/${id}`, body),
  adminResetUser: (id: number, body: ResetUserRequest) => request<ResetUserResponse>('POST', `/api/admin/users/${id}/reset`, body),
  adminDeleteUser: (id: number, adminPassword: string, totp?: string) =>
    request<{ ok: true }>('POST', `/api/admin/users/${id}/delete`, { adminPassword, ...(totp ? { totp } : {}) }),
  adminPutPort: (port: number, origin: string | null) => request<{ ok: true }>('PUT', `/api/admin/ports/${port}`, { origin }),
  adminDeletePort: (port: number) => request<{ ok: true }>('DELETE', `/api/admin/ports/${port}`),
  adminAudit: () => request<AdminAuditEntry[]>('GET', '/api/admin/audit?limit=100'),
  wipe: (password: string, totp?: string) => request<{ ok: true }>('POST', '/api/data/wipe', { password, ...(totp ? { totp } : {}) }),
};

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.retryAfter) return `${e.message} (retry in ${e.retryAfter}s)`;
    return e.message;
  }
  return 'Something went wrong.';
}

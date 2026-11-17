// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * oa-api-client.ts — Gọi Zalo OA OpenAPI (thuần HTTP, không phụ thuộc DB → dễ test).
 *
 * Tài liệu: https://developers.zalo.me/docs/official-account
 *   • OAuth v4 (OA):   https://oauth.zaloapp.com/v4/oa/permission  |  /v4/oa/access_token
 *   • OA info:         GET  https://openapi.zalo.me/v2.0/oa/getoa
 *   • Người theo dõi:  GET  https://openapi.zalo.me/v3.0/oa/user/getlist | /user/detail
 *   • Tin tư vấn (CS): POST https://openapi.zalo.me/v3.0/oa/message/cs
 *   • ZNS:             POST https://business.openapi.zalo.me/message/template
 *                      GET  https://business.openapi.zalo.me/template/all
 *
 * Zalo trả HTTP 200 kèm { error: <số khác 0>, message } khi lỗi nghiệp vụ → ném ZaloOaApiError.
 */
export const ZALO_OAUTH_BASE = 'https://oauth.zaloapp.com/v4/oa';
export const ZALO_OPENAPI_BASE = 'https://openapi.zalo.me';
export const ZALO_BUSINESS_BASE = 'https://business.openapi.zalo.me';

export class ZaloOaApiError extends Error {
  constructor(message: string, public readonly code: number | string, public readonly raw?: unknown) {
    super(message);
    this.name = 'ZaloOaApiError';
  }
  /** Token hết hạn / không hợp lệ → nên refresh rồi thử lại. */
  get isTokenError(): boolean {
    return this.code === -216 || this.code === -124 || this.code === -14014;
  }
}

type FetchLike = typeof fetch;
let fetchImpl: FetchLike = (...args) => fetch(...args);
/** Cho test thay fetch. */
export function __setFetch(f: FetchLike | null): void {
  fetchImpl = f ?? ((...args) => fetch(...args));
}

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new ZaloOaApiError(`Zalo trả dữ liệu không phải JSON (HTTP ${res.status})`, res.status, text.slice(0, 300));
  }
}

function assertOk(body: any, what: string): any {
  if (body && typeof body.error === 'number' && body.error !== 0) {
    throw new ZaloOaApiError(`${what}: ${body.message ?? 'lỗi'} (mã ${body.error})`, body.error, body);
  }
  return body;
}

// ── OAuth ──────────────────────────────────────────────────────────────────

export function buildPermissionUrl(args: { appId: string; redirectUri: string; codeChallenge: string; state: string }): string {
  const u = new URL(`${ZALO_OAUTH_BASE}/permission`);
  u.searchParams.set('app_id', args.appId);
  u.searchParams.set('redirect_uri', args.redirectUri);
  u.searchParams.set('code_challenge', args.codeChallenge);
  u.searchParams.set('state', args.state);
  return u.toString();
}

export interface OaTokenResponse {
  accessToken: string;
  refreshToken: string;
  /** giây */
  expiresIn: number;
}

async function tokenRequest(appSecret: string, form: Record<string, string>, what: string): Promise<OaTokenResponse> {
  const res = await fetchImpl(`${ZALO_OAUTH_BASE}/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', secret_key: appSecret },
    body: new URLSearchParams(form).toString(),
  });
  const body = await readJson(res);
  if (!body?.access_token) {
    const code = body?.error ?? res.status;
    const msg = body?.error_description || body?.error_name || body?.message || 'không nhận được access_token';
    throw new ZaloOaApiError(`${what}: ${msg}`, code, body);
  }
  return {
    accessToken: String(body.access_token),
    refreshToken: String(body.refresh_token ?? ''),
    expiresIn: Number(body.expires_in ?? 90000) || 90000,
  };
}

export function exchangeCode(args: { appId: string; appSecret: string; code: string; codeVerifier: string }): Promise<OaTokenResponse> {
  return tokenRequest(args.appSecret, {
    app_id: args.appId,
    code: args.code,
    grant_type: 'authorization_code',
    code_verifier: args.codeVerifier,
  }, 'Đổi mã OAuth lấy token');
}

export function refreshAccessToken(args: { appId: string; appSecret: string; refreshToken: string }): Promise<OaTokenResponse> {
  return tokenRequest(args.appSecret, {
    app_id: args.appId,
    refresh_token: args.refreshToken,
    grant_type: 'refresh_token',
  }, 'Làm mới token');
}

// ── OpenAPI ────────────────────────────────────────────────────────────────

async function oaGet(accessToken: string, url: string, what: string): Promise<any> {
  const res = await fetchImpl(url, { headers: { access_token: accessToken } });
  return assertOk(await readJson(res), what);
}

async function oaPost(accessToken: string, url: string, payload: unknown, what: string): Promise<any> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { access_token: accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return assertOk(await readJson(res), what);
}

export interface OaInfo { oaId: string; name: string | null; avatar: string | null }

export async function getOaInfo(accessToken: string): Promise<OaInfo> {
  const body = await oaGet(accessToken, `${ZALO_OPENAPI_BASE}/v2.0/oa/getoa`, 'Lấy thông tin OA');
  const d = body?.data ?? {};
  return { oaId: String(d.oa_id ?? ''), name: d.name ?? null, avatar: d.avatar ?? null };
}

export async function listFollowers(accessToken: string, offset: number, count = 50): Promise<{ total: number; userIds: string[] }> {
  const data = encodeURIComponent(JSON.stringify({ offset, count, is_follower: 'true' }));
  const body = await oaGet(accessToken, `${ZALO_OPENAPI_BASE}/v3.0/oa/user/getlist?data=${data}`, 'Lấy danh sách người theo dõi');
  const d = body?.data ?? {};
  const users: Array<{ user_id?: string | number }> = Array.isArray(d.users) ? d.users : [];
  return { total: Number(d.total ?? 0), userIds: users.map((u) => String(u.user_id ?? '')).filter(Boolean) };
}

export interface OaUserDetail {
  userId: string;
  displayName: string | null;
  avatar: string | null;
  isFollower: boolean | null;
  phone: string | null;
  sharedName: string | null;
  address: string | null;
  raw: any;
}

export async function getUserDetail(accessToken: string, userId: string): Promise<OaUserDetail> {
  const data = encodeURIComponent(JSON.stringify({ user_id: userId }));
  const body = await oaGet(accessToken, `${ZALO_OPENAPI_BASE}/v3.0/oa/user/detail?data=${data}`, 'Lấy thông tin khách');
  const d = body?.data ?? {};
  const shared = d.shared_info ?? {};
  const addr = [shared.address, shared.ward, shared.district, shared.city].filter(Boolean).join(', ');
  return {
    userId: String(d.user_id ?? userId),
    displayName: d.display_name ?? null,
    avatar: d.avatar ?? d.avatars?.['240'] ?? null,
    isFollower: typeof d.user_is_follower === 'boolean' ? d.user_is_follower : null,
    phone: shared.phone ? String(shared.phone) : null,
    sharedName: shared.name ?? null,
    address: addr || null,
    raw: d,
  };
}

/** Gửi tin tư vấn dạng văn bản. Trả message_id của Zalo. */
export async function sendTextMessage(accessToken: string, userId: string, text: string): Promise<string> {
  const body = await oaPost(accessToken, `${ZALO_OPENAPI_BASE}/v3.0/oa/message/cs`, {
    recipient: { user_id: userId },
    message: { text },
  }, 'Gửi tin tư vấn');
  return String(body?.data?.message_id ?? '');
}

/** Gửi tin tư vấn kèm ảnh (URL công khai). */
export async function sendImageMessage(accessToken: string, userId: string, imageUrl: string, caption?: string): Promise<string> {
  const body = await oaPost(accessToken, `${ZALO_OPENAPI_BASE}/v3.0/oa/message/cs`, {
    recipient: { user_id: userId },
    message: {
      ...(caption ? { text: caption } : {}),
      attachment: {
        type: 'template',
        payload: { template_type: 'media', elements: [{ media_type: 'image', url: imageUrl }] },
      },
    },
  }, 'Gửi ảnh');
  return String(body?.data?.message_id ?? '');
}

// ── ZNS ────────────────────────────────────────────────────────────────────

export interface ZnsTemplate { templateId: string; templateName: string; status: string; raw: any }

export async function listZnsTemplates(accessToken: string): Promise<ZnsTemplate[]> {
  const body = await oaGet(accessToken, `${ZALO_BUSINESS_BASE}/template/all?offset=0&limit=100`, 'Lấy danh sách mẫu ZNS');
  const arr: any[] = Array.isArray(body?.data) ? body.data : [];
  return arr.map((t) => ({
    templateId: String(t.templateId ?? t.template_id ?? ''),
    templateName: String(t.templateName ?? t.template_name ?? ''),
    status: String(t.status ?? ''),
    raw: t,
  }));
}

export async function getZnsTemplateDetail(accessToken: string, templateId: string): Promise<any> {
  const body = await oaGet(accessToken, `${ZALO_BUSINESS_BASE}/template/info/v2?template_id=${encodeURIComponent(templateId)}`, 'Lấy chi tiết mẫu ZNS');
  return body?.data ?? null;
}

export async function sendZns(accessToken: string, args: {
  phone: string; templateId: string; templateData: Record<string, unknown>; trackingId: string;
}): Promise<{ msgId: string; sentTime: string | null }> {
  const body = await oaPost(accessToken, `${ZALO_BUSINESS_BASE}/message/template`, {
    phone: args.phone,
    template_id: args.templateId,
    template_data: args.templateData,
    tracking_id: args.trackingId,
  }, 'Gửi ZNS');
  return { msgId: String(body?.data?.msg_id ?? ''), sentTime: body?.data?.sent_time ? String(body.data.sent_time) : null };
}

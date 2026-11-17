// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * oa-token-service.ts — Cấu hình app + kết nối OA (OAuth v4 PKCE) + tự gia hạn token.
 *
 * Vòng đời token Zalo OA:
 *   • access_token sống ~25 giờ.
 *   • refresh_token sống ~3 tháng và CHỈ DÙNG ĐƯỢC 1 LẦN (mỗi lần refresh nhận cặp mới).
 *   → Cron 30 phút/lần làm mới token sắp hết hạn (< 3 giờ). Có khoá trong tiến trình để
 *     2 luồng không cùng tiêu 1 refresh_token (lần 2 sẽ hỏng → phải kết nối lại).
 *   → OA không có tương tác gì > 3 tháng vẫn được làm mới đều nên không chết token.
 */
import crypto from 'node:crypto';
import cron from 'node-cron';
import { prisma } from '../../shared/database/prisma-client.js';
import { runSystemQuery, withTenant } from '../../shared/tenant/tenant-context.js';
import { logger } from '../../shared/utils/logger.js';
import { config } from '../../config/index.js';
import { zaloPool } from '../zalo/zalo-pool.js';
import { createPkcePair, decryptSecret, encryptSecret } from './oa-crypto.js';
import * as zaloApi from './oa-api-client.js';

export const OA_CALLBACK_PATH = '/api/v1/zalo-oa/oauth/callback';
export const OA_WEBHOOK_PATH = '/api/v1/webhooks/zalo-oa';

const REFRESH_BEFORE_MS = 3 * 3600_000;

function baseUrl(): string {
  return (config.appUrl || '').replace(/\/+$/, '');
}

export function defaultRedirectUri(): string {
  return `${baseUrl()}${OA_CALLBACK_PATH}`;
}

export function webhookUrl(): string {
  return `${baseUrl()}${OA_WEBHOOK_PATH}`;
}

// ── App config ─────────────────────────────────────────────────────────────

export interface AppConfigView {
  appId: string | null;
  hasAppSecret: boolean;
  hasOaSecretKey: boolean;
  domainVerifyCode: string | null;
  redirectUri: string;
  webhookUrl: string;
}

export async function getAppConfigView(orgId: string): Promise<AppConfigView> {
  const cfg = await prisma.zaloOaAppConfig.findUnique({ where: { orgId } });
  return {
    appId: cfg?.appId ?? process.env.ZALO_OA_APP_ID ?? null,
    hasAppSecret: !!(cfg?.appSecretEnc || process.env.ZALO_OA_APP_SECRET),
    hasOaSecretKey: !!(cfg?.oaSecretKeyEnc || process.env.ZALO_OA_SECRET_KEY),
    domainVerifyCode: cfg?.domainVerifyCode ?? null,
    redirectUri: cfg?.oauthRedirectUri || defaultRedirectUri(),
    webhookUrl: webhookUrl(),
  };
}

export async function saveAppConfig(orgId: string, input: {
  appId?: string; appSecret?: string; oaSecretKey?: string; domainVerifyCode?: string | null; redirectUri?: string | null;
}): Promise<void> {
  const data: Record<string, unknown> = {};
  if (input.appId !== undefined) data.appId = input.appId.trim() || null;
  if (input.appSecret) data.appSecretEnc = encryptSecret(input.appSecret.trim());
  if (input.oaSecretKey) data.oaSecretKeyEnc = encryptSecret(input.oaSecretKey.trim());
  if (input.domainVerifyCode !== undefined) {
    // Cho dán cả tên file "zalo_verifierABC123.html" — tự bóc lấy mã.
    const raw = (input.domainVerifyCode ?? '').trim();
    const m = raw.match(/zalo_verifier([A-Za-z0-9_-]+)(\.html)?/);
    data.domainVerifyCode = (m ? m[1] : raw.replace(/[^A-Za-z0-9_-]/g, '')) || null;
  }
  if (input.redirectUri !== undefined) data.oauthRedirectUri = input.redirectUri?.trim() || null;
  await prisma.zaloOaAppConfig.upsert({
    where: { orgId },
    create: { orgId, ...data },
    update: data,
  });
}

/** Bí mật app (giải mã) — DB per-org trước, fallback env ZALO_OA_*. */
export async function getAppSecrets(orgId: string): Promise<{ appId: string; appSecret: string; oaSecretKey: string | null; redirectUri: string }> {
  const cfg = await prisma.zaloOaAppConfig.findUnique({ where: { orgId } });
  const appId = cfg?.appId || process.env.ZALO_OA_APP_ID || '';
  const appSecret = cfg?.appSecretEnc ? decryptSecret(cfg.appSecretEnc) : (process.env.ZALO_OA_APP_SECRET || '');
  const oaSecretKey = cfg?.oaSecretKeyEnc ? decryptSecret(cfg.oaSecretKeyEnc) : (process.env.ZALO_OA_SECRET_KEY || null);
  if (!appId || !appSecret) throw new Error('Chưa cấu hình App ID / Secret Key của Zalo App');
  return { appId, appSecret, oaSecretKey, redirectUri: cfg?.oauthRedirectUri || defaultRedirectUri() };
}

// ── OAuth ──────────────────────────────────────────────────────────────────

export async function startOAuth(orgId: string): Promise<string> {
  const { appId, redirectUri } = await getAppSecrets(orgId);
  const { verifier, challenge } = createPkcePair();
  const state = crypto.randomBytes(16).toString('hex');
  await prisma.zaloOaAppConfig.update({
    where: { orgId },
    data: { oauthState: state, oauthCodeVerifier: verifier, oauthStartedAt: new Date() },
  });
  return zaloApi.buildPermissionUrl({ appId, redirectUri, codeChallenge: challenge, state });
}

/**
 * Callback từ Zalo (trình duyệt redirect, không có JWT) → tra org theo state.
 * Trả connectionId để UI hiển thị.
 */
export async function completeOAuth(args: { state: string; code: string; oaIdHint?: string | null }): Promise<{ orgId: string; connectionId: string; oaName: string | null }> {
  const cfg = await runSystemQuery(() => prisma.zaloOaAppConfig.findUnique({ where: { oauthState: args.state } }));
  if (!cfg || !cfg.oauthCodeVerifier) throw new Error('Phiên kết nối không hợp lệ hoặc đã dùng — bấm "Kết nối Zalo OA" lại');
  if (cfg.oauthStartedAt && Date.now() - cfg.oauthStartedAt.getTime() > 30 * 60_000) {
    throw new Error('Phiên kết nối đã quá 30 phút — bấm "Kết nối Zalo OA" lại');
  }
  const orgId = cfg.orgId;
  return withTenant(orgId, async () => {
    // Dùng state 1 lần.
    await prisma.zaloOaAppConfig.update({ where: { orgId }, data: { oauthState: null, oauthCodeVerifier: null } });
    const { appId, appSecret } = await getAppSecrets(orgId);
    const tok = await zaloApi.exchangeCode({ appId, appSecret, code: args.code, codeVerifier: cfg.oauthCodeVerifier! });
    const info = await zaloApi.getOaInfo(tok.accessToken).catch(() => ({ oaId: args.oaIdHint ?? '', name: null, avatar: null }));
    const oaId = info.oaId || args.oaIdHint || '';
    if (!oaId) throw new Error('Không xác định được OA ID sau khi kết nối');

    const data = {
      oaName: info.name,
      oaAvatarUrl: info.avatar,
      accessTokenEnc: encryptSecret(tok.accessToken),
      refreshTokenEnc: encryptSecret(tok.refreshToken),
      tokenExpiresAt: new Date(Date.now() + tok.expiresIn * 1000),
      status: 'connected',
      lastError: null,
    };
    const conn = await prisma.zaloOaConnection.upsert({
      where: { orgId_oaId: { orgId, oaId } },
      create: { orgId, oaId, ...data },
      update: data,
    });
    await ensureOaNick(orgId, conn.id);
    return { orgId, connectionId: conn.id, oaName: info.name };
  });
}

/**
 * Tạo/cập nhật "nick đại diện" (ZaloAccount channel='oa') để hội thoại OA hiện trong
 * hộp chat chung. Chủ nick = owner của org (admin/owner org thấy hết theo quyền sẵn có).
 */
export async function ensureOaNick(orgId: string, connectionId: string): Promise<string> {
  const conn = await prisma.zaloOaConnection.findFirstOrThrow({ where: { id: connectionId, orgId } });
  const displayName = `OA · ${conn.oaName || conn.oaId}`;
  const existing = await prisma.zaloAccount.findFirst({ where: { orgId, oaConnectionId: connectionId } });
  if (existing) {
    await prisma.zaloAccount.update({
      where: { id: existing.id },
      data: { displayName, avatarUrl: conn.oaAvatarUrl, status: 'connected', archivedAt: null, lastConnectedAt: new Date() },
    });
    zaloPool.setExternalStatus(existing.id, 'connected');
    return existing.id;
  }
  const owner = await prisma.user.findFirst({
    where: { orgId, role: { in: ['owner', 'admin'] } },
    orderBy: [{ role: 'desc' }, { createdAt: 'asc' }], // 'owner' > 'admin' theo thứ tự chữ
    select: { id: true },
  });
  if (!owner) throw new Error('Không tìm thấy tài khoản quản trị để gắn nick OA');
  const nick = await prisma.zaloAccount.create({
    data: {
      orgId,
      ownerUserId: owner.id,
      zaloUid: `oa:${conn.oaId}`,
      displayName,
      avatarUrl: conn.oaAvatarUrl,
      status: 'connected',
      lastConnectedAt: new Date(),
      channel: 'oa',
      oaConnectionId: connectionId,
    },
  });
  zaloPool.setExternalStatus(nick.id, 'connected');
  return nick.id;
}

// ── Token ──────────────────────────────────────────────────────────────────

const refreshLocks = new Map<string, Promise<string>>();

async function doRefresh(connectionId: string): Promise<string> {
  const conn = await prisma.zaloOaConnection.findUniqueOrThrow({ where: { id: connectionId } });
  const { appId, appSecret } = await getAppSecrets(conn.orgId);
  try {
    const tok = await zaloApi.refreshAccessToken({ appId, appSecret, refreshToken: decryptSecret(conn.refreshTokenEnc) });
    await prisma.zaloOaConnection.update({
      where: { id: connectionId },
      data: {
        accessTokenEnc: encryptSecret(tok.accessToken),
        refreshTokenEnc: encryptSecret(tok.refreshToken || decryptSecret(conn.refreshTokenEnc)),
        tokenExpiresAt: new Date(Date.now() + tok.expiresIn * 1000),
        status: 'connected',
        lastError: null,
      },
    });
    await setNickStatus(conn.orgId, connectionId, 'connected');
    logger.info(`[zalo-oa] làm mới token OA ${conn.oaId} OK`);
    return tok.accessToken;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await prisma.zaloOaConnection.update({ where: { id: connectionId }, data: { status: 'error', lastError: msg.slice(0, 500) } });
    await setNickStatus(conn.orgId, connectionId, 'disconnected');
    logger.warn(`[zalo-oa] làm mới token OA ${conn.oaId} lỗi: ${msg}`);
    throw err;
  }
}

async function setNickStatus(orgId: string, connectionId: string, status: 'connected' | 'disconnected'): Promise<void> {
  const nick = await prisma.zaloAccount.findFirst({ where: { orgId, oaConnectionId: connectionId }, select: { id: true } });
  if (!nick) return;
  zaloPool.setExternalStatus(nick.id, status);
  await prisma.zaloAccount.update({ where: { id: nick.id }, data: { status } });
}

export function refreshConnection(connectionId: string): Promise<string> {
  const pending = refreshLocks.get(connectionId);
  if (pending) return pending;
  const p = doRefresh(connectionId).finally(() => refreshLocks.delete(connectionId));
  refreshLocks.set(connectionId, p);
  return p;
}

/** Access token còn hạn (tự refresh nếu sắp hết). */
export async function getAccessToken(connectionId: string): Promise<string> {
  const conn = await prisma.zaloOaConnection.findUniqueOrThrow({ where: { id: connectionId } });
  if (conn.status === 'revoked') throw new Error('Kết nối OA đã bị ngắt — vào Cài đặt → Zalo OA để kết nối lại');
  const exp = conn.tokenExpiresAt?.getTime() ?? 0;
  if (exp - Date.now() < 5 * 60_000) return refreshConnection(connectionId);
  return decryptSecret(conn.accessTokenEnc);
}

/** Gọi API kèm token; nếu Zalo báo token hỏng → refresh 1 lần rồi thử lại. */
export async function withAccessToken<T>(connectionId: string, fn: (token: string) => Promise<T>): Promise<T> {
  const token = await getAccessToken(connectionId);
  try {
    return await fn(token);
  } catch (err) {
    if (err instanceof zaloApi.ZaloOaApiError && err.isTokenError) {
      return fn(await refreshConnection(connectionId));
    }
    throw err;
  }
}

export async function disconnect(orgId: string, connectionId: string): Promise<void> {
  await prisma.zaloOaConnection.update({ where: { id: connectionId }, data: { status: 'revoked' } });
  const nick = await prisma.zaloAccount.findFirst({ where: { orgId, oaConnectionId: connectionId }, select: { id: true } });
  if (nick) {
    zaloPool.setExternalStatus(nick.id, 'disconnected');
    await prisma.zaloAccount.update({ where: { id: nick.id }, data: { status: 'disconnected', disconnectedAt: new Date(), disconnectReason: 'manual' } });
  }
}

// ── Boot + cron ────────────────────────────────────────────────────────────

/** Khi server khởi động: báo trạng thái nick OA cho pool + làm mới token sắp hết. */
export async function bootZaloOa(): Promise<void> {
  const nicks = await runSystemQuery(() => prisma.zaloAccount.findMany({
    where: { channel: 'oa', archivedAt: null, oaConnectionId: { not: null } },
    select: { id: true, oaConnectionId: true },
  }));
  if (nicks.length === 0) return;
  const conns = await runSystemQuery(() => prisma.zaloOaConnection.findMany({
    where: { id: { in: nicks.map((n) => n.oaConnectionId!) } },
    select: { id: true, status: true },
  }));
  const st = new Map(conns.map((c) => [c.id, c.status]));
  for (const n of nicks) {
    zaloPool.setExternalStatus(n.id, st.get(n.oaConnectionId!) === 'connected' ? 'connected' : 'disconnected');
  }
  await refreshExpiring();
}

export async function refreshExpiring(): Promise<void> {
  const due = await runSystemQuery(() => prisma.zaloOaConnection.findMany({
    where: {
      status: { in: ['connected', 'error'] },
      OR: [{ tokenExpiresAt: null }, { tokenExpiresAt: { lt: new Date(Date.now() + REFRESH_BEFORE_MS) } }],
    },
    select: { id: true, orgId: true },
  }));
  for (const c of due) {
    await withTenant(c.orgId, () => refreshConnection(c.id)).catch(() => { /* đã log + lưu lastError */ });
  }
}

export function startZaloOaTokenCron(): void {
  void bootZaloOa().catch((err) => logger.error('[zalo-oa] boot lỗi:', err));
  cron.schedule('*/30 * * * *', () => {
    void refreshExpiring().catch((err) => logger.error('[zalo-oa] cron refresh lỗi:', err));
  });
}

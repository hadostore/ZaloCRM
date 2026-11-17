// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * zalo-oa-routes.ts — API quản trị Zalo OA (chỉ owner/admin): cấu hình app, kết nối OAuth,
 * làm mới token, đồng bộ người theo dõi, ZNS, thống kê hiệu quả.
 */
import type { FastifyInstance } from 'fastify';
import { authMiddleware } from '../auth/auth-middleware.js';
import { requireRole } from '../auth/role-middleware.js';
import { prisma } from '../../shared/database/prisma-client.js';
import { withTenant } from '../../shared/tenant/tenant-context.js';
import { logger } from '../../shared/utils/logger.js';
import * as zaloApi from './oa-api-client.js';
import {
  disconnect, ensureOaNick, getAppConfigView, refreshConnection, saveAppConfig, startOAuth, withAccessToken,
} from './oa-token-service.js';
import { OA_CONTACT_SOURCE, syncFollowers } from './oa-inbox-service.js';
import { sendZnsMessage } from './oa-zns-service.js';

const BASE = '/api/v1/zalo-oa';

export async function zaloOaRoutes(app: FastifyInstance): Promise<void> {
  const admin = { preHandler: [authMiddleware, requireRole('owner', 'admin')] };

  async function findConn(orgId: string, id: string) {
    return prisma.zaloOaConnection.findFirst({ where: { id, orgId } });
  }

  // Tổng quan: cấu hình + danh sách OA đã kết nối
  app.get(`${BASE}/config`, admin, async (request) => {
    const orgId = request.user!.orgId;
    const [cfg, conns] = await Promise.all([
      getAppConfigView(orgId),
      prisma.zaloOaConnection.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } }),
    ]);
    const nicks = await prisma.zaloAccount.findMany({
      where: { orgId, oaConnectionId: { in: conns.map((c) => c.id) } },
      select: { id: true, oaConnectionId: true },
    });
    const nickByConn = new Map(nicks.map((n) => [n.oaConnectionId, n.id]));
    return {
      config: cfg,
      connections: conns.map((c) => ({
        id: c.id,
        oaId: c.oaId,
        oaName: c.oaName,
        oaAvatarUrl: c.oaAvatarUrl,
        status: c.status,
        lastError: c.lastError,
        tokenExpiresAt: c.tokenExpiresAt,
        lastWebhookAt: c.lastWebhookAt,
        followersSyncedAt: c.followersSyncedAt,
        nickId: nickByConn.get(c.id) ?? null,
        createdAt: c.createdAt,
      })),
    };
  });

  app.put(`${BASE}/config`, admin, async (request, reply) => {
    const body = (request.body ?? {}) as {
      appId?: string; appSecret?: string; oaSecretKey?: string; domainVerifyCode?: string | null; redirectUri?: string | null;
    };
    if (body.appId !== undefined && body.appId && !/^\d{5,25}$/.test(body.appId.trim())) {
      return reply.status(400).send({ error: 'App ID chỉ gồm chữ số (copy ở trang developers.zalo.me → Ứng dụng của bạn)' });
    }
    await saveAppConfig(request.user!.orgId, body);
    return getAppConfigView(request.user!.orgId);
  });

  // Bắt đầu OAuth → FE chuyển trình duyệt sang URL này
  app.post(`${BASE}/oauth/start`, admin, async (request, reply) => {
    try {
      return { url: await startOAuth(request.user!.orgId) };
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  app.post(`${BASE}/connections/:id/refresh`, admin, async (request, reply) => {
    const { id } = request.params as { id: string };
    const conn = await findConn(request.user!.orgId, id);
    if (!conn) return reply.status(404).send({ error: 'Không tìm thấy kết nối' });
    try {
      await refreshConnection(id);
      await ensureOaNick(conn.orgId, id);
      return { ok: true };
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  app.post(`${BASE}/connections/:id/disconnect`, admin, async (request, reply) => {
    const { id } = request.params as { id: string };
    const conn = await findConn(request.user!.orgId, id);
    if (!conn) return reply.status(404).send({ error: 'Không tìm thấy kết nối' });
    await disconnect(conn.orgId, id);
    return { ok: true };
  });

  // Đồng bộ người theo dõi (chạy nền — vài nghìn follower mất vài phút)
  app.post(`${BASE}/connections/:id/sync-followers`, admin, async (request, reply) => {
    const { id } = request.params as { id: string };
    const orgId = request.user!.orgId;
    const conn = await findConn(orgId, id);
    if (!conn) return reply.status(404).send({ error: 'Không tìm thấy kết nối' });
    void withTenant(orgId, () => syncFollowers(orgId, id)).catch((err) => {
      logger.warn(`[zalo-oa] đồng bộ follower lỗi: ${(err as Error).message}`);
    });
    return reply.status(202).send({ started: true });
  });

  // ── ZNS ──
  app.get(`${BASE}/connections/:id/zns/templates`, admin, async (request, reply) => {
    const { id } = request.params as { id: string };
    const conn = await findConn(request.user!.orgId, id);
    if (!conn) return reply.status(404).send({ error: 'Không tìm thấy kết nối' });
    try {
      const templates = await withAccessToken(id, (t) => zaloApi.listZnsTemplates(t));
      return { templates: templates.map(({ raw: _raw, ...t }) => t) };
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  app.get(`${BASE}/connections/:id/zns/templates/:templateId`, admin, async (request, reply) => {
    const { id, templateId } = request.params as { id: string; templateId: string };
    const conn = await findConn(request.user!.orgId, id);
    if (!conn) return reply.status(404).send({ error: 'Không tìm thấy kết nối' });
    try {
      return { template: await withAccessToken(id, (t) => zaloApi.getZnsTemplateDetail(t, templateId)) };
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  // Gửi ZNS — admin/owner; sale gửi qua automation (Extension) hoặc admin gửi tay.
  app.post(`${BASE}/zns/send`, admin, async (request, reply) => {
    const body = (request.body ?? {}) as {
      connectionId?: string; phone?: string; contactId?: string; templateId?: string; templateData?: Record<string, unknown>;
    };
    const orgId = request.user!.orgId;
    const conn = body.connectionId
      ? await findConn(orgId, body.connectionId)
      : await prisma.zaloOaConnection.findFirst({ where: { orgId, status: 'connected' } });
    if (!conn) return reply.status(400).send({ error: 'Chưa có Zalo OA nào được kết nối' });
    try {
      const r = await sendZnsMessage({
        orgId,
        connectionId: conn.id,
        phone: body.phone,
        contactId: body.contactId,
        templateId: String(body.templateId ?? ''),
        templateData: body.templateData ?? {},
        userId: request.user!.id,
      });
      return r.status === 'failed' ? reply.status(400).send(r) : r;
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  app.get(`${BASE}/zns/logs`, admin, async (request) => {
    const { limit = '50' } = request.query as { limit?: string };
    const logs = await prisma.zaloZnsLog.findMany({
      where: { orgId: request.user!.orgId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200),
    });
    return { logs };
  });

  // ── Thống kê hiệu quả tương tác (mặc định 30 ngày) ──
  app.get(`${BASE}/stats`, admin, async (request) => {
    const orgId = request.user!.orgId;
    const { days = '30' } = request.query as { days?: string };
    const d = Math.min(Math.max(parseInt(days, 10) || 30, 1), 365);
    const since = new Date(Date.now() - d * 86400_000);
    const nicks = await prisma.zaloAccount.findMany({ where: { orgId, channel: 'oa' }, select: { id: true } });
    const nickIds = nicks.map((n) => n.id);
    const convWhere = { orgId, zaloAccountId: { in: nickIds }, deletedAt: null };
    const [
      followers, unfollowed, newContacts, conversations, waitingReply, inbound, outbound, znsGroups,
    ] = await Promise.all([
      prisma.contact.count({ where: { orgId, mergedInto: null, tags: { array_contains: ['auto:zalo_oa_follower'] } } }),
      prisma.contact.count({ where: { orgId, mergedInto: null, tags: { array_contains: ['auto:zalo_oa_unfollowed'] } } }),
      prisma.contact.count({ where: { orgId, source: OA_CONTACT_SOURCE, createdAt: { gte: since } } }),
      prisma.conversation.count({ where: { ...convWhere, lastMessageAt: { gte: since } } }),
      prisma.conversation.count({ where: { ...convWhere, isReplied: false } }),
      prisma.message.count({ where: { conversation: convWhere, senderType: 'contact', sentAt: { gte: since } } }),
      prisma.message.count({ where: { conversation: convWhere, senderType: 'self', sentAt: { gte: since } } }),
      prisma.zaloZnsLog.groupBy({ by: ['status'], where: { orgId, createdAt: { gte: since } }, _count: { _all: true } }),
    ]);
    const zns: Record<string, number> = { pending: 0, sent: 0, delivered: 0, failed: 0 };
    for (const g of znsGroups) zns[g.status] = g._count._all;
    return {
      days: d,
      followers,
      unfollowed,
      newContacts,
      conversations,
      waitingReply,
      messagesIn: inbound,
      messagesOut: outbound,
      zns,
    };
  });
}

// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * oa-inbox-service.ts — Đưa dữ liệu Zalo OA vào CRM:
 *   • Tin khách nhắn OA  → Contact + Conversation (dưới "nick đại diện" OA) + Message
 *   • Tin OA gửi (kể cả từ app Zalo OA Manager) → Message senderType='self' (đủ lịch sử)
 *   • Theo dõi / bỏ theo dõi / khách chia sẻ SĐT → cập nhật hồ sơ KH + tag tự động
 *   • Nhân viên trả lời trong CRM → gửi qua OA OpenAPI (tin tư vấn)
 *   • Đồng bộ danh sách người theo dõi về CRM
 */
import { randomUUID } from 'node:crypto';
import type { Server } from 'socket.io';
import { Prisma } from '@prisma/client';
import { prisma } from '../../shared/database/prisma-client.js';
import { runSystemQuery, withTenant } from '../../shared/tenant/tenant-context.js';
import { logger } from '../../shared/utils/logger.js';
import { normalizePhone } from '../../shared/utils/phone.js';
import { emitChatMessage } from '../../shared/realtime/emit-chat.js';
import { automationEventBus } from '../../shared/ee-registry/event-bus.js';
import { emitWebhook } from '../api/webhook-service.js';
import * as zaloApi from './oa-api-client.js';
import type { OaEvent } from './oa-event-parser.js';
import { ensureOaNick, withAccessToken } from './oa-token-service.js';

export const OA_CONTACT_SOURCE = 'zalo_oa';
const TAG_FOLLOWER = 'auto:zalo_oa_follower';
const TAG_UNFOLLOWED = 'auto:zalo_oa_unfollowed';

let io: Server | null = null;
export function setZaloOaIO(server: Server): void {
  io = server;
}

// ── Helpers ────────────────────────────────────────────────────────────────

interface OaContext {
  orgId: string;
  connectionId: string;
  oaId: string;
  nickId: string;
  nickPrivacyMode: string;
  nickOwnerUserId: string;
}

/** Tìm kết nối OA theo oa_id của sự kiện (webhook không mang orgId). */
export async function findOaContexts(oaId: string | null, appId: string | null): Promise<Array<{ orgId: string; connectionId: string; oaId: string }>> {
  if (!oaId) return [];
  const conns = await runSystemQuery(() => prisma.zaloOaConnection.findMany({
    where: { oaId, status: { not: 'revoked' } },
    select: { id: true, orgId: true, oaId: true },
  }));
  if (!appId || conns.length <= 1) return conns.map((c) => ({ orgId: c.orgId, connectionId: c.id, oaId: c.oaId }));
  // Nhiều org cùng OA (hiếm) → lọc theo app_id đã cấu hình.
  const cfgs = await runSystemQuery(() => prisma.zaloOaAppConfig.findMany({
    where: { orgId: { in: conns.map((c) => c.orgId) } },
    select: { orgId: true, appId: true },
  }));
  const ok = new Set(cfgs.filter((c) => !c.appId || c.appId === appId).map((c) => c.orgId));
  return conns.filter((c) => ok.has(c.orgId)).map((c) => ({ orgId: c.orgId, connectionId: c.id, oaId: c.oaId }));
}

async function loadCtx(orgId: string, connectionId: string, oaId: string): Promise<OaContext> {
  let nick = await prisma.zaloAccount.findFirst({
    where: { orgId, oaConnectionId: connectionId },
    select: { id: true, privacyMode: true, ownerUserId: true },
  });
  if (!nick) {
    const id = await ensureOaNick(orgId, connectionId);
    nick = await prisma.zaloAccount.findFirstOrThrow({ where: { id }, select: { id: true, privacyMode: true, ownerUserId: true } });
  }
  return { orgId, connectionId, oaId, nickId: nick.id, nickPrivacyMode: nick.privacyMode, nickOwnerUserId: nick.ownerUserId };
}

function mergeTags(current: unknown, add: string[], remove: string[] = []): string[] {
  const arr = Array.isArray(current) ? current.map(String) : [];
  const set = new Set(arr.filter((t) => !remove.includes(t)));
  for (const t of add) set.add(t);
  return [...set];
}

function oaMeta(current: unknown, patch: Record<string, unknown>): Prisma.InputJsonValue {
  const base = current && typeof current === 'object' && !Array.isArray(current) ? (current as Record<string, unknown>) : {};
  const prev = base.zaloOa && typeof base.zaloOa === 'object' ? (base.zaloOa as Record<string, unknown>) : {};
  return { ...base, zaloOa: { ...prev, ...patch } } as Prisma.InputJsonValue;
}

/**
 * Tìm hoặc tạo Contact cho 1 khách OA. Thứ tự khớp: hội thoại OA sẵn có → zaloUid (=user_id OA)
 * → SĐT (khách đã có hồ sơ từ Shopee/TikTok/nick cá nhân → gộp đúng 1 người).
 */
export async function upsertOaContact(ctx: OaContext, userId: string, detail?: zaloApi.OaUserDetail | null): Promise<{ id: string; isNew: boolean }> {
  const conv = await prisma.conversation.findFirst({
    where: { zaloAccountId: ctx.nickId, externalThreadId: userId, contactId: { not: null } },
    select: { contactId: true },
  });
  let contact = conv?.contactId
    ? await prisma.contact.findFirst({ where: { id: conv.contactId, orgId: ctx.orgId } })
    : null;
  if (!contact) contact = await prisma.contact.findFirst({ where: { orgId: ctx.orgId, zaloUid: userId, mergedInto: null } });
  const phoneNorm = normalizePhone(detail?.phone ?? null);
  if (!contact && phoneNorm) {
    contact = await prisma.contact.findFirst({ where: { orgId: ctx.orgId, phoneNormalized: phoneNorm, mergedInto: null } });
  }

  const name = detail?.sharedName || detail?.displayName || null;
  if (!contact) {
    const created = await prisma.contact.create({
      data: {
        id: randomUUID(),
        orgId: ctx.orgId,
        zaloUid: userId,
        fullName: name || 'Khách Zalo OA',
        avatarUrl: detail?.avatar ?? null,
        phone: detail?.phone ?? null,
        phoneNormalized: phoneNorm,
        source: OA_CONTACT_SOURCE,
        sourceDate: new Date(),
        firstContactDate: new Date(),
        tags: detail?.isFollower ? [TAG_FOLLOWER] : [],
        metadata: oaMeta({}, {
          userId, oaId: ctx.oaId, isFollower: detail?.isFollower ?? null, address: detail?.address ?? null,
        }),
      },
      select: { id: true, fullName: true },
    });
    emitWebhook(ctx.orgId, 'contact.created', { contactId: created.id, fullName: created.fullName, source: OA_CONTACT_SOURCE });
    return { id: created.id, isNew: true };
  }

  const patch: Prisma.ContactUpdateInput = {
    metadata: oaMeta(contact.metadata, {
      userId, oaId: ctx.oaId,
      ...(detail?.isFollower != null ? { isFollower: detail.isFollower } : {}),
      ...(detail?.address ? { address: detail.address } : {}),
    }),
  };
  if (!contact.zaloUid) patch.zaloUid = userId;
  if (detail?.avatar && !contact.avatarUrl) patch.avatarUrl = detail.avatar;
  if (name && (!contact.fullName || contact.fullName === 'Khách Zalo OA' || contact.fullName === 'Unknown')) patch.fullName = name;
  if (detail?.phone && !contact.phone) {
    patch.phone = detail.phone;
    patch.phoneNormalized = phoneNorm;
  }
  if (detail?.isFollower === true) patch.tags = mergeTags(contact.tags, [TAG_FOLLOWER], [TAG_UNFOLLOWED]);
  await prisma.contact.update({ where: { id: contact.id }, data: patch });
  return { id: contact.id, isNew: false };
}

async function getOrCreateConversation(ctx: OaContext, userId: string, contactId: string, at: Date, inbound: boolean): Promise<{ id: string; isNew: boolean }> {
  const existing = await prisma.conversation.findUnique({
    where: { zaloAccountId_externalThreadId: { zaloAccountId: ctx.nickId, externalThreadId: userId } },
    select: { id: true, contactId: true, deletedAt: true },
  });
  if (existing) {
    if (!existing.contactId || existing.deletedAt) {
      await prisma.conversation.update({ where: { id: existing.id }, data: { contactId: existing.contactId ?? contactId, deletedAt: null } });
    }
    return { id: existing.id, isNew: false };
  }
  try {
    const c = await prisma.conversation.create({
      data: {
        id: randomUUID(),
        orgId: ctx.orgId,
        zaloAccountId: ctx.nickId,
        contactId,
        threadType: 'user',
        externalThreadId: userId,
        lastMessageAt: at,
        unreadCount: 0,
        isReplied: !inbound,
      },
      select: { id: true },
    });
    return { id: c.id, isNew: true };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const c = await prisma.conversation.findUniqueOrThrow({
        where: { zaloAccountId_externalThreadId: { zaloAccountId: ctx.nickId, externalThreadId: userId } },
        select: { id: true },
      });
      return { id: c.id, isNew: false };
    }
    throw err;
  }
}

async function fetchDetail(connectionId: string, userId: string): Promise<zaloApi.OaUserDetail | null> {
  try {
    return await withAccessToken(connectionId, (t) => zaloApi.getUserDetail(t, userId));
  } catch (err) {
    logger.debug?.(`[zalo-oa] không lấy được hồ sơ ${userId}: ${(err as Error).message}`);
    return null;
  }
}

// ── Webhook event handling ─────────────────────────────────────────────────

export async function handleOaEvent(event: OaEvent): Promise<void> {
  if (event.kind === 'ignored') return;
  const targets = await findOaContexts(event.oaId, event.appId);
  if (targets.length === 0) {
    logger.warn(`[zalo-oa] webhook cho OA ${event.oaId ?? '?'} chưa kết nối trong CRM — bỏ qua`);
    return;
  }
  for (const t of targets) {
    await withTenant(t.orgId, async () => {
      await prisma.zaloOaConnection.update({ where: { id: t.connectionId }, data: { lastWebhookAt: new Date() } });
      const ctx = await loadCtx(t.orgId, t.connectionId, t.oaId);
      switch (event.kind) {
        case 'message': return handleMessage(ctx, event);
        case 'follow':
        case 'unfollow': return handleFollow(ctx, event);
        case 'receipt': return handleReceipt(ctx, event);
        case 'submit_info': return handleSubmitInfo(ctx, event);
      }
    });
  }
}

async function handleMessage(ctx: OaContext, ev: Extract<OaEvent, { kind: 'message' }>): Promise<void> {
  if (!ev.userId) return;
  const inbound = ev.direction === 'in';
  const sentAt = new Date(ev.timestamp);

  // Hội thoại đã có → không gọi API hồ sơ (tiết kiệm quota); lần đầu → lấy tên/ảnh/SĐT.
  const knownConv = await prisma.conversation.findUnique({
    where: { zaloAccountId_externalThreadId: { zaloAccountId: ctx.nickId, externalThreadId: ev.userId } },
    select: { id: true, contactId: true },
  });
  const contact = knownConv?.contactId
    ? { id: knownConv.contactId, isNew: false }
    : await upsertOaContact(ctx, ev.userId, await fetchDetail(ctx.connectionId, ev.userId));
  const conv = await getOrCreateConversation(ctx, ev.userId, contact.id, sentAt, inbound);

  // Chống trùng: Zalo có thể bắn lại webhook; tin CRM tự gửi đã lưu sẵn với cùng msg_id.
  const dup = await prisma.message.findUnique({
    where: { conversationId_zaloMsgId: { conversationId: conv.id, zaloMsgId: ev.msgId } },
    select: { id: true },
  });
  if (dup) return;

  let message;
  try {
    message = await prisma.message.create({
      data: {
        id: randomUUID(),
        conversationId: conv.id,
        zaloMsgId: ev.msgId,
        senderType: inbound ? 'contact' : 'self',
        senderUid: inbound ? ev.userId : `oa:${ctx.oaId}`,
        senderName: inbound ? null : 'Zalo OA',
        content: ev.content,
        contentType: ev.contentType,
        sentAt,
        sentVia: 'user',
        metadata: inbound
          ? { channel: 'zalo_oa' }
          : { channel: 'zalo_oa', sender: { kind: 'oa_app', name: 'Zalo OA Manager' } },
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return; // webhook bắn trùng song song
    throw err;
  }

  await prisma.conversation.update({
    where: { id: conv.id },
    data: inbound
      ? { lastMessageAt: sentAt, isReplied: false, unreadCount: { increment: 1 } }
      : { lastMessageAt: sentAt, isReplied: true, unreadCount: 0 },
  });
  await prisma.contact.update({ where: { id: contact.id }, data: { lastActivity: sentAt } }).catch(() => undefined);

  await emitChatMessage({
    io,
    orgId: ctx.orgId,
    accountId: ctx.nickId,
    conversationId: conv.id,
    message: { ...message, zaloMsgIdNum: null },
    privacyMode: ctx.nickPrivacyMode,
    ownerUserId: ctx.nickOwnerUserId,
    extra: { channel: 'zalo_oa' },
  });

  if (inbound) {
    const priorInbound = await prisma.message.count({
      where: { conversationId: conv.id, senderType: 'contact', id: { not: message.id } },
    });
    const payload = {
      messageId: message.id,
      conversationId: conv.id,
      content: message.content ?? '',
      contentType: message.contentType,
      zaloAccountId: ctx.nickId,
      channel: 'zalo_oa',
    };
    automationEventBus.emit({ type: 'message_received', orgId: ctx.orgId, occurredAt: new Date(), contactId: contact.id, payload });
    if (priorInbound === 0) {
      automationEventBus.emit({ type: 'first_message_received', orgId: ctx.orgId, occurredAt: new Date(), contactId: contact.id, payload });
    }
    if (message.contentType === 'text' && message.content) {
      automationEventBus.emit({ type: 'keyword_match', orgId: ctx.orgId, occurredAt: new Date(), contactId: contact.id, payload });
    }
    emitWebhook(ctx.orgId, 'message.received', { conversationId: conv.id, contactId: contact.id, channel: 'zalo_oa', content: message.content });
  }
}

async function handleFollow(ctx: OaContext, ev: Extract<OaEvent, { kind: 'follow' | 'unfollow' }>): Promise<void> {
  if (!ev.userId) return;
  const follow = ev.kind === 'follow';
  const detail = follow ? await fetchDetail(ctx.connectionId, ev.userId) : null;
  const c = await upsertOaContact(ctx, ev.userId, detail ? { ...detail, isFollower: true } : null);
  const current = await prisma.contact.findUniqueOrThrow({ where: { id: c.id }, select: { tags: true, metadata: true } });
  await prisma.contact.update({
    where: { id: c.id },
    data: {
      tags: follow ? mergeTags(current.tags, [TAG_FOLLOWER], [TAG_UNFOLLOWED]) : mergeTags(current.tags, [TAG_UNFOLLOWED], [TAG_FOLLOWER]),
      metadata: oaMeta(current.metadata, follow
        ? { isFollower: true, followedAt: new Date(ev.timestamp).toISOString(), followSource: ev.source }
        : { isFollower: false, unfollowedAt: new Date(ev.timestamp).toISOString() }),
      lastActivity: new Date(ev.timestamp),
    },
  });
  automationEventBus.emit({
    type: follow ? 'zalo_oa_follow' : 'zalo_oa_unfollow',
    orgId: ctx.orgId,
    occurredAt: new Date(),
    contactId: c.id,
    payload: { zaloAccountId: ctx.nickId, oaId: ctx.oaId, userId: ev.userId, source: ev.source },
  });
}

async function handleReceipt(ctx: OaContext, ev: Extract<OaEvent, { kind: 'receipt' }>): Promise<void> {
  if (!ev.userId || ev.msgIds.length === 0) return;
  const conv = await prisma.conversation.findUnique({
    where: { zaloAccountId_externalThreadId: { zaloAccountId: ctx.nickId, externalThreadId: ev.userId } },
    select: { id: true },
  });
  const at = new Date(ev.timestamp);
  if (conv) {
    await prisma.message.updateMany({
      where: { conversationId: conv.id, zaloMsgId: { in: ev.msgIds }, senderType: 'self' },
      data: ev.status === 'seen' ? { seenAt: at } : { deliveredAt: at },
    });
  }
  // ZNS: đánh dấu khách đã nhận.
  if (ev.status === 'delivered') {
    await prisma.zaloZnsLog.updateMany({
      where: { orgId: ctx.orgId, znsMsgId: { in: ev.msgIds }, deliveredAt: null },
      data: { status: 'delivered', deliveredAt: at },
    });
  }
}

async function handleSubmitInfo(ctx: OaContext, ev: Extract<OaEvent, { kind: 'submit_info' }>): Promise<void> {
  if (!ev.userId) return;
  await upsertOaContact(ctx, ev.userId, {
    userId: ev.userId,
    displayName: null,
    avatar: null,
    isFollower: null,
    phone: ev.info.phone,
    sharedName: ev.info.name,
    address: ev.info.address,
    raw: null,
  });
}

// ── Gửi từ CRM ─────────────────────────────────────────────────────────────

export function isOaNick(nick: { channel?: string | null; oaConnectionId?: string | null }): boolean {
  return nick.channel === 'oa' && !!nick.oaConnectionId;
}

/**
 * Nhân viên trả lời trong hộp chat CRM trên hội thoại của nick OA → gửi tin tư vấn qua
 * OA OpenAPI, lưu Message với zaloMsgId = message_id Zalo trả về (webhook echo sẽ tự bỏ trùng).
 */
export async function sendOaMessageFromCrm(args: {
  conversation: { id: string; orgId: string; externalThreadId: string | null; zaloAccountId: string; contactId: string | null };
  nick: { oaConnectionId: string | null; privacyMode: string; ownerUserId: string };
  content: string;
  userId: string;
  userName: string | null;
  echoId?: string | null;
}): Promise<any> {
  const { conversation, nick } = args;
  if (!conversation.externalThreadId || !nick.oaConnectionId) throw new Error('Hội thoại OA thiếu user_id');
  const msgId = await withAccessToken(nick.oaConnectionId, (t) => zaloApi.sendTextMessage(t, conversation.externalThreadId!, args.content));
  const now = new Date();
  const message = await prisma.message.create({
    data: {
      id: randomUUID(),
      conversationId: conversation.id,
      zaloMsgId: msgId || `oa-local:${randomUUID()}`,
      senderType: 'self',
      senderUid: `oa:${nick.oaConnectionId}`,
      senderName: args.userName || 'Staff',
      content: args.content,
      contentType: 'text',
      sentAt: now,
      repliedByUserId: args.userId,
      sentVia: 'user',
      clientEchoId: args.echoId ?? null,
      metadata: { channel: 'zalo_oa', sender: { kind: 'user_crm', name: args.userName } },
    },
    include: { repliedBy: { select: { id: true, fullName: true, email: true } } },
  });
  await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: now, isReplied: true, unreadCount: 0 } });
  const safe = { ...message, zaloMsgIdNum: null as string | null };
  await emitChatMessage({
    io,
    orgId: conversation.orgId,
    accountId: conversation.zaloAccountId,
    conversationId: conversation.id,
    message: safe,
    privacyMode: nick.privacyMode,
    ownerUserId: nick.ownerUserId,
    extra: { channel: 'zalo_oa' },
  });
  return safe;
}

/** Thông báo lỗi Zalo dễ hiểu cho nhân viên (giữ nguyên câu Zalo trả về để tra cứu). */
export function explainOaSendError(err: unknown): string {
  if (err instanceof zaloApi.ZaloOaApiError) {
    if (err.isTokenError) return 'Token Zalo OA hết hạn — vào Cài đặt → Zalo OA để kết nối lại.';
    return `Zalo từ chối gửi: ${err.message}. Thường do khách chưa nhắn OA trong khung thời gian Zalo cho phép gửi tin tư vấn, khách đã chặn/bỏ theo dõi OA, hoặc gói OA hết lượt gửi.`;
  }
  return (err as Error)?.message || 'Gửi tin qua Zalo OA thất bại';
}

// ── Đồng bộ người theo dõi ─────────────────────────────────────────────────

const syncing = new Set<string>();

export async function syncFollowers(orgId: string, connectionId: string, opts: { max?: number } = {}): Promise<{ total: number; synced: number; created: number }> {
  if (syncing.has(connectionId)) throw new Error('Đang đồng bộ — vui lòng đợi lượt trước xong');
  syncing.add(connectionId);
  try {
    const conn = await prisma.zaloOaConnection.findFirstOrThrow({ where: { id: connectionId, orgId } });
    const ctx = await loadCtx(orgId, connectionId, conn.oaId);
    const max = opts.max ?? 5000;
    let offset = 0;
    let total = 0;
    let synced = 0;
    let created = 0;
    while (offset < max) {
      const page = await withAccessToken(connectionId, (t) => zaloApi.listFollowers(t, offset, 50));
      total = page.total;
      if (page.userIds.length === 0) break;
      for (const uid of page.userIds) {
        const detail = await fetchDetail(connectionId, uid);
        const r = await upsertOaContact(ctx, uid, detail ? { ...detail, isFollower: true } : {
          userId: uid, displayName: null, avatar: null, isFollower: true, phone: null, sharedName: null, address: null, raw: null,
        });
        synced++;
        if (r.isNew) created++;
        await new Promise((res) => setTimeout(res, 120)); // nương tay rate-limit Zalo
      }
      offset += page.userIds.length;
      if (offset >= total) break;
    }
    await prisma.zaloOaConnection.update({ where: { id: connectionId }, data: { followersSyncedAt: new Date() } });
    logger.info(`[zalo-oa] đồng bộ người theo dõi OA ${conn.oaId}: ${synced}/${total} (mới ${created})`);
    return { total, synced, created };
  } finally {
    syncing.delete(connectionId);
  }
}

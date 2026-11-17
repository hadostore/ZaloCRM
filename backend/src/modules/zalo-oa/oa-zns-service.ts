// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * oa-zns-service.ts — Gửi ZNS (Zalo Notification Service) qua OA + ghi nhật ký đo lường.
 * ZNS gửi theo SĐT (không cần khách theo dõi OA), dùng MẪU đã được Zalo duyệt:
 * xác nhận đơn, thông báo giao hàng, nhắc lịch, cảm ơn/chăm sóc sau mua…
 * Mỗi tin ZNS tính phí theo bảng giá Zalo (trừ vào ví ZCA của OA).
 */
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../shared/database/prisma-client.js';
import { normalizePhone } from '../../shared/utils/phone.js';
import * as zaloApi from './oa-api-client.js';
import { withAccessToken } from './oa-token-service.js';

export async function sendZnsMessage(args: {
  orgId: string;
  connectionId: string;
  phone?: string | null;
  contactId?: string | null;
  templateId: string;
  templateData: Record<string, unknown>;
  userId?: string | null;
}): Promise<{ logId: string; status: string; znsMsgId: string | null; error: string | null }> {
  let phone = args.phone ?? null;
  if (!phone && args.contactId) {
    const c = await prisma.contact.findFirst({ where: { id: args.contactId, orgId: args.orgId }, select: { phone: true } });
    phone = c?.phone ?? null;
  }
  const norm = normalizePhone(phone);
  if (!norm || !norm.startsWith('84')) throw new Error('Số điện thoại không hợp lệ (cần SĐT Việt Nam)');
  if (!args.templateId) throw new Error('Thiếu mã mẫu ZNS (template_id)');

  const trackingId = randomUUID().replace(/-/g, '').slice(0, 24);
  const log = await prisma.zaloZnsLog.create({
    data: {
      orgId: args.orgId,
      oaConnectionId: args.connectionId,
      contactId: args.contactId ?? null,
      phone: norm,
      templateId: args.templateId,
      templateData: args.templateData as Prisma.InputJsonValue,
      trackingId,
      sentByUserId: args.userId ?? null,
    },
  });
  try {
    const r = await withAccessToken(args.connectionId, (t) => zaloApi.sendZns(t, {
      phone: norm, templateId: args.templateId, templateData: args.templateData, trackingId,
    }));
    await prisma.zaloZnsLog.update({ where: { id: log.id }, data: { status: 'sent', znsMsgId: r.msgId || null, sentAt: new Date() } });
    return { logId: log.id, status: 'sent', znsMsgId: r.msgId || null, error: null };
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    await prisma.zaloZnsLog.update({ where: { id: log.id }, data: { status: 'failed', error: msg.slice(0, 500) } });
    return { logId: log.id, status: 'failed', znsMsgId: null, error: msg };
  }
}

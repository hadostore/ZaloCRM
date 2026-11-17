// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * oa-event-parser.ts — Chuẩn hoá sự kiện webhook Zalo OA thành dạng CRM hiểu (thuần, dễ test).
 *
 * Sự kiện chính (event_name):
 *   user_send_text | user_send_image | user_send_link | user_send_sticker | user_send_gif |
 *   user_send_file | user_send_audio | user_send_video | user_send_location   → tin khách gửi
 *   oa_send_text | oa_send_image | oa_send_file | oa_send_list | oa_send_gif …  → tin OA gửi
 *       (kể cả nhân viên trả lời trên app Zalo OA Manager → CRM vẫn lưu đủ lịch sử)
 *   follow | unfollow                                                          → theo dõi OA
 *   user_received_message | user_seen_message                                  → đã nhận/đã xem
 *   user_submit_info                                                           → khách chia sẻ SĐT/địa chỉ
 */

export type OaEvent =
  | {
      kind: 'message';
      direction: 'in' | 'out';
      userId: string; // id khách (theo OA)
      msgId: string;
      contentType: string; // text | image | file | video | voice | sticker | link
      content: string;
      timestamp: number;
      appId: string | null;
      oaId: string | null;
    }
  | { kind: 'follow' | 'unfollow'; userId: string; oaId: string | null; timestamp: number; appId: string | null; source: string | null }
  | { kind: 'receipt'; status: 'delivered' | 'seen'; userId: string; msgIds: string[]; oaId: string | null; timestamp: number; appId: string | null }
  | {
      kind: 'submit_info';
      userId: string;
      oaId: string | null;
      timestamp: number;
      appId: string | null;
      info: { name: string | null; phone: string | null; address: string | null };
    }
  | { kind: 'ignored'; eventName: string; oaId: string | null; appId: string | null };

function s(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  return String(v);
}

function attachmentContent(eventSuffix: string, message: any): { contentType: string; content: string } {
  const text: string = message?.text ?? '';
  const att = Array.isArray(message?.attachments) ? message.attachments[0] : null;
  const p = att?.payload ?? {};
  switch (eventSuffix) {
    case 'text':
      return { contentType: 'text', content: text };
    case 'image':
    case 'gif':
    case 'sticker': {
      const href = p.url || p.thumbnail || '';
      return { contentType: 'image', content: JSON.stringify({ href, thumb: p.thumbnail || href, title: text || '' }) };
    }
    case 'file':
      return { contentType: 'file', content: JSON.stringify({ href: p.url || '', name: p.name || 'file', size: Number(p.size) || 0 }) };
    case 'video':
      return { contentType: 'video', content: JSON.stringify({ href: p.url || '', thumb: p.thumbnail || '' }) };
    case 'audio':
    case 'voice':
      return { contentType: 'voice', content: JSON.stringify({ href: p.url || '' }) };
    case 'link': {
      const url = p.url || '';
      const desc = p.description || p.title || '';
      return { contentType: 'text', content: [text, url, desc].filter(Boolean).join('\n') };
    }
    case 'location': {
      const c = p.coordinates || {};
      const lat = c.latitude ?? '';
      const lng = c.longitude ?? '';
      return { contentType: 'text', content: `📍 Vị trí: https://maps.google.com/?q=${lat},${lng}` };
    }
    default:
      return { contentType: 'text', content: text || `[${eventSuffix}]` };
  }
}

export function parseOaEvent(body: any): OaEvent {
  const eventName: string = String(body?.event_name ?? '');
  const appId = s(body?.app_id);
  const ts = Number(body?.timestamp) || Date.now();

  if (eventName === 'follow' || eventName === 'unfollow') {
    return {
      kind: eventName,
      userId: s(body?.follower?.id) ?? '',
      oaId: s(body?.oa_id),
      timestamp: ts,
      appId,
      source: s(body?.source),
    };
  }

  if (eventName === 'user_received_message' || eventName === 'user_seen_message') {
    const ids = body?.message?.msg_ids ?? (body?.message?.msg_id ? [body.message.msg_id] : []);
    return {
      kind: 'receipt',
      status: eventName === 'user_seen_message' ? 'seen' : 'delivered',
      userId: s(body?.recipient?.id) ?? s(body?.sender?.id) ?? '',
      msgIds: (Array.isArray(ids) ? ids : [ids]).map(String),
      oaId: s(body?.sender?.id),
      timestamp: ts,
      appId,
    };
  }

  if (eventName === 'user_submit_info') {
    const i = body?.info ?? {};
    const addr = [i.address, i.ward, i.district, i.city].filter(Boolean).join(', ');
    return {
      kind: 'submit_info',
      userId: s(body?.sender?.id) ?? '',
      oaId: s(body?.recipient?.id),
      timestamp: ts,
      appId,
      info: { name: s(i.name), phone: s(i.phone), address: addr || null },
    };
  }

  const m = eventName.match(/^(user|oa)_send_([a-z_]+)$/);
  if (m) {
    const direction = m[1] === 'user' ? 'in' : 'out';
    // Khách gửi: sender=khách, recipient=OA. OA gửi: sender=OA, recipient=khách.
    const userId = direction === 'in' ? s(body?.sender?.id) : s(body?.recipient?.id);
    const oaId = direction === 'in' ? s(body?.recipient?.id) : s(body?.sender?.id);
    const { contentType, content } = attachmentContent(m[2], body?.message);
    return {
      kind: 'message',
      direction,
      userId: userId ?? '',
      msgId: s(body?.message?.msg_id) ?? `oa:${eventName}:${ts}:${userId}`,
      contentType,
      content,
      timestamp: ts,
      appId,
      oaId,
    };
  }

  return { kind: 'ignored', eventName, oaId: s(body?.oa_id) ?? s(body?.recipient?.id), appId };
}

// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * zalo-oa-public-routes.ts — Endpoint CÔNG KHAI (Zalo gọi vào, không có JWT):
 *   GET  /api/v1/zalo-oa/oauth/callback   — Zalo chuyển trình duyệt về sau khi admin cấp quyền OA
 *   POST /api/v1/webhooks/zalo-oa          — Zalo bắn sự kiện (tin nhắn, theo dõi, đã xem…)
 *   GET  /zalo_verifier<mã>.html           — file xác thực domain cho Zalo App
 *
 * Webhook đọc RAW body (để kiểm chữ ký X-ZEvent-Signature) → đăng ký trong plugin con riêng
 * với content-type parser dạng chuỗi, không ảnh hưởng route khác.
 */
import type { FastifyInstance } from 'fastify';
import { prisma } from '../../shared/database/prisma-client.js';
import { runSystemQuery, withTenant } from '../../shared/tenant/tenant-context.js';
import { logger } from '../../shared/utils/logger.js';
import { verifyWebhookSignature } from './oa-crypto.js';
import { parseOaEvent } from './oa-event-parser.js';
import { handleOaEvent, findOaContexts } from './oa-inbox-service.js';
import { completeOAuth, getAppSecrets, OA_CALLBACK_PATH, OA_WEBHOOK_PATH } from './oa-token-service.js';

const SETTINGS_PAGE = '/settings/channels/zalo-oa';

export async function zaloOaPublicRoutes(app: FastifyInstance): Promise<void> {
  // ── OAuth callback ──
  app.get(OA_CALLBACK_PATH, async (request, reply) => {
    const q = request.query as { code?: string; state?: string; oa_id?: string; error?: string; error_description?: string };
    if (!q.code || !q.state) {
      const why = q.error_description || q.error || 'Bạn đã huỷ hoặc Zalo không trả mã cấp quyền';
      return reply.redirect(`${SETTINGS_PAGE}?oa_error=${encodeURIComponent(why)}`, 302);
    }
    try {
      const r = await completeOAuth({ state: q.state, code: q.code, oaIdHint: q.oa_id ?? null });
      return reply.redirect(`${SETTINGS_PAGE}?oa_connected=${encodeURIComponent(r.oaName ?? '1')}`, 302);
    } catch (err) {
      logger.warn(`[zalo-oa] OAuth callback lỗi: ${(err as Error).message}`);
      return reply.redirect(`${SETTINGS_PAGE}?oa_error=${encodeURIComponent((err as Error).message)}`, 302);
    }
  });

  // ── Xác thực domain: Zalo tải https://<domain>/zalo_verifier<MÃ>.html ──
  app.get('/zalo_verifier:code(^[A-Za-z0-9_-]+).html', async (request, reply) => {
    const { code } = request.params as { code: string };
    const found = await runSystemQuery(() => prisma.zaloOaAppConfig.findFirst({ where: { domainVerifyCode: code }, select: { id: true } }));
    if (!found) return reply.status(404).send('Not found');
    return reply
      .type('text/html; charset=utf-8')
      .send(`<!DOCTYPE html><html><head><meta property="zalo-platform-site-verification" content="${code}" /></head><body>There Is No Limit To What You Can Accomplish Using Zalo!</body></html>`);
  });

  // ── Webhook ──
  await app.register(async (child) => {
    child.removeContentTypeParser('application/json');
    child.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
      done(null, body);
    });

    child.post(OA_WEBHOOK_PATH, async (request, reply) => {
      const raw = typeof request.body === 'string' ? request.body : JSON.stringify(request.body ?? {});
      let body: any;
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        return reply.status(400).send({ error: 'invalid json' });
      }
      const event = parseOaEvent(body);
      const oaId = event.oaId;

      // Kiểm chữ ký nếu org đã khai "OA Secret Key" (khuyến nghị). Chưa khai → vẫn nhận, ghi cảnh báo.
      const targets = await findOaContexts(oaId, event.appId);
      if (targets.length > 0) {
        const t = targets[0];
        const secrets = await withTenant(t.orgId, () => getAppSecrets(t.orgId)).catch(() => null);
        if (secrets?.oaSecretKey) {
          const ok = verifyWebhookSignature({
            header: request.headers['x-zevent-signature'] as string | undefined,
            appId: String(body?.app_id ?? secrets.appId),
            rawBody: raw,
            timestamp: String(body?.timestamp ?? ''),
            oaSecretKey: secrets.oaSecretKey,
          });
          if (!ok) {
            logger.warn(`[zalo-oa] webhook sai chữ ký (OA ${oaId}) — bỏ qua`);
            return reply.status(401).send({ error: 'invalid signature' });
          }
        }
      }

      // Trả 200 ngay (Zalo yêu cầu phản hồi nhanh), xử lý nền.
      void handleOaEvent(event).catch((err) => logger.error('[zalo-oa] xử lý webhook lỗi:', err));
      return reply.status(200).send({ ok: true });
    });
  });
}

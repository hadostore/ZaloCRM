// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { parseOaEvent } from '../src/modules/zalo-oa/oa-event-parser.js';
import { computeWebhookMac, createPkcePair, verifyWebhookSignature } from '../src/modules/zalo-oa/oa-crypto.js';
import * as api from '../src/modules/zalo-oa/oa-api-client.js';
import crypto from 'node:crypto';

describe('parseOaEvent', () => {
  it('khách gửi chữ → tin vào (in)', () => {
    const ev = parseOaEvent({
      app_id: '123', event_name: 'user_send_text', timestamp: '1700000000000',
      sender: { id: 'U1' }, recipient: { id: 'OA1' }, message: { text: 'Còn hàng Ziaja không ạ?', msg_id: 'm1' },
    });
    expect(ev).toMatchObject({ kind: 'message', direction: 'in', userId: 'U1', oaId: 'OA1', msgId: 'm1', contentType: 'text', content: 'Còn hàng Ziaja không ạ?' });
  });

  it('OA gửi (từ app OA Manager) → tin ra (out), userId = người nhận', () => {
    const ev = parseOaEvent({
      event_name: 'oa_send_text', timestamp: '1', sender: { id: 'OA1' }, recipient: { id: 'U1' }, message: { text: 'Dạ còn ạ', msg_id: 'm2' },
    });
    expect(ev).toMatchObject({ kind: 'message', direction: 'out', userId: 'U1', oaId: 'OA1' });
  });

  it('ảnh → JSON href cho bubble ảnh', () => {
    const ev = parseOaEvent({
      event_name: 'user_send_image', timestamp: '1', sender: { id: 'U1' }, recipient: { id: 'OA1' },
      message: { msg_id: 'm3', attachments: [{ type: 'image', payload: { url: 'https://x/a.jpg', thumbnail: 'https://x/t.jpg' } }] },
    });
    expect(ev.kind).toBe('message');
    if (ev.kind === 'message') {
      expect(ev.contentType).toBe('image');
      expect(JSON.parse(ev.content).href).toBe('https://x/a.jpg');
    }
  });

  it('follow / unfollow', () => {
    expect(parseOaEvent({ event_name: 'follow', oa_id: 'OA1', follower: { id: 'U9' }, source: 'qr_code', timestamp: '5' }))
      .toMatchObject({ kind: 'follow', userId: 'U9', oaId: 'OA1', source: 'qr_code' });
    expect(parseOaEvent({ event_name: 'unfollow', oa_id: 'OA1', follower: { id: 'U9' }, timestamp: '5' }))
      .toMatchObject({ kind: 'unfollow', userId: 'U9' });
  });

  it('user_submit_info → SĐT + địa chỉ', () => {
    const ev = parseOaEvent({
      event_name: 'user_submit_info', sender: { id: 'U1' }, recipient: { id: 'OA1' }, timestamp: '1',
      info: { name: 'Lan', phone: '0912345678', address: '12 Lê Lợi', city: 'HCM' },
    });
    expect(ev).toMatchObject({ kind: 'submit_info', info: { name: 'Lan', phone: '0912345678', address: '12 Lê Lợi, HCM' } });
  });

  it('sự kiện lạ → ignored', () => {
    expect(parseOaEvent({ event_name: 'shop_has_order' }).kind).toBe('ignored');
  });
});

describe('oa-crypto', () => {
  it('PKCE challenge = base64url(sha256(verifier))', () => {
    const { verifier, challenge } = createPkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).toBe(crypto.createHash('sha256').update(verifier).digest('base64url'));
  });

  it('chữ ký webhook đúng/sai', () => {
    const raw = '{"event_name":"user_send_text","timestamp":"123"}';
    const mac = computeWebhookMac('APP', raw, '123', 'SECRET');
    expect(verifyWebhookSignature({ header: `mac=${mac}`, appId: 'APP', rawBody: raw, timestamp: '123', oaSecretKey: 'SECRET' })).toBe(true);
    expect(verifyWebhookSignature({ header: `mac=${mac}`, appId: 'APP', rawBody: raw + ' ', timestamp: '123', oaSecretKey: 'SECRET' })).toBe(false);
    expect(verifyWebhookSignature({ header: undefined, appId: 'APP', rawBody: raw, timestamp: '123', oaSecretKey: 'SECRET' })).toBe(false);
  });
});

describe('oa-api-client', () => {
  afterEach(() => api.__setFetch(null));

  it('permission URL có app_id, redirect_uri, code_challenge, state', () => {
    const u = new URL(api.buildPermissionUrl({ appId: '111', redirectUri: 'https://crm.x/cb', codeChallenge: 'abc', state: 's1' }));
    expect(u.origin + u.pathname).toBe('https://oauth.zaloapp.com/v4/oa/permission');
    expect(u.searchParams.get('app_id')).toBe('111');
    expect(u.searchParams.get('redirect_uri')).toBe('https://crm.x/cb');
    expect(u.searchParams.get('code_challenge')).toBe('abc');
    expect(u.searchParams.get('state')).toBe('s1');
  });

  it('đổi code lấy token: gửi secret_key header + form PKCE', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    api.__setFetch((async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ access_token: 'AT', refresh_token: 'RT', expires_in: '90000' }));
    }) as unknown as typeof fetch);
    const r = await api.exchangeCode({ appId: '111', appSecret: 'SEC', code: 'C', codeVerifier: 'V' });
    expect(r).toEqual({ accessToken: 'AT', refreshToken: 'RT', expiresIn: 90000 });
    expect(seen!.url).toBe('https://oauth.zaloapp.com/v4/oa/access_token');
    expect((seen!.init.headers as Record<string, string>).secret_key).toBe('SEC');
    const form = new URLSearchParams(String(seen!.init.body));
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code_verifier')).toBe('V');
  });

  it('gửi tin tư vấn trả message_id; lỗi nghiệp vụ → ZaloOaApiError', async () => {
    api.__setFetch((async () => new Response(JSON.stringify({ error: 0, data: { message_id: 'MID' } }))) as unknown as typeof fetch);
    expect(await api.sendTextMessage('AT', 'U1', 'hi')).toBe('MID');
    api.__setFetch((async () => new Response(JSON.stringify({ error: -216, message: 'Access token is invalid' }))) as unknown as typeof fetch);
    await expect(api.sendTextMessage('AT', 'U1', 'hi')).rejects.toMatchObject({ name: 'ZaloOaApiError', isTokenError: true });
  });
});

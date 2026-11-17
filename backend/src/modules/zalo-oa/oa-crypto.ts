// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * oa-crypto.ts — Mã hoá at-rest token/secret Zalo OA (AES-256-GCM).
 *
 * Khoá: TOKEN_ENCRYPTION_KEY (64 hex, dùng chung với tích hợp khác) nếu có; nếu chưa
 * khai (bản cài bằng zalocrm-deploy.sh chỉ sinh ENCRYPTION_KEY) → dẫn xuất
 * sha256("zalo-oa:" + ENCRYPTION_KEY) để Zalo OA chạy được NGAY không phải sửa .env.
 * Lưu ý: đổi ENCRYPTION_KEY/TOKEN_ENCRYPTION_KEY sau khi kết nối → phải kết nối lại OA.
 */
import crypto from 'node:crypto';
import { config } from '../../config/index.js';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

function getKey(): Buffer {
  const hex = process.env.TOKEN_ENCRYPTION_KEY;
  if (hex && /^[0-9a-fA-F]{64}$/.test(hex)) return Buffer.from(hex, 'hex');
  return crypto.createHash('sha256').update(`zalo-oa:${config.encryptionKey}`).digest();
}

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

export function decryptSecret(blob: string): string {
  const buf = Buffer.from(blob, 'base64');
  if (buf.length < IV_LEN + TAG_LEN + 1) throw new Error('[zalo-oa] secret blob hỏng');
  const decipher = crypto.createDecipheriv(ALGO, getKey(), buf.subarray(0, IV_LEN));
  decipher.setAuthTag(buf.subarray(IV_LEN, IV_LEN + TAG_LEN));
  return Buffer.concat([decipher.update(buf.subarray(IV_LEN + TAG_LEN)), decipher.final()]).toString('utf8');
}

/** PKCE (RFC 7636) — Zalo OAuth v4 bắt buộc code_challenge S256. */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url'); // 43 ký tự
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * Chữ ký webhook Zalo: header `X-ZEvent-Signature: mac=<hex>` với
 * mac = sha256(appId + rawBody + timestamp + oaSecretKey).
 */
export function computeWebhookMac(appId: string, rawBody: string, timestamp: string, oaSecretKey: string): string {
  return crypto.createHash('sha256').update(`${appId}${rawBody}${timestamp}${oaSecretKey}`).digest('hex');
}

export function verifyWebhookSignature(args: {
  header: string | undefined;
  appId: string;
  rawBody: string;
  timestamp: string;
  oaSecretKey: string;
}): boolean {
  const raw = (args.header ?? '').trim();
  const got = raw.startsWith('mac=') ? raw.slice(4) : raw;
  if (!/^[0-9a-f]{64}$/i.test(got)) return false;
  const want = computeWebhookMac(args.appId, args.rawBody, args.timestamp, args.oaSecretKey);
  return crypto.timingSafeEqual(Buffer.from(got.toLowerCase(), 'hex'), Buffer.from(want, 'hex'));
}

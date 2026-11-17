<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!--
  ZaloOaSettingsPage — Cài đặt "Zalo OA (API chính thức)" (2026-11-17).
  1) Khai App ID / Secret Key / OA Secret Key (từ developers.zalo.me) + mã xác thực domain
  2) Kết nối OA bằng OAuth → hội thoại OA hiện trong hộp Chat như 1 nick "OA · <tên>"
  3) Đồng bộ người theo dõi, gửi thử ZNS, xem thống kê tương tác
  API: /api/v1/zalo-oa/* (owner/admin). Hướng dẫn: docs/HUONG-DAN-TICH-HOP-ZALO-OA.md
-->
<template>
  <div class="oa-page">
    <header class="oa-head">
      <div class="oa-ico">💬</div>
      <div>
        <h1>Zalo OA (API chính thức)</h1>
        <p>
          Kết nối Zalo Official Account để <b>nhận &amp; trả lời tin nhắn OA ngay trong hộp Chat</b>, tự lưu khách vào CRM,
          đồng bộ người theo dõi và gửi <b>ZNS</b> (xác nhận đơn, nhắc lịch, chăm sóc sau mua).
        </p>
      </div>
    </header>

    <div v-if="flash" :class="['oa-flash', flash.type]">{{ flash.text }}</div>
    <div v-if="loading" class="oa-loading">Đang tải…</div>

    <template v-else>
      <!-- Bước 1: cấu hình app -->
      <section class="oa-card">
        <h2><span class="oa-step">1</span> Thông tin Zalo App</h2>
        <p class="hint">Lấy ở <a href="https://developers.zalo.me" target="_blank" rel="noopener">developers.zalo.me</a> → Ứng dụng của bạn. Ô bí mật để trống = giữ nguyên giá trị đã lưu.</p>
        <div class="grid">
          <label>App ID
            <input v-model.trim="form.appId" placeholder="vd 1234567890123456789" />
          </label>
          <label>Secret Key (khoá bí mật của ứng dụng)
            <input v-model.trim="form.appSecret" type="password" :placeholder="cfg.hasAppSecret ? '•••••• (đã lưu)' : 'dán Secret Key'" autocomplete="off" />
          </label>
          <label>OA Secret Key (mục Webhook — dùng kiểm chữ ký)
            <input v-model.trim="form.oaSecretKey" type="password" :placeholder="cfg.hasOaSecretKey ? '•••••• (đã lưu)' : 'khuyến nghị điền'" autocomplete="off" />
          </label>
          <label>Mã xác thực domain (tên file zalo_verifier…html)
            <input v-model.trim="form.domainVerifyCode" placeholder="vd zalo_verifierAbC123.html" />
          </label>
        </div>
        <div class="copy-rows">
          <div class="copy-row">
            <span>Callback URL (khai ở mục Official Account → Callback URL)</span>
            <code>{{ cfg.redirectUri }}</code>
            <button class="btn ghost" @click="copy(cfg.redirectUri)">Sao chép</button>
          </div>
          <div class="copy-row">
            <span>Webhook URL (khai ở mục Webhook)</span>
            <code>{{ cfg.webhookUrl }}</code>
            <button class="btn ghost" @click="copy(cfg.webhookUrl)">Sao chép</button>
          </div>
          <div v-if="cfg.domainVerifyCode" class="copy-row">
            <span>File xác thực domain đang phục vụ tại</span>
            <code>{{ verifierUrl }}</code>
            <a class="btn ghost" :href="verifierUrl" target="_blank" rel="noopener">Mở thử</a>
          </div>
        </div>
        <p v-if="!cfg.webhookUrl.startsWith('https://')" class="warn">
          ⚠️ Zalo chỉ chấp nhận Webhook/Callback qua <b>HTTPS</b> với tên miền thật (vd https://crm.hadostore.shop). Sửa APP_URL trong .env rồi khởi động lại.
        </p>
        <div class="actions">
          <button class="btn primary" :disabled="saving" @click="saveConfig">{{ saving ? 'Đang lưu…' : 'Lưu cấu hình' }}</button>
        </div>
      </section>

      <!-- Bước 2: kết nối OA -->
      <section class="oa-card">
        <h2><span class="oa-step">2</span> Kết nối Official Account</h2>
        <p class="hint">Bấm nút, đăng nhập Zalo bằng tài khoản <b>quản trị OA</b> và chọn OA cần cấp quyền. Sau khi kết nối, hội thoại OA xuất hiện trong <RouterLink to="/chat">Chat</RouterLink> dưới nick <b>“OA · tên OA”</b>.</p>
        <div class="actions">
          <button class="btn primary" :disabled="!canConnect || busy === 'connect'" @click="connect">
            {{ connections.length ? 'Kết nối thêm / kết nối lại OA' : 'Kết nối Zalo OA' }}
          </button>
          <span v-if="!canConnect" class="muted">Lưu App ID + Secret Key trước.</span>
        </div>

        <div v-for="c in connections" :key="c.id" class="conn">
          <img v-if="c.oaAvatarUrl" :src="c.oaAvatarUrl" class="conn-ava" alt="" />
          <div class="conn-main">
            <div class="conn-name">{{ c.oaName || c.oaId }} <span :class="['badge', c.status]">{{ statusLabel(c.status) }}</span></div>
            <div class="muted">
              OA ID {{ c.oaId }} · Token hết hạn {{ fmt(c.tokenExpiresAt) }} (tự gia hạn) ·
              Webhook gần nhất {{ c.lastWebhookAt ? fmt(c.lastWebhookAt) : 'chưa nhận' }} ·
              Đồng bộ follower {{ c.followersSyncedAt ? fmt(c.followersSyncedAt) : 'chưa' }}
            </div>
            <div v-if="c.lastError && c.status !== 'connected'" class="err">Lỗi: {{ c.lastError }}</div>
          </div>
          <div class="conn-actions">
            <button class="btn ghost" :disabled="busy === c.id + 'sync'" @click="syncFollowers(c)">Đồng bộ người theo dõi</button>
            <button class="btn ghost" :disabled="busy === c.id + 'refresh'" @click="refresh(c)">Làm mới token</button>
            <button class="btn danger" @click="disconnectConn(c)">Ngắt</button>
          </div>
        </div>
      </section>

      <!-- Thống kê -->
      <section v-if="connections.length" class="oa-card">
        <h2><span class="oa-step icon">📊</span> Hiệu quả tương tác 30 ngày</h2>
        <div class="stats">
          <div class="stat"><b>{{ stats.followers ?? '–' }}</b><span>Người theo dõi trong CRM</span></div>
          <div class="stat"><b>{{ stats.newContacts ?? '–' }}</b><span>Khách mới từ OA</span></div>
          <div class="stat"><b>{{ stats.conversations ?? '–' }}</b><span>Hội thoại có tin</span></div>
          <div class="stat warn-stat"><b>{{ stats.waitingReply ?? '–' }}</b><span>Đang chờ trả lời</span></div>
          <div class="stat"><b>{{ stats.messagesIn ?? '–' }}</b><span>Tin khách gửi</span></div>
          <div class="stat"><b>{{ stats.messagesOut ?? '–' }}</b><span>Tin shop trả lời</span></div>
          <div class="stat"><b>{{ stats.zns?.sent ?? 0 }} / {{ stats.zns?.delivered ?? 0 }}</b><span>ZNS đã gửi / khách đã nhận</span></div>
          <div class="stat"><b>{{ stats.unfollowed ?? '–' }}</b><span>Đã bỏ theo dõi</span></div>
        </div>
      </section>

      <!-- ZNS -->
      <section v-if="connections.length" class="oa-card">
        <h2><span class="oa-step icon">✉️</span> Gửi thử ZNS</h2>
        <p class="hint">ZNS gửi theo <b>số điện thoại</b> (khách không cần theo dõi OA), dùng mẫu đã được Zalo duyệt. Mỗi tin có phí theo bảng giá Zalo.</p>
        <div class="actions">
          <button class="btn ghost" @click="loadTemplates">Tải danh sách mẫu ZNS</button>
        </div>
        <div class="grid">
          <label>Mẫu ZNS
            <select v-model="zns.templateId">
              <option value="">— chọn hoặc nhập mã bên dưới —</option>
              <option v-for="t in templates" :key="t.templateId" :value="t.templateId">{{ t.templateName }} ({{ t.templateId }}) · {{ t.status }}</option>
            </select>
          </label>
          <label>Mã mẫu (template_id)
            <input v-model.trim="zns.templateId" placeholder="vd 228561" />
          </label>
          <label>Số điện thoại nhận
            <input v-model.trim="zns.phone" placeholder="0912345678" />
          </label>
          <label class="wide">Dữ liệu mẫu (JSON, tên tham số đúng như mẫu)
            <textarea v-model="zns.data" rows="4" placeholder='{"customer_name":"Lan","order_code":"HD001"}' />
          </label>
        </div>
        <div class="actions">
          <button class="btn primary" :disabled="busy === 'zns'" @click="sendZns">Gửi ZNS</button>
        </div>
        <table v-if="znsLogs.length" class="logs">
          <thead><tr><th>Lúc</th><th>SĐT</th><th>Mẫu</th><th>Trạng thái</th></tr></thead>
          <tbody>
            <tr v-for="l in znsLogs" :key="l.id">
              <td>{{ fmt(l.createdAt) }}</td><td>{{ l.phone }}</td><td>{{ l.templateId }}</td>
              <td :title="l.error || ''">{{ znsLabel(l.status) }}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '@/api';

interface Conn {
  id: string; oaId: string; oaName: string | null; oaAvatarUrl: string | null; status: string; lastError: string | null;
  tokenExpiresAt: string | null; lastWebhookAt: string | null; followersSyncedAt: string | null; nickId: string | null;
}

const route = useRoute();
const router = useRouter();
const loading = ref(true);
const saving = ref(false);
const busy = ref<string | null>(null);
const flash = ref<{ type: 'ok' | 'error'; text: string } | null>(null);
const cfg = reactive({ appId: null as string | null, hasAppSecret: false, hasOaSecretKey: false, domainVerifyCode: null as string | null, redirectUri: '', webhookUrl: '' });
const form = reactive({ appId: '', appSecret: '', oaSecretKey: '', domainVerifyCode: '' });
const connections = ref<Conn[]>([]);
const stats = ref<any>({});
const templates = ref<Array<{ templateId: string; templateName: string; status: string }>>([]);
const znsLogs = ref<any[]>([]);
const zns = reactive({ templateId: '', phone: '', data: '{}' });

const canConnect = computed(() => !!cfg.appId && cfg.hasAppSecret);
const verifierUrl = computed(() => {
  try { return `${new URL(cfg.webhookUrl).origin}/zalo_verifier${cfg.domainVerifyCode}.html`; } catch { return ''; }
});

function say(type: 'ok' | 'error', text: string) {
  flash.value = { type, text };
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function errMsg(e: any) { return e?.response?.data?.error || e?.message || 'Có lỗi xảy ra'; }
function fmt(d: string | null) { return d ? new Date(d).toLocaleString('vi-VN') : '–'; }
function statusLabel(s: string) { return s === 'connected' ? 'Đang hoạt động' : s === 'revoked' ? 'Đã ngắt' : 'Lỗi — cần kết nối lại'; }
function znsLabel(s: string) { return ({ pending: 'Đang gửi', sent: 'Đã gửi', delivered: 'Khách đã nhận', failed: 'Lỗi' } as Record<string, string>)[s] || s; }
async function copy(t: string) { try { await navigator.clipboard.writeText(t); say('ok', 'Đã sao chép'); } catch { /* ignore */ } }

async function load() {
  loading.value = true;
  try {
    const { data } = await api.get('/zalo-oa/config');
    Object.assign(cfg, data.config);
    form.appId = data.config.appId || '';
    form.domainVerifyCode = data.config.domainVerifyCode ? `zalo_verifier${data.config.domainVerifyCode}.html` : '';
    connections.value = data.connections;
    if (connections.value.length) {
      const [s, l] = await Promise.all([api.get('/zalo-oa/stats'), api.get('/zalo-oa/zns/logs', { params: { limit: 20 } })]);
      stats.value = s.data;
      znsLogs.value = l.data.logs;
    }
  } catch (e) {
    say('error', errMsg(e));
  } finally {
    loading.value = false;
  }
}

async function saveConfig() {
  saving.value = true;
  try {
    const body: Record<string, string> = { appId: form.appId, domainVerifyCode: form.domainVerifyCode };
    if (form.appSecret) body.appSecret = form.appSecret;
    if (form.oaSecretKey) body.oaSecretKey = form.oaSecretKey;
    const { data } = await api.put('/zalo-oa/config', body);
    Object.assign(cfg, data);
    form.appSecret = '';
    form.oaSecretKey = '';
    say('ok', 'Đã lưu cấu hình Zalo App');
  } catch (e) { say('error', errMsg(e)); } finally { saving.value = false; }
}

async function connect() {
  busy.value = 'connect';
  try {
    const { data } = await api.post('/zalo-oa/oauth/start');
    window.location.href = data.url;
  } catch (e) { say('error', errMsg(e)); busy.value = null; }
}

async function refresh(c: Conn) {
  busy.value = c.id + 'refresh';
  try { await api.post(`/zalo-oa/connections/${c.id}/refresh`); say('ok', 'Đã làm mới token'); await load(); }
  catch (e) { say('error', errMsg(e)); } finally { busy.value = null; }
}

async function syncFollowers(c: Conn) {
  busy.value = c.id + 'sync';
  try {
    await api.post(`/zalo-oa/connections/${c.id}/sync-followers`);
    say('ok', 'Đang đồng bộ người theo dõi ở chế độ nền (vài phút với OA nhiều follower). Tải lại trang sau để xem số liệu.');
  } catch (e) { say('error', errMsg(e)); } finally { busy.value = null; }
}

async function disconnectConn(c: Conn) {
  if (!window.confirm(`Ngắt kết nối OA "${c.oaName || c.oaId}"? Lịch sử chat vẫn giữ trong CRM.`)) return;
  try { await api.post(`/zalo-oa/connections/${c.id}/disconnect`); await load(); say('ok', 'Đã ngắt kết nối'); }
  catch (e) { say('error', errMsg(e)); }
}

async function loadTemplates() {
  const c = connections.value.find((x) => x.status === 'connected') || connections.value[0];
  if (!c) return;
  try {
    const { data } = await api.get(`/zalo-oa/connections/${c.id}/zns/templates`);
    templates.value = data.templates;
    if (!templates.value.length) say('ok', 'OA chưa có mẫu ZNS nào được duyệt (tạo mẫu tại account.zalo.cloud).');
  } catch (e) { say('error', errMsg(e)); }
}

async function sendZns() {
  let templateData: Record<string, unknown>;
  try { templateData = JSON.parse(zns.data || '{}'); } catch { say('error', 'Dữ liệu mẫu phải là JSON hợp lệ'); return; }
  busy.value = 'zns';
  try {
    const c = connections.value.find((x) => x.status === 'connected');
    await api.post('/zalo-oa/zns/send', { connectionId: c?.id, phone: zns.phone, templateId: zns.templateId, templateData });
    say('ok', 'Đã gửi ZNS');
  } catch (e) { say('error', errMsg(e)); } finally { busy.value = null; await load(); }
}

onMounted(async () => {
  const q = { ...route.query };
  if (q.oa_connected || q.oa_error) router.replace({ query: {} });
  await load();
  if (q.oa_connected) flash.value = { type: 'ok', text: `Đã kết nối Zalo OA “${q.oa_connected}”. Hội thoại mới sẽ hiện trong Chat.` };
  if (q.oa_error) flash.value = { type: 'error', text: `Kết nối Zalo OA thất bại: ${q.oa_error}` };
});
</script>

<style scoped>
.oa-page { max-width: 960px; }
.oa-head { display: flex; gap: 14px; align-items: flex-start; margin-bottom: 18px; }
.oa-ico { width: 44px; height: 44px; border-radius: 12px; background: #e8f3ff; display: grid; place-items: center; font-size: 22px; flex: none; }
.oa-head h1 { font-size: 19px; font-weight: 700; margin: 0 0 4px; }
.oa-head p, .hint { font-size: 13px; color: #6B7785; margin: 0 0 12px; line-height: 1.55; }
.oa-loading { padding: 28px; text-align: center; color: #97A0AC; }
.oa-flash { padding: 10px 14px; border-radius: 10px; margin-bottom: 14px; font-size: 13px; }
.oa-flash.ok { background: #ecfdf5; color: #065f46; }
.oa-flash.error { background: #fef2f2; color: #991b1b; }
.oa-card { background: #fff; border: 1px solid #E5E9EF; border-radius: 14px; padding: 18px; margin-bottom: 16px; }
.oa-card h2 { font-size: 15px; font-weight: 700; margin: 0 0 6px; display: flex; gap: 8px; align-items: center; }
.oa-step { flex: 0 0 24px; width: 24px; height: 24px; border-radius: 50%; background: #0068FF; color: #fff; display: inline-flex; align-items: center; justify-content: center; font-size: 12px; line-height: 1; }
.oa-step.icon { background: transparent; font-size: 16px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; margin-bottom: 12px; }
.grid label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #4B5563; font-weight: 600; }
.grid label.wide { grid-column: 1 / -1; }
.grid input, .grid select, .grid textarea { border: 1px solid #D1D5DB; border-radius: 8px; padding: 8px 10px; font-size: 13px; font-weight: 400; font-family: inherit; background: #fff; }
.copy-rows { display: flex; flex-direction: column; gap: 8px; margin-bottom: 10px; }
.copy-row { display: grid; grid-template-columns: minmax(180px, 260px) 1fr auto; gap: 8px; align-items: center; font-size: 12px; color: #4B5563; }
.copy-row code { background: #F3F4F6; padding: 6px 8px; border-radius: 6px; overflow-x: auto; white-space: nowrap; font-size: 12px; }
.actions { display: flex; gap: 10px; align-items: center; margin: 8px 0; flex-wrap: wrap; }
.btn { border: 1px solid transparent; border-radius: 8px; padding: 7px 14px; font-size: 13px; font-weight: 600; cursor: pointer; text-decoration: none; }
.btn:disabled { opacity: .55; cursor: not-allowed; }
.btn.primary { background: #0068FF; color: #fff; }
.btn.ghost { background: #fff; color: #0068FF; border-color: #BFD7FF; }
.btn.danger { background: #fff; color: #b91c1c; border-color: #fecaca; }
.muted { font-size: 12px; color: #8A94A3; }
.warn { font-size: 12px; color: #92400e; background: #fffbeb; padding: 8px 10px; border-radius: 8px; }
.err { font-size: 12px; color: #b91c1c; margin-top: 4px; }
.conn { display: flex; gap: 12px; align-items: center; padding: 12px 0; border-top: 1px solid #F0F2F5; flex-wrap: wrap; }
.conn-ava { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; }
.conn-main { flex: 1; min-width: 240px; }
.conn-name { font-weight: 700; font-size: 14px; margin-bottom: 2px; }
.conn-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.badge { font-size: 11px; padding: 2px 8px; border-radius: 99px; margin-left: 6px; font-weight: 600; }
.badge.connected { background: #dcfce7; color: #166534; }
.badge.revoked { background: #f3f4f6; color: #4b5563; }
.badge.error { background: #fee2e2; color: #991b1b; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; }
.stat { background: #F8FAFC; border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 2px; }
.stat b { font-size: 20px; }
.stat span { font-size: 12px; color: #6B7785; }
.warn-stat b { color: #b45309; }
.logs { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 10px; }
.logs th, .logs td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #F0F2F5; }
@media (max-width: 640px) { .copy-row { grid-template-columns: 1fr; } }
</style>

-- 2026-11-17 — Zalo OA (API chính thức): chat qua hộp thư CRM + ZNS + đồng bộ người theo dõi.

-- ZaloAccount: kênh (personal | oa) + liên kết tới ZaloOaConnection
ALTER TABLE "zalo_accounts" ADD COLUMN "channel" TEXT NOT NULL DEFAULT 'personal';
ALTER TABLE "zalo_accounts" ADD COLUMN "oa_connection_id" TEXT;
CREATE UNIQUE INDEX "zalo_accounts_oa_connection_id_key" ON "zalo_accounts"("oa_connection_id");

-- ZaloOaAppConfig: khoá ký webhook + mã xác thực domain + trạng thái OAuth (PKCE)
ALTER TABLE "zalo_oa_app_configs" ADD COLUMN "oa_secret_key_enc" TEXT;
ALTER TABLE "zalo_oa_app_configs" ADD COLUMN "domain_verify_code" TEXT;
ALTER TABLE "zalo_oa_app_configs" ADD COLUMN "oauth_state" TEXT;
ALTER TABLE "zalo_oa_app_configs" ADD COLUMN "oauth_code_verifier" TEXT;
ALTER TABLE "zalo_oa_app_configs" ADD COLUMN "oauth_started_at" TIMESTAMP(3);
CREATE UNIQUE INDEX "zalo_oa_app_configs_oauth_state_key" ON "zalo_oa_app_configs"("oauth_state");

-- ZaloOaConnection: avatar + mốc webhook/đồng bộ
ALTER TABLE "zalo_oa_connections" ADD COLUMN "oa_avatar_url" TEXT;
ALTER TABLE "zalo_oa_connections" ADD COLUMN "last_webhook_at" TIMESTAMP(3);
ALTER TABLE "zalo_oa_connections" ADD COLUMN "followers_synced_at" TIMESTAMP(3);

-- Nhật ký ZNS
CREATE TABLE "zalo_zns_logs" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "oa_connection_id" TEXT NOT NULL,
    "contact_id" TEXT,
    "phone" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "template_data" JSONB NOT NULL DEFAULT '{}',
    "tracking_id" TEXT NOT NULL,
    "zns_msg_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "sent_by_user_id" TEXT,
    "sent_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "zalo_zns_logs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "zalo_zns_logs_org_id_tracking_id_key" ON "zalo_zns_logs"("org_id", "tracking_id");
CREATE INDEX "zalo_zns_logs_org_id_created_at_idx" ON "zalo_zns_logs"("org_id", "created_at");
CREATE INDEX "zalo_zns_logs_zns_msg_id_idx" ON "zalo_zns_logs"("zns_msg_id");

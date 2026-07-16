-- حذف الجداول القديمة (إن وجدت)
DROP TABLE IF EXISTS submissions;
DROP TABLE IF EXISTS forms;

-- يبقى كما هو (تأكد من وجوده)
CREATE TABLE IF NOT EXISTS merchants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salla_store_id BIGINT UNIQUE NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  token_expires_at TIMESTAMPTZ NOT NULL,
  -- الربط بـauth.users ضروري لتفعيل RLS متعدد المستأجرين
  -- (انظر supabase-rls-and-user-link.sql). nullable أثناء الانتقال من Phase 7.
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS merchants_user_id_unique
  ON merchants(user_id) WHERE user_id IS NOT NULL;

-- جديد: يحل محل forms (ربط المنتج بالمصمم)
CREATE TABLE product_designer_map (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID REFERENCES merchants(id) ON DELETE CASCADE,
  salla_product_id BIGINT NOT NULL,
  product_label TEXT NOT NULL,
  is_generic_variant BOOLEAN DEFAULT FALSE, -- true = هذا الـSKU هو "بدون اسم"
  designer_name TEXT NOT NULL,
  designer_whatsapp TEXT NOT NULL,          -- صيغة دولية كاملة: 9665xxxxxxxx
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- جديد: يحل محل submissions (سجل عمليات التوجيه)
CREATE TABLE order_routing_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID REFERENCES merchants(id) ON DELETE CASCADE,
  salla_order_id BIGINT NOT NULL,
  salla_product_id BIGINT NOT NULL,
  raw_note TEXT,
  personalization_detected BOOLEAN DEFAULT FALSE,
  extracted_name TEXT,
  designer_whatsapp TEXT,
  whatsapp_status TEXT DEFAULT 'pending',   -- pending | sent | failed
  created_at TIMESTAMPTZ DEFAULT NOW()
);

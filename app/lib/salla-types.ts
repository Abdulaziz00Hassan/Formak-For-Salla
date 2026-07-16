/**
 * Salla Webhook Payload Types
 *
 * التعريفات الرسمية لاستجابات سلة (Salla). صُمّمت لتكون ضيقة الأنواع قدر
 * الإمكان. الحقول غير المعروفة التي قد تُرسلها سلة في المستقبل تُجمَّع في
 * حقل `extra: Record<string, unknown>` لمنع استخدام `any`.
 *
 * مرجع الوثيقة: Formak-Ai-Context-v2.md — القسم 7 (القواعد الذهبية)
 */

// ─── أنوية الـ Payload الأساسية ───────────────────────────────────────────

/** عنصر واحد داخل الطلب. الحقول المعروفة فقط؛ الباقي في `extra`. */
export interface SallaOrderItem {
  id: number;
  product_id: number;
  name: string;
  quantity: number;
  price: number;
  total: number;
  /** حقل الملاحظة — هذا هو الحقل المستهدف لاستخراج اسم التخصيص. */
  note: string | null;
  /** sku أو معرّف خيار المنتج (variant id) — قد يكون مفقوداً في الطلبات العامة. */
  sku?: string;
  /** حقول إضافية غير موثّقة بعد تُرسلها سلة — نلتقطها للتشخيص دون التضحية بالأنواع. */
  extra?: Record<string, unknown>;
}

export interface SallaCustomer {
  id: number;
  name: string;
  mobile: string;
  email: string | null;
  extra?: Record<string, unknown>;
}

export interface SallaOrderData {
  id: number;
  items: SallaOrderItem[];
  customer: SallaCustomer | null;
  status: string | null;
  total: number | null;
  subtotal: number | null;
  tax: number | null;
  discount: number | null;
  shipping: number | null;
  created_at: string | null;
  updated_at: string | null;
  extra?: Record<string, unknown>;
}

export interface SallaWebhookPayload {
  event: string;
  data: SallaOrderData;
  created_at: string;
  /** معرّف المتجر عند سلة (BigInt) */
  merchant: number;
  extra?: Record<string, unknown>;
}

// ─── جداول Supabase (مطابقة لـ supabase-schema.sql) ──────────────────────

export interface MerchantsTableRow {
  id: string;
  salla_store_id: number;
  access_token: string;
  refresh_token: string;
  token_expires_at: string;
  created_at: string;
}

export interface ProductDesignerMapRow {
  id: string;
  merchant_id: string;
  salla_product_id: number;
  product_label: string;
  is_generic_variant: boolean;
  designer_name: string;
  /** رقم دولي كامل بدون + أو مسافات: 9665XXXXXXXX */
  designer_whatsapp: string;
  created_at: string;
}

export type WhatsAppStatus = 'pending' | 'sent' | 'failed' | 'skipped';

export interface OrderRoutingLogRow {
  id: string;
  merchant_id: string;
  salla_order_id: number;
  salla_product_id: number;
  raw_note: string | null;
  personalization_detected: boolean;
  extracted_name: string | null;
  designer_whatsapp: string | null;
  whatsapp_status: WhatsAppStatus;
  /** HTTP status من استجابة Meta (null حين لم تُرسَل رسالة). */
  whatsapp_http_status: number | null;
  /** جسم الاستجابة الكامل من Meta للتشخيص (null حين لم تُرسَل رسالة). */
  whatsapp_response_json: Record<string, unknown> | null;
  created_at: string;
}

// ─── أنواع داخلية لمنطق المعالجة ─────────────────────────────────────────

/** نتيجة معالجة عنصر واحد داخل الـ Webhook handler. */
export interface OrderItemProcessingResult {
  productId: number;
  productName: string;
  hasNote: boolean;
  note: string | null;
  personalizationDetected: boolean;
  extractedName: string | null;
  patternMatched: string | null;
  designerWhatsApp: string | null;
  /**
   * حالة إرسال الواتساب لهذا العنصر:
   *  - 'pending'  : لم يُحاول الإرسال بعد (أو قبل المحاولة).
   *  - 'sent'     : أُرسلت الرسالة بنجاح.
   *  - 'failed'   : فشلت المحاولة (رمي استثناء أو إرجاع status: 'failed').
   *  - 'skipped'  : لم يُحاول الإرسال (لا تخصيص أو لا تعيين للمصمم).
   */
  whatsappStatus: WhatsAppStatus | 'skipped';
  status: 'pending' | 'processed' | 'skipped' | 'error';
  error: string | null;
}

/** ملخص معالجة الطلب كاملاً — يُسجَّل ويُعاد في الـ logs. */
export interface OrderProcessingSummary {
  orderId: number;
  totalItems: number;
  processedItems: number;
  skippedItems: number;
  itemsWithPersonalization: number;
}

/** نتيجة المحاولة الكاملة لاستخراج اسم من الملاحظة. */
export interface NameExtractionResult {
  extractedName: string | null;
  patternMatched: string | null;
  confidence: ConfidenceLevel;
}

export type ConfidenceLevel = 'high' | 'medium' | 'low';

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

/** عنصر واحد داخل الطلب. الحقول المعروفة فقط؛ الباقي في `extra`.
 *
 * ⚠️ مصدر موثوق: docs.salla.dev (Create Order + List Order Items).
 *    معرّف المنتج متداخل تحت `product.id` وليس حقلاً مسطّحاً.
 *    `id` هنا هو معرّف عنصر السطر (line item) نفسه.
 */
/**
 * عنصر واحد داخل مصفوفة `item.options[]` (خيارات المنتج المخصصة في السلة).
 *
 * ⚠️ عندما يُعرّف التاجر "خيارات" على المنتج في سلة (مثلاً: "بأسم:" كحقل نصي
 *    إجباري)، يدخل العميل القيمة عبر هذا الخيار — وليس في حقل `item.notes` العام.
 *    في هذه الحالة `item.notes = null/""` ويكون التخصيص بالكامل داخل `options[]`.
 *
 *    البنية الفعلية من Salla webhook `order.created` تختلف بحسب نوع الخيار:
 *
 *  - `text` / `textarea`:
 *      `{ id, name: "بأسم", type: "text", value: { name: "عبدالله" } }`
 *      أو `{ id, name: "بأسم", type: "text", value: "عبدالله" }`
 *      أو `{ id, name: "بأسم", type: "text", value: { name: "عبدالله", extra: {...} } }`
 *
 *  - `select` / `radio`:
 *      `{ id, name: "اللون", type: "select", value: { name: "أحمر" } }`
 *
 *  - `checkbox` (متعدد) / `multiselect`:
 *      `{ id, name: "إضافات", type: "checkbox", value: [{ name: "علبة هدايا" }, ...] }`
 *      أو `{ value: "علبة هدية" }` (مفردة نصية)
 *
 *  - `file` / `image`:
 *      `{ id, name: "صورة", type: "file", value: { url: "...", name: "..." } }`
 *      نُسقط قيمتها من استخراج الاسم (لا تخص التخصيص النصي).
 *
 *  - `date` / `number`:
 *      `{ id, name: "تاريخ", type: "date", value: "2025-08-15" }`
 *
 * ⚠️ المرونة في القراءة: `value` قد يكون:
 *    - `string` (مباشر)
 *    - `number` (نادر)
 *    - `null` / `undefined` (الخيار فارغ — نُسقطه)
 *    - `object` فيه `name` (الشكل الشائع)
 *    - `array` من objects (متعدد)
 *    - `object` بدون `name` (نادر — نُسقطه)
 *
 *    الكود في `extractCustomizationFromOptions` يتعامل مع كل هذه الأشكال
 *    ويرجّع سلسلة نصية موحّدة بصيغة "الاسم: القيمة" — قابلة للتغذية مباشرة
 *    في `extractNameFromNote` (الذي يستعمل نفس Regex على النص الموحّد).
 *
 * مرجع الخطأ #30 في Formak-Handoff-4.md.
 */
export interface SallaOrderItemOption {
  /** معرّف الخيار داخل سلة. */
  id?: number;
  /** اسم/سؤال الخيار كما يراه العميل في صفحة المنتج (مثال: "بأسم", "الاسم", "اللون"). */
  name?: string;
  /** نوع الخيار — يحدّد كيفية قراءة `value`. */
  type?: string;
  /** القيمة المُدخلة من العميل — قد تكون string أو object أو array حسب النوع. */
  value?: unknown;
  /** حقول إضافية قد تُرسلها سلة. */
  extra?: Record<string, unknown>;
}

export interface SallaOrderItem {
  /** معرّف عنصر السطر (line item) — ليس معرّف المنتج. */
  id: number;
  name: string;
  quantity: number;
  price: number;
  total: number;
  /** حقل الملاحظة العام — هذا أحد الحقلين المستهدفين لاستخراج اسم التخصيص.
   *
   * ⚠️ اسم الحقل في Salla API: `notes` (جمع)، وليس `note` (مفرد).
   *    الكود السابق كان يقرأ `note` ويستقبل `undefined` دائماً،
   *    فيُسجَّل `raw_note: ""` و `extracted_name: null` في order_routing_log.
   *
   * ⚠️ العميل الحقيقي في الإنتاج قد يدخل التخصيص هنا، أو في `options[]`
   *    (بحسب إعداد التاجر في سلة). نقرأ المصدرين معاً — راجع
   *    `extractCustomizationFromOptions` في order-processor.ts.
   */
  notes: string | null;
  /** sku أو معرّف خيار المنتج (variant id) — قد يكون مفقوداً في الطلبات العامة. */
  sku?: string;
  /** معلومات المنتج — `product.id` هو المفتاح الذي يُربط بـ `product_designer_map.salla_product_id`. */
  product: {
    id: number;
    type?: string;
    sku?: string;
    name?: string;
    extra?: Record<string, unknown>;
  };
  /** 🆕 قائمة خيارات المنتج المخصصة — حقل ثاني محتمل لاسم التخصيص.
   *
   *  الخطأ #30 (Formak-Handoff-4.md): التخصيص الذي يدخله العميل عبر "خيار
   *  منتج" مُهيّأ في سلة يصل هنا، وليس في `notes`. الكود السابق كان يتجاهله
   *  بالكامل فيُسجَّل `personalization_detected=false` رغم وجود تخصيص حقيقي.
   *
   *  الحقل اختياري في الـ schema: قَديم من Salla webhook لم يكن يحويه، أو قد
   *  يكون فارغاً للمنتجات بدون خيارات. معالج بحارس نوع في order-processor.
   */
  options?: SallaOrderItemOption[];
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

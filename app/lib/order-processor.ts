/**
 * Order Processor — منطق المعالجة الخلفية للطلبات
 *
 * يُستدعى هذا الملف من الـ Webhook handler بعد إرجاع 200 لسلة. يحتوي على
 * كل العمليات الثقيلة: البحث عن المصمم، تطبيق Regex، كتابة السجلات،
 * إرسال رسائل واتساب.
 *
 * الفصل عن الـ Route Handler يضمن:
 *  1. أن يبقى ملف الراوت صغيراً وسريعاً (< 50ms لإرجاع 200).
 *  2. أن نقدر نختبر منطق المعالجة بوحداتها بدون محاكاة HTTP.
 *  3. أن أي خطأ في المعالجة لا يؤثّر على استجابة سلة.
 *
 * مرجع الوثيقة: Formak-Ai-Context-v2.md — القسم 4 (آلية العمل)
 */

import { createClient as createSupabaseAdminClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';

import { extractNameFromNote } from '@/app/lib/name-extractor';
import type {
  OrderItemProcessingResult,
  OrderProcessingSummary,
  SallaOrderItem,
  SallaWebhookPayload,
} from '@/app/lib/salla-types';

/**
 * يبني Supabase Admin Client مع Service Role Key.
 *
 * ⚠️ يُستخدم فقط داخل Route Handlers الخلفية (server-side).
 *    يتجاوز RLS وله صلاحيات كاملة — لا يُكشف للواجهة الأمامية أبداً.
 *
 * مرجع الوثيقة: Formak-Ai-Context-v2.md — القسم 7 (القاعدة 3).
 */
export function createOrderRoutingSupabaseClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new Error(
      '[Supabase] Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env.'
    );
  }

  return createSupabaseAdminClient(url, serviceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

export interface ProcessOrderDeps {
  /** Admin client حقيقي من Supabase (Service Role). */
  supabase: SupabaseClient;
  /** رقم الـ merchant عند سلة (يأتي في `payload.merchant`). */
  sallaMerchantId: number;
  /**
   * معرّف التاجر UUID من جدول merchants — اختياري.
   * إن لم يُمرَّر، تجلبه الدالة محلياً عبر `lookupMerchantId`.
   * مفيد في الاختبارات لتجاوز خطوة الـ lookup الإضافية.
   */
  merchantId?: string | null;
  /** دالة إرسال رسالة واتساب — تُحقن للاختبار. */
  sendWhatsApp: (params: WhatsAppSendParams) => Promise<WhatsAppSendResult>;
}

export interface WhatsAppSendParams {
  to: string;
  orderId: number;
  productName: string;
  note: string;
  hasPersonalization: boolean;
  extractedName: string | null;
}

export type WhatsAppSendResult =
  | { status: 'sent'; messageId: string }
  | { status: 'failed'; reason: string };

/**
 * المعالج الرئيسي للطلب — يُستدعى في الخلفية.
 *
 *  1. لكل عنصر في الطلب:
 *     - فحص وجود تعيين في `product_designer_map`.
 *     - تطبيق Regex لاستخراج اسم التخصيص.
 *     - كتابة سجل في `order_routing_log`.
 *     - إن وُجد تخصيص، إرسال رسالة واتساب للمصمم.
 *  2. طباعة ملخص شامل.
 */
export async function processOrderInBackground(
  payload: SallaWebhookPayload,
  deps: ProcessOrderDeps
): Promise<OrderProcessingSummary> {
  const orderId = payload.data.id;
  const items = payload.data.items;

  console.log(`[Processor] 🛒 Background processing started for Order #${orderId}`);
  console.log(`[Processor] 📋 Items count: ${items.length}`);

  // خطوة الـ Lookup الرئيسية: نحتاج `merchant_id` (UUID) من جدول merchants
  // لاستخدامه كـ FK في عمليتي `product_designer_map` و `order_routing_log`.
  // نُغلّفها في try/catch مستقل — فشلها لا يوقف المعالجة، فقط يُسجَّل
  // `merchant_id` كـ `null` في السجلات.
  //
  // ملاحظة: إن كان `deps.merchantId` محقوناً مسبقاً (مثل الاختبارات)، نستخدمه
  // مباشرة لتجنّب استعلام DB إضافي.
  let merchantId: string | null;
  if (deps.merchantId !== undefined) {
    merchantId = deps.merchantId;
    console.log(`[Processor] 🏪 Using injected merchant_id=${merchantId ?? 'null'}`);
  } else {
    merchantId = await lookupMerchantId(deps.supabase, deps.sallaMerchantId);
    if (merchantId) {
      console.log(`[Processor] 🏪 Resolved merchant_id=${merchantId} for salla_store_id=${deps.sallaMerchantId}`);
    } else {
      console.warn(
        `[Processor] ⚠️ No merchant row found for salla_store_id=${deps.sallaMerchantId} — logs will be inserted with merchant_id=null`
      );
    }
  }

  const results: OrderItemProcessingResult[] = [];

  for (const item of items) {
    const result = await processSingleItem(item, orderId, payload, deps, merchantId);
    results.push(result);
  }

  const summary: OrderProcessingSummary = {
    orderId,
    totalItems: items.length,
    processedItems: results.filter((r) => r.status === 'processed').length,
    skippedItems: results.filter((r) => r.status === 'skipped').length,
    itemsWithPersonalization: results.filter((r) => r.personalizationDetected).length,
  };

  console.log(`[Processor] 📊 Order #${orderId} summary:`, summary);
  return summary;
}

/**
 * معالجة عنصر واحد مع عزل الأخطاء — فشل عنصر واحد لا يوقف البقية.
 *
 * كل عملية قاعدة بيانات لها try/catch مستقل بحيث:
 *  - فشل الـ lookup → العنصر يُسجَّل بحالة `skipped` ويتابع.
 *  - فشل الـ insert للسجل → العنصر يُسجَّل بحالة `error` ويتابع.
 *  - أي استثناء غير متوقع → يُلتقط في الـ catch الخارجي.
 */
async function processSingleItem(
  item: SallaOrderItem,
  orderId: number,
  payload: SallaWebhookPayload,
  deps: ProcessOrderDeps,
  merchantId: string | null
): Promise<OrderItemProcessingResult> {
  const result: OrderItemProcessingResult = {
    productId: item.product.id,
    productName: item.name,
    hasNote: Boolean(item.notes),
    note: item.notes,
    personalizationDetected: false,
    extractedName: null,
    patternMatched: null,
    designerWhatsApp: null,
    whatsappStatus: 'pending',
    status: 'pending',
    error: null,
  };

  try {
    console.log(`[Processor]   📦 Item: ${item.name} (product_id=${item.product.id})`);

    // تطبيع نص الملاحظة: المنتج قد يصل بدون ملاحظة (null) — يجب ألّا يُسقط
    //   بقية المسار (lookup + WhatsApp + log). الـ Regex يعيد null عند عدم المطابقة
    //   حتى مع نص فارغ → personalizationDetected تبقى false.
    // ⚠️ الحقل في Salla API هو `notes` (جمع) — نقرأ من `item.notes` وليس `item.note`.
    const noteText = item.notes ?? '';
    if (noteText.trim().length > 0) {
      console.log(`[Processor]     📝 Note: "${noteText}"`);
    } else {
      console.log(`[Processor]     📝 Note: (empty — سيُسجَّل بصف كامل في order_routing_log)`);
    }

    // 1) استخراج الاسم من الملاحظة (Regex) — عملية CPU بحتة، لا تحتاج try/catch
    const extraction = extractNameFromNote(noteText);
    if (extraction.extractedName) {
      result.personalizationDetected = true;
      result.extractedName = extraction.extractedName;
      result.patternMatched = extraction.patternMatched;
      console.log(
        `[Processor]     ✅ Personalization detected: "${extraction.extractedName}" via "${extraction.patternMatched}"`
      );
    } else {
      console.log(`[Processor]     ❌ No personalization pattern matched`);
    }

    // 2) البحث عن تعيين المصمم في Supabase — عزل الخطأ: فشلها لا يُسقط العنصر
    const mapping = await lookupDesignerMapping(
      deps.supabase,
      merchantId,
      item.product.id
    );

    // يُعرَّفان خارج `if/else` لأن logRouting أدناه يحتاج قراءتهما لاحقاً.
    // القيم الافتراضية `null` تعني: لم يُرسل طلب HTTP إلى Meta أصلاً
    // (إما لأنه لا يوجد تعيين، أو لأن sendWhatsApp رمى استثناء قبل الـ fetch).
    let whatsappHttpStatus: number | null = null;
    let whatsappResponseJson: Record<string, unknown> | null = null;

    if (!mapping) {
      console.log(
        `[Processor]     ⚠️ No designer mapping found for product_id=${item.product.id}`
      );
      result.status = 'skipped';
      result.whatsappStatus = 'skipped';
    } else {
      result.designerWhatsApp = mapping.designer_whatsapp;
      console.log(
        `[Processor]     👤 Designer: ${mapping.designer_name} (${mapping.designer_whatsapp})`
      );

      // 3) إرسال رسالة واتساب (طالما وُجد تعيين مصمم) — عزل الخطأ
      //    الرسالة تُرسل دائماً عند وجود تعيين، بصرف النظر عن وجود اسم مستخرج.
      //    `hasPersonalization` يُمرَّر كعلامة فقط ليُعرض تنويه داخل نص الرسالة.
      //    الحالة تُحدَّد ديناميكياً: 'sent' عند النجاح، 'failed' عند الفشل.
      //    httpStatus/responseJson يُحفظان دائماً (حتى عند الفشل أو انفجار
      //    الاستثناء) — `null` فقط حين لم يصل طلب HTTP إلى Meta أصلاً.
      try {
        const whatsappResult = await deps.sendWhatsApp({
          to: mapping.designer_whatsapp,
          orderId,
          productName: item.name,
          note: noteText,
          hasPersonalization: result.personalizationDetected,
          extractedName: extraction.extractedName,
        });

        // استخراج httpStatus/responseJson من نتيجة sendWhatsApp
        // (النتيجة قد لا تحويهما لو كانت نسخة STUB قديمة — نتعامل بهدوء)
        if ('httpStatus' in whatsappResult) {
          const maybe = (whatsappResult as { httpStatus?: unknown }).httpStatus;
          whatsappHttpStatus = typeof maybe === 'number' ? maybe : null;
        }
        if ('responseJson' in whatsappResult) {
          const maybe = (whatsappResult as { responseJson?: unknown }).responseJson;
          whatsappResponseJson =
            maybe && typeof maybe === 'object'
              ? (maybe as Record<string, unknown>)
              : null;
        }

        if (whatsappResult.status === 'sent') {
          result.whatsappStatus = 'sent';
          console.log(
            `[Processor]     📲 WhatsApp sent (id=${whatsappResult.messageId}, http=${whatsappHttpStatus})`
          );
        } else {
          result.whatsappStatus = 'failed';
          console.warn(
            `[Processor]     ⚠️ WhatsApp failed (http=${whatsappHttpStatus}): ${whatsappResult.reason}`
          );
        }
      } catch (whatsappErr) {
        const message = whatsappErr instanceof Error ? whatsappErr.message : 'Unknown error';
        result.whatsappStatus = 'failed';
        console.error(`[Processor]     ⚠️ WhatsApp send threw (item continues):`, message);
      }
    }

    // 4) كتابة السجل في order_routing_log — الحالة تأتي من نتيجة الإرسال الفعلية
    const logResult = await logRouting(deps.supabase, merchantId, {
      salla_order_id: orderId,
      salla_product_id: item.product.id,
      raw_note: noteText,
      personalization_detected: result.personalizationDetected,
      extracted_name: result.extractedName,
      designer_whatsapp: result.designerWhatsApp,
      whatsapp_status: result.whatsappStatus,
      whatsapp_http_status: whatsappHttpStatus,
      whatsapp_response_json: whatsappResponseJson,
    });

    if (!logResult.ok) {
      console.error(
        `[Processor]     ❌ Routing log insert failed for product_id=${item.product.id}: ${logResult.error}`
      );
    }

    // إصلاح [2]: لا نُسند 'processed' إذا كان السجل قد وُسم بـ 'skipped' سابقاً
    // (مثلاً عند عدم وجود تعيين مصمم للمنتج — يبقى skipped صحيحاً في order_routing_log).
    if (result.status !== 'skipped') {
      result.status = 'processed';
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[Processor]     ❌ Error processing item ${item.product.id}:`, message);
    result.status = 'error';
    result.error = message;
  }

  return result;
}

interface DesignerMappingRow {
  designer_name: string;
  designer_whatsapp: string;
}

interface SupabaseMaybeError {
  code?: string;
  message?: string;
  details?: string;
}

function isMissingRowError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as SupabaseMaybeError;
  return e.code === 'PGRST116';
}

/**
 * يجلب معرّف التاجر (UUID) من جدول `merchants` باستخدام `salla_store_id`.
 * يُستدعى مرة واحدة في بداية المعالجة لتقليل عدد الاستعلامات.
 *
 * @returns UUID string عند النجاح، `null` عند عدم وجود التاجر أو فشل الاستعلام.
 */
async function lookupMerchantId(
  supabase: SupabaseClient,
  sallaStoreId: number
): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('merchants')
      .select('id')
      .eq('salla_store_id', sallaStoreId)
      .single();

    if (error) {
      if (!isMissingRowError(error)) {
        console.error(`[Processor] ⚠️ Merchant lookup error:`, error);
      }
      return null;
    }

    if (data && typeof data === 'object') {
      const row = data as { id?: unknown };
      if (typeof row.id === 'string' && row.id.length > 0) {
        return row.id;
      }
    }
    return null;
  } catch (err) {
    console.error(`[Processor] ⚠️ Merchant lookup exception:`, err);
    return null;
  }
}

/**
 * يبحث عن تعيين المصمم في `product_designer_map`.
 *
 * الفلترة تتم بـ `merchant_id` + `salla_product_id` (مفتاح مركّب) لأنّ
 * `salla_product_id` ليس فريداً عالمياً بين المتاجر.
 *
 * @returns كائن تعيين المصمم عند النجاح، `null` عند عدم وجود التعيين أو فشل DB.
 */
async function lookupDesignerMapping(
  supabase: SupabaseClient,
  merchantId: string | null,
  productId: number
): Promise<DesignerMappingRow | null> {
  if (!merchantId) {
    // لا يمكن البحث بأمان بدون merchant_id — نتجنّب التطابق الخاطئ مع متجر آخر
    return null;
  }

  try {
    const { data, error } = await supabase
      .from('product_designer_map')
      .select('designer_name,designer_whatsapp')
      .eq('merchant_id', merchantId)
      .eq('salla_product_id', productId)
      .maybeSingle();

    if (error) {
      console.error(`[Processor]     ⚠️ Designer lookup error:`, error);
      return null;
    }

    if (data && typeof data === 'object') {
      const row = data as Partial<DesignerMappingRow>;
      if (row.designer_name && row.designer_whatsapp) {
        return {
          designer_name: row.designer_name,
          designer_whatsapp: row.designer_whatsapp,
        };
      }
    }

    return null;
  } catch (err) {
    console.error(`[Processor]     ⚠️ Designer lookup exception:`, err);
    return null;
  }
}

interface LogRoutingResult {
  ok: boolean;
  error: string | null;
}

/** بنية صف الإدراج في `order_routing_log` — تطابق schema + العمودان الجديدان. */
interface LogRoutingRow {
  salla_order_id: number;
  salla_product_id: number;
  raw_note: string;
  personalization_detected: boolean;
  extracted_name: string | null;
  designer_whatsapp: string | null;
  whatsapp_status: 'pending' | 'sent' | 'failed' | 'skipped';
  /** HTTP status من Meta (`null` حين لم يصل طلب HTTP — تعيين مفقود أو استثناء). */
  whatsapp_http_status: number | null;
  /** جسم الاستجابة الكامل من Meta (`null` حين لم يصل طلب HTTP). */
  whatsapp_response_json: Record<string, unknown> | null;
}

/**
 * يُدرج سجلاً في `order_routing_log`.
 *
 * ⚠️ مغلف بـ try/catch مستقل. فشل الإدراج لا يُسقط معالجة بقية العناصر
 *    — يُعاد كائن `LogRoutingResult` ليُسجَّل في console.
 */
async function logRouting(
  supabase: SupabaseClient,
  merchantId: string | null,
  row: LogRoutingRow
): Promise<LogRoutingResult> {
  try {
    const { error } = await supabase.from('order_routing_log').insert({
      merchant_id: merchantId,
      salla_order_id: row.salla_order_id,
      salla_product_id: row.salla_product_id,
      raw_note: row.raw_note,
      personalization_detected: row.personalization_detected,
      extracted_name: row.extracted_name,
      designer_whatsapp: row.designer_whatsapp,
      whatsapp_status: row.whatsapp_status,
      whatsapp_http_status: row.whatsapp_http_status,
      whatsapp_response_json: row.whatsapp_response_json,
    });

    if (error) {
      const e = error as SupabaseMaybeError;
      const message = e.message ?? 'Unknown Supabase error';
      return { ok: false, error: message };
    }

    return { ok: true, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { ok: false, error: message };
  }
}

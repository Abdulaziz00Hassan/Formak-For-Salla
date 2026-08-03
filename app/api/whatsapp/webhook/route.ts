/**
 * WhatsApp Webhook Handler — استقبال تحديثات حالات التسليم من Meta
 *
 * نقطتان أساسيتان:
 *  - GET: التحقق الأولي (handshake) عند إعداد الـ webhook في Meta Developer Console.
 *  - POST: استقبال تحديثات حالة الرسالة (`sent` / `delivered` / `read` / `failed`).
 *
 * ⚠️ قاعدة حرجة: الراوت يجب أن يردّ بـ 200 فوراً لـ Meta. أي فشل في تحديث
 *    `order_routing_log` يُسجَّل في console لكن لا يُفشل الطلب (Meta سيُكرّر
 *    الإرسال ويعتبر عدم الرد مشكلة).
 *
 * ⚠️ أمان التوقيع: نعيد استخدام نفس نمط HMAC SHA256 + `crypto.timingSafeEqual`
 *    المُطبَّق في `app/api/salla/webhook/route.ts` — لا نكتبه من الصفر.
 *
 * الأعمدة التي يحدّثها هذا الراوت في `order_routing_log`:
 *  - `whatsapp_delivery_status` ← 'sent' | 'delivered' | 'read' | 'failed'
 *  - `whatsapp_delivery_error`  ← JSON مُختصر لأول خطأ من `errors[]` عند `failed` فقط
 *
 * يُحدَّث الصف بالـ `WHERE whatsapp_message_id = <status.id>`.
 * إن لم يُوجد صف مطابق → `console.warn` (الـ message_id قد يكون قديماً
 * أو من رسالة لم تُسجَّل — لا نُفشل الطلب).
 *
 * مرجع الوثيقة: Formak-Ai-Context-v3.md — القسم 4 (قواعد واتساب).
 */

import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';

import { createOrderRoutingSupabaseClient } from '@/app/lib/order-processor';

// ─── Constants ──────────────────────────────────────────────────────────

/** اسم الـ header الرسمي لتوقيع Meta. القيمة: `sha256=<hex>` */
const SIGNATURE_HEADER = 'x-hub-signature-256';

/** الـ status types التي تتعامل معها Meta — للتوثيق فقط. */
const KNOWN_DELIVERY_STATUSES: ReadonlySet<string> = new Set([
  'sent',
  'delivered',
  'read',
  'failed',
]);

// ─── Types — بنية payload من Meta ───────────────────────────────────────

/** عنصر خطأ داخل `statuses[].errors[]` (عند `status === 'failed'`). */
interface MetaStatusError {
  code: number;
  title: string;
  message?: string;
  error_data?: { details?: string };
}

/** عنصر حالة واحد داخل `entry[].changes[].value.statuses[]`. */
interface MetaMessageStatus {
  /** معرّف الرسالة الذي أرجعته Meta وقت الإرسال = `messages[0].id`. */
  id: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  timestamp: string;
  recipient_id: string;
  errors?: MetaStatusError[];
}

/** قيمة التغيير — تحوي `statuses` (ونحن نهتم بها فقط هنا). */
interface MetaStatusValue {
  messaging_product: 'whatsapp';
  metadata?: { phone_number_id?: string; display_phone_number?: string };
  statuses?: MetaMessageStatus[];
}

/** عنصر تغيير واحد داخل الـ entry. */
interface MetaChange {
  value: MetaStatusValue;
  field: 'messages' | string;
}

/** عنصر entry داخل الـ payload. */
interface MetaEntry {
  id: string;
  changes: MetaChange[];
}

/** بنية الـ body الكاملة من Meta (مُبسَّطة — نحتاج entry فقط). */
interface MetaWebhookBody {
  object: 'whatsapp_business_account';
  entry: MetaEntry[];
}

// ─── Type guards — التحقق الدفاعي من بنية الـ payload ──────────────────

function isMetaStatusValue(value: unknown): value is MetaStatusValue {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v['messaging_product'] !== 'whatsapp') return false;
  // statuses اختياري — قد يحوي changes أخرى (مثل messages) لا نهتم بها
  if ('statuses' in v && v['statuses'] !== undefined && !Array.isArray(v['statuses'])) {
    return false;
  }
  return true;
}

function isMetaMessageStatus(value: unknown): value is MetaMessageStatus {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['id'] === 'string' &&
    typeof v['status'] === 'string' &&
    typeof v['timestamp'] === 'string' &&
    typeof v['recipient_id'] === 'string'
  );
}

function isMetaWebhookBody(value: unknown): value is MetaWebhookBody {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v['object'] !== 'whatsapp_business_account') return false;
  if (!Array.isArray(v['entry'])) return false;
  return true;
}

// ─── Signature verification — نفس نمط سلة ─────────────────────────────

type SignatureCheckResult =
  | { ok: true }
  | { ok: false; status: 401 | 500; message: string };

/**
 * يتحقق من توقيع HMAC SHA256.
 *
 * ⚠️ Meta تُرسل التوقيع بصيغة `sha256=<hex>` (مع prefix).
 * ⚠️ `timingSafeEqual` يتطلب طولَين متساويين — نتحقق أولاً.
 */
function verifyWhatsAppSignature(
  rawBody: string,
  signatureHeader: string,
  appSecret: string
): SignatureCheckResult {
  if (!signatureHeader.startsWith('sha256=')) {
    return { ok: false, status: 401, message: 'Invalid signature format' };
  }

  const providedHex = signatureHeader.slice('sha256='.length);
  const expectedHex = crypto
    .createHmac('sha256', appSecret)
    .update(rawBody)
    .digest('hex');

  if (providedHex.length !== expectedHex.length) {
    return { ok: false, status: 401, message: 'Invalid signature' };
  }

  const isValid = crypto.timingSafeEqual(
    Buffer.from(providedHex, 'utf8'),
    Buffer.from(expectedHex, 'utf8')
  );

  if (!isValid) {
    return { ok: false, status: 401, message: 'Invalid signature' };
  }

  return { ok: true };
}

// ─── Supabase client — نفس المُنشئ المُستخدم في باقي الراوتات ────────

function buildSupabaseClient(): SupabaseClient {
  return createOrderRoutingSupabaseClient();
}

// ─── Status processing — تحديث order_routing_log ──────────────────────

/** نتيجة معالجة status واحد — للتسجيل فقط. */
interface ProcessStatusOutcome {
  messageId: string;
  updated: boolean;
  error: string | null;
}

/**
 * يحدّث صف `order_routing_log` المطابق بـ `whatsapp_message_id = <status.id>`.
 *
 * السلوك:
 *  - صف مطابق → `whatsapp_delivery_status` + (عند failed) `whatsapp_delivery_error`.
 *  - لا صف مطابق → `console.warn` (لا فشل).
 *  - فشل DB → `console.error` (لا فشل للطلب — Meta ستُكرّر).
 */
async function applyStatusUpdate(
  status: MetaMessageStatus,
  supabase: SupabaseClient
): Promise<ProcessStatusOutcome> {
  const deliveryStatus = status.status;
  // ⚠️ الحقل ليس enum صارم — نُسجّل تحذيراً إذا وصل status غير معروف
  if (!KNOWN_DELIVERY_STATUSES.has(deliveryStatus)) {
    console.warn(
      `[WhatsApp Webhook] ⚠️ Unknown delivery status received: "${deliveryStatus}" (message_id=${status.id})`
    );
  }

  // نُختصر أول خطأ فقط — أعمق من ذلك يتطلب توسيع العمود إلى JSONB كامل.
  // نُصفّر `whatsapp_delivery_error` لحالات success حتى لا يبقى خطأ قديم مربوطاً.
  const errorJson =
    deliveryStatus === 'failed' && Array.isArray(status.errors) && status.errors.length > 0
      ? JSON.stringify(status.errors[0])
      : null;

  const updatePayload: Record<string, unknown> = {
    whatsapp_delivery_status: deliveryStatus,
  };
  if (deliveryStatus === 'failed') {
    updatePayload['whatsapp_delivery_error'] = errorJson;
  } else {
    // عند النجاح (sent/delivered/read) — امسح أي خطأ قديم من محاولة سابقة
    updatePayload['whatsapp_delivery_error'] = null;
  }

  try {
    const { data, error } = await supabase
      .from('order_routing_log')
      .update(updatePayload)
      .eq('whatsapp_message_id', status.id)
      .select('id');

    if (error) {
      const message = (error as { message?: string }).message ?? 'Unknown Supabase error';
      console.error(
        `[WhatsApp Webhook] ❌ Update failed for message_id=${status.id}:`,
        message
      );
      return { messageId: status.id, updated: false, error: message };
    }

    const rowCount = Array.isArray(data) ? data.length : 0;
    if (rowCount === 0) {
      // ⚠️ الصف غير موجود — لا نُفشل الطلب (الـ message_id قد يكون من رسالة قديمة)
      console.warn(
        `[WhatsApp Webhook] ⚠️ No row matched whatsapp_message_id=${status.id} (status=${deliveryStatus}) — skipping`
      );
      return { messageId: status.id, updated: false, error: null };
    }

    console.log(
      `[WhatsApp Webhook] ✅ message_id=${status.id} → ${deliveryStatus} (rows=${rowCount})`
    );
    return { messageId: status.id, updated: true, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(
      `[WhatsApp Webhook] ❌ Update exception for message_id=${status.id}:`,
      message
    );
    return { messageId: status.id, updated: false, error: message };
  }
}

/**
 * يعالج كل الـ statuses داخل الـ payload.
 *
 * ⚠️ هذا الـ handler لا يدعم عناصر `messages` (الرسائل الواردة) — فقط `statuses`.
 *    إن وصلت Meta رسالة واردة (وليس تحديث حالة) → نتجاهلها بصمت (لا نُدخل منطق
 *    استقبال رسائل من العملاء في هذه المرحلة).
 */
async function processMetaPayload(
  body: MetaWebhookBody,
  supabase: SupabaseClient
): Promise<void> {
  for (const entry of body.entry) {
    if (!Array.isArray(entry.changes)) continue;
    for (const change of entry.changes) {
      if (!isMetaStatusValue(change.value)) {
        // قد يكون change نوعه messages (رسالة واردة) — نتجاهله
        continue;
      }
      const statuses = change.value.statuses;
      if (!Array.isArray(statuses) || statuses.length === 0) continue;

      for (const status of statuses) {
        if (!isMetaMessageStatus(status)) {
          console.warn(
            `[WhatsApp Webhook] ⚠️ Skipping malformed status entry: ${JSON.stringify(status)}`
          );
          continue;
        }
        await applyStatusUpdate(status, supabase);
      }
    }
  }
}

// ─── GET /api/whatsapp/webhook — التحقق الأولي (handshake) ─────────────

/**
 * GET handler — التحقق الأولي من Meta عند إعداد الـ webhook.
 *
 * السلوك:
 *  - إن طابقت query params شروط التحقق (mode='subscribe' + token صحيح)
 *    → يُرجع `hub.challenge` كنص خام (plain text)، تماماً كما تتوقعه Meta.
 *  - خلاف ذلك → 403.
 *
 * ⚠️ مهم: الاستجابة يجب أن تكون نصاً خاماً — `text/plain` — وليس JSON.
 *    Meta تتحقق من `response.body` نصاً تماماً.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const mode = request.nextUrl.searchParams.get('hub.mode');
  const token = request.nextUrl.searchParams.get('hub.verify_token');
  const challenge = request.nextUrl.searchParams.get('hub.challenge');

  const expectedToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;

  if (
    mode === 'subscribe' &&
    typeof token === 'string' &&
    typeof challenge === 'string' &&
    expectedToken !== undefined &&
    token === expectedToken
  ) {
    console.log('[WhatsApp Webhook] 🔐 Handshake accepted — echoing challenge');
    // ⚠️ plain text — لا JSON
    return new NextResponse(challenge, {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  console.warn(
    `[WhatsApp Webhook] ❌ Handshake rejected: mode=${mode ?? '(none)'}, token_match=${
      token === expectedToken ? 'match' : 'mismatch/missing'
    }`
  );
  return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
}

// ─── POST /api/whatsapp/webhook — استقبال تحديثات الحالة ──────────────

/**
 * POST handler — استقبال تحديثات حالة الرسالة من Meta.
 *
 * ⚠️ يجب الردّ بـ 200 خلال < 5s — Meta تُكرّر المحاولة عند عدم الرد.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  // 1) اقرأ الـ body كـ raw text (ضروري للتحقق من التوقيع)
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch (err) {
    console.error('[WhatsApp Webhook] ❌ Failed to read body:', err);
    return NextResponse.json({ error: 'Failed to read body' }, { status: 400 });
  }

  // 2) استخرج التوقيع
  const signature = request.headers.get(SIGNATURE_HEADER);
  if (!signature) {
    console.error(`[WhatsApp Webhook] ❌ Missing ${SIGNATURE_HEADER} header`);
    return NextResponse.json({ error: 'Missing signature' }, { status: 401 });
  }

  // 3) تأكد من وجود الـ secret
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (!appSecret) {
    console.error('[WhatsApp Webhook] ❌ WHATSAPP_APP_SECRET is not configured');
    return NextResponse.json(
      { error: 'Server configuration error' },
      { status: 500 }
    );
  }

  // 4) تحقق من التوقيع
  const sigCheck = verifyWhatsAppSignature(rawBody, signature, appSecret);
  if (!sigCheck.ok) {
    console.error(`[WhatsApp Webhook] ❌ ${sigCheck.message}`);
    return NextResponse.json({ error: sigCheck.message }, { status: sigCheck.status });
  }
  console.log('[WhatsApp Webhook] ✅ Signature verified');

  // 5) حلّل الـ payload كـ unknown — نتحقق منه بحارس النوع
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch (err) {
    console.error('[WhatsApp Webhook] ❌ Invalid JSON:', err);
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!isMetaWebhookBody(parsed)) {
    console.error('[WhatsApp Webhook] ❌ Payload failed type guard');
    return NextResponse.json(
      { error: 'Invalid payload structure' },
      { status: 400 }
    );
  }

  // 6) ابني Supabase client — الفشل لا يمنع الرد بـ 200 (Meta ستُكرّر)
  let supabase: SupabaseClient;
  try {
    supabase = buildSupabaseClient();
  } catch (clientErr) {
    const message = clientErr instanceof Error ? clientErr.message : 'Unknown error';
    console.error('[WhatsApp Webhook] ❌ Supabase client build failed:', message);
    // نُرجع 200 لتجنّب تكرار Meta، لكن السجلات لن تُحدَّث في هذه الدورة
    return NextResponse.json(
      { success: false, message: 'Supabase configuration error' },
      { status: 200 }
    );
  }

  // 7) نفّذ التحديثات — الفشل في عنصر واحد لا يوقف البقية
  try {
    await processMetaPayload(parsed, supabase);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[WhatsApp Webhook] ❌ processMetaPayload threw:', message);
  }

  // 8) ⚡ أرجع 200 فوراً لـ Meta
  return NextResponse.json({ success: true }, { status: 200 });
}

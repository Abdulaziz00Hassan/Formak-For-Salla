/**
 * Salla Webhook Handler — نقطة استقبال طلبات سلة
 *
 * ⚠️ قاعدة حرجة: هذا الراوت يجب أن يردّ بـ HTTP 200 خلال < 200ms.
 *    أي عمل ثقيل (Regex، Supabase، WhatsApp) يحدث في الخلفية بعد الرد.
 *
 * الأحداث المدعومة:
 *  - order.created   → معالجة الطلب (Regex + lookup + WhatsApp) في الخلفية.
 *  - app.installed   → إشعار بتثبيت التطبيق. ⚠️ لا يحوي tokens — يُسجَّل
 *                      ويُستخدم لربط merchant_id إن لزم.
 *
 * أي حدث آخر → 200 مع تجاهل آمن (لا رفض، حتى لا تُكرّر سلة الإرسال).
 *
 * مرجع: Formak-Ai-Context-v3.md + Formak-Phase7-to-Launch-v2.md (Phase 9).
 *
 * ⚠️ تصحيح مهم (اكتُشف من السجلات الحية 2026-07-26):
 *    الحدث الفعلي من سلة هو `app.installed` وليس `app.store.authorize`
 *    (الاسم في تعليمات Claude AI السابقة كان خاطئاً).
 *    بنية app.installed: {event, merchant, data:{id, app_name, ...}}
 *    لا تحوي access_token/refresh_token — التوكنات تُستبدل في OAuth callback
 *    (POST /oauth2/token) وتُخزَّن هناك.
 */

import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';

import { processOrderInBackground, createOrderRoutingSupabaseClient } from '@/app/lib/order-processor';
import { sendWhatsAppNotification } from '@/app/lib/whatsapp-cloud';
import type { SallaWebhookPayload } from '@/app/lib/salla-types';

// ─── Helpers ─────────────────────────────────────────────────────────────

/** اسم الـ header الرسمي للتوقيع في سلة. */
const SIGNATURE_HEADER = 'x-salla-signature';

/** كل الأحداث التي يعرفها هذا الـ handler — للتوثيق والـ GET status. */
const HANDLED_EVENTS: ReadonlySet<string> = new Set([
  'order.created',
  'app.installed',
]);

// ─── Types for app.installed ────────────────────────────────────────────

/**
 * بنية `data` داخل حدث app.installed.
 * ⚠️ لا يحوي access_token/refresh_token — التوكنات تأتي من OAuth callback
 *    وليس من هذا الـ webhook. هذا الحدث إشعار فقط.
 */
interface SallaInstalledData {
  /** معرّف التثبيت نفسه (ليس salla_store_id). */
  id: number;
  app_name: string;
  app_description: string;
  /** نوع التطبيق — "private" لتطبيقات Private App كهذا. */
  app_type: string;
  /** الصلاحيات الممنوحة — يجب أن تحوي offline_access. */
  app_scopes: string[];
  /** ISO 8601 timestamp. */
  installation_date: string;
  /** نوع المتجر — "live" أو "demo" أو "partner". */
  store_type: string;
}

/** بنية حدث app.installed الكامل. */
interface SallaInstalledPayload {
  event: 'app.installed';
  /** معرّف المتجر عند سلة (BigInt — يُستقبل كـ number). المفتاح الفعلي للربط. */
  merchant: number;
  created_at: string;
  data: SallaInstalledData;
}

/**
 * حارس نوع لـ app.installed — يضمن أن كل حقل موجود وبنوعه الصحيح
 * قبل أي معالجة. هذا الحدث مختلف البنية تماماً عن order.created.
 */
function isSallaInstalledPayload(value: unknown): value is SallaInstalledPayload {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v['event'] !== 'app.installed') return false;
  if (typeof v['merchant'] !== 'number') return false;
  if (typeof v['created_at'] !== 'string') return false;
  if (typeof v['data'] !== 'object' || v['data'] === null) return false;
  const d = v['data'] as Record<string, unknown>;
  return (
    typeof d['id'] === 'number' &&
    typeof d['app_name'] === 'string' &&
    typeof d['app_description'] === 'string' &&
    typeof d['app_type'] === 'string' &&
    Array.isArray(d['app_scopes']) &&
    typeof d['installation_date'] === 'string' &&
    typeof d['store_type'] === 'string'
  );
}

/** نوع مانع لـ TypeScript — عند فشل التحقق. */
type SignatureCheckResult =
  | { ok: true }
  | { ok: false; status: 401 | 500; message: string };

/** بنية مبسّطة لرسالة خطأ Supabase — للتسجيل التشخيصي فقط. */
interface SupabaseMaybeError {
  code?: string;
  message?: string;
  details?: string;
}

/**
 * يتحقق من توقيع HMAC SHA256.
 *
 * ⚠️ ملاحظة على timingSafeEqual: يجب أن يكون للطولين نفس البايتات.
 *    نتحقق من الطول أولاً ثم من المحتوى لتجنّب رمي استثناء.
 */
function verifySignature(rawBody: string, signature: string, secret: string): SignatureCheckResult {
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

  if (signature.length !== expected.length) {
    return { ok: false, status: 401, message: 'Invalid signature' };
  }

  const isValid = crypto.timingSafeEqual(
    Buffer.from(signature, 'utf8'),
    Buffer.from(expected, 'utf8')
  );

  if (!isValid) {
    return { ok: false, status: 401, message: 'Invalid signature' };
  }

  return { ok: true };
}

/**
 * ينفّذ المعالجة الخلفية ويعيد ملخصها.
 *
 * ⚠️ لماذا awaited وليس fire-and-forget:
 *    Vercel serverless يقتل الـ function بعد إرجاع الـ response مباشرة، مما
 *    يعني أي `Promise` غير مُنتظر يُتلف قبل إكمال `processOrderInBackground`.
 *    النتيجة: 200 يُرسل لسلة، ثم المعالجة تُقتل بصمت قبل أي INSERT في DB.
 *    لجعل المعالجة موثوقة، ننتظر اكتمالها ضمن الـ request lifecycle.
 *    المدة المتوقعة: < 5s (Supabase lookups + WhatsApp Meta API call).
 */
async function processOrderAndReturn(
  orderId: number,
  payload: SallaWebhookPayload,
  supabase: SupabaseClient
): Promise<void> {
  try {
    const summary = await processOrderInBackground(payload, {
      supabase,
      sallaMerchantId: payload.merchant,
      sendWhatsApp: sendWhatsAppNotification,
    });
    console.log(`[Webhook] ✅ Background processing finished for Order #${orderId}`, summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[Webhook] ❌ Background processing failed for Order #${orderId}:`, message);
  }
}

/**
 * يبني Supabase Admin Client الحقيقي.
 *
 * يستخدم Service Role Key (يتجاوز RLS) ولا يمر عبر Cookies — مناسب
 * للـ Webhook الذي يعمل في خلفية Next.js بدون جلسة مستخدم.
 *
 * ⚠️ server-side فقط. الفشل يرمي استثناء ليتم تسجيله ومعالجته.
 */
function buildSupabaseClient() {
  return createOrderRoutingSupabaseClient();
}

/**
 * يضمن وجود صف في `merchants` بـ `salla_store_id` الصحيح.
 *
 * ⚠️ ملاحظة حرجة: هذا الـupsert **لا يمس التوكنات إطلاقاً** — `{salla_store_id}`
 *    فقط كـ payload. التوكنات تُكتب من OAuth callback حصرياً (انظر
 *    app/api/auth/callback/route.ts).
 *
 * المنطق:
 *   - إن وُجد صف بنفس salla_store_id → لا تغيير (الـonConflict يحمي التوكنات).
 *   - إن لم يوجد → INSERT صف جديد بـ salla_store_id فقط.
 *
 * ⚠️ قيد schema: `merchants.access_token` و `refresh_token` و `token_expires_at`
 *    كلها NOT NULL. هذا يعني أن INSERT جديد بدون توكنات سيفشل (متعمَّد —
 *    لا نريد صفاً ناقصاً). السلوك الآمن: في هذه الحالة، الـcallback سيُحدّث
 *    الصف الموجود مسبقاً عبر UPDATE بـ WHERE access_token IS NULL.
 *
 * @returns true عند نجاح الـupsert (بما فيه no-op)، false عند الفشل.
 */
async function ensureMerchantRow(sallaStoreId: number): Promise<boolean> {
  let supabase: SupabaseClient;
  try {
    supabase = buildSupabaseClient();
  } catch (clientErr) {
    const message = clientErr instanceof Error ? clientErr.message : 'Unknown error';
    console.error(
      `[Webhook] ❌ Cannot build Supabase client for merchant upsert:`,
      message
    );
    return false;
  }

  try {
    const { error } = await supabase
      .from('merchants')
      .upsert(
        { salla_store_id: sallaStoreId },
        { onConflict: 'salla_store_id' }
      );

    if (error) {
      const e = error as SupabaseMaybeError;
      console.error(
        `[Webhook] ❌ Failed to upsert merchant row for salla_store_id=${sallaStoreId}:`,
        e.message ?? 'Unknown Supabase error'
      );
      return false;
    }

    console.log(
      `[Webhook] ✅ Merchant row ensured for salla_store_id=${sallaStoreId} (tokens untouched — owned by OAuth callback)`
    );
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(
      `[Webhook] ❌ Merchant upsert exception for salla_store_id=${sallaStoreId}:`,
      message
    );
    return false;
  }
}

// ─── app.installed handler ───────────────────────────────────────────────

/**
 * يعالج حدث app.installed من سلة.
 *
 * ⚠️ الفرق الجوهري عن التصميم الأولي (المُكتشف من السجلات الحية):
 *   - هذا الحدث لا يحوي access_token/refresh_token/expires.
 *   - التوكنات تُستبدل في OAuth callback (POST /oauth2/token) وتُخزَّن هناك.
 *
 * ⚠️ التصميم الحالي (مُحدَّث — 2026-07-27):
 *   - **نضمن وجود الصف** في `merchants` عبر upsert بـ `{salla_store_id}` فقط.
 *     هذا يضمن أن OAuth callback سيجد صفاً بـ access_token IS NULL ليُحدّثه.
 *   - **لا نلمس التوكنات إطلاقاً** — upsert مع onConflict='salla_store_id'
 *     يحمي أي توكنات موجودة مسبقاً. التوكنات تُكتب حصرياً من callback.
 *   - يُسجَّل الـ event مع merchant و installation_id و scopes.
 *
 * الترتيب النموذجي للأحداث:
 *   1) التاجر يثبّت التطبيق → `app.installed` يصل → upsert ينشئ الصف.
 *   2) التاجر يوافق على OAuth → callback يصل → UPDATE يضع التوكنات.
 *   (أو العكس — كلا المسارين مدعومان: المنطق في callback يتسامح مع
 *    غياب الصف).
 *
 * @returns NextResponse بحالة 200 دائماً (الفشل الآمن لا يُرفض — يمنع إعادة المحاولة).
 */
async function handleAppInstalled(
  rawPayload: unknown
): Promise<NextResponse> {
  if (!isSallaInstalledPayload(rawPayload)) {
    console.error('[Webhook] ❌ app.installed payload failed type guard');
    return NextResponse.json(
      { success: false, message: 'Invalid app.installed payload structure' },
      { status: 400 }
    );
  }

  const hasOfflineAccess = rawPayload.data.app_scopes.includes('offline_access');

  console.log(
    `[Webhook] 📥 app.installed received: ` +
      `merchant=${rawPayload.merchant}, ` +
      `installation_id=${rawPayload.data.id}, ` +
      `app_name="${rawPayload.data.app_name}", ` +
      `app_type=${rawPayload.data.app_type}, ` +
      `store_type=${rawPayload.data.store_type}, ` +
      `scopes_count=${rawPayload.data.app_scopes.length}, ` +
      `offline_access=${hasOfflineAccess ? 'YES' : 'NO ⚠️'}`
  );

  if (!hasOfflineAccess) {
    console.warn(
      '[Webhook] ⚠️ app.installed is missing offline_access scope — ' +
        'refresh_token will NOT be delivered in OAuth callback.'
    );
  }

  // 🆕 ضمان وجود صف merchants بـ salla_store_id الصحيح — لا نلمس التوكنات.
  //    هذا يُمكّن OAuth callback من إيجاد الصف وتحديثه بـ tokens لاحقاً.
  const upsertOk = await ensureMerchantRow(rawPayload.merchant);
  if (!upsertOk) {
    // ⚠️ نسجّل الفشل لكن لا نُرجع 4xx/5xx — سلة ستُكرّر المحاولة إلى ما لا نهاية
    //    وتُلوِّث سجلاتنا. الـcallback مستقل ويمكنه إنشاء الصف إذا لزم.
    console.warn(
      `[Webhook] ⚠️ Merchant upsert failed — OAuth callback may still complete the row`
    );
  }

  return NextResponse.json(
    {
      success: true,
      message: 'App installation acknowledged',
      merchant: rawPayload.merchant,
      installationId: rawPayload.data.id,
    },
    { status: 200 }
  );
}

// ─── POST /api/salla/webhook ──────────────────────────────────────────────

export async function POST(request: NextRequest): Promise<NextResponse> {
  // 1) اقرأ الـ body مرة واحدة كـ text (ضروري للتحقق من التوقيع)
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch (err) {
    console.error('[Webhook] ❌ Failed to read request body:', err);
    return NextResponse.json({ error: 'Failed to read body' }, { status: 400 });
  }

  // 2) استخرج التوقيع
  const signature = request.headers.get(SIGNATURE_HEADER);
  if (!signature) {
    console.error(`[Webhook] ❌ Missing ${SIGNATURE_HEADER} header`);
    return NextResponse.json({ error: 'Missing signature' }, { status: 401 });
  }

  // 3) تأكد من وجود الـ secret
  const webhookSecret = process.env.SALLA_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('[Webhook] ❌ SALLA_WEBHOOK_SECRET is not configured');
    return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
  }

  // 4) تحقق من التوقيع
  const sigCheck = verifySignature(rawBody, signature, webhookSecret);
  if (!sigCheck.ok) {
    console.error(`[Webhook] ❌ ${sigCheck.message}`);
    return NextResponse.json({ error: sigCheck.message }, { status: sigCheck.status });
  }
  console.log('[Webhook] ✅ Signature verified successfully');

  // 5) حلّل الـ payload كـ unknown — سنقرّر نوعه بعد تحديد الحدث
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch (err) {
    console.error('[Webhook] ❌ Invalid JSON payload:', err);
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // 6) ⚠️ الفحص الميداني: طباعة الـ payload كاملاً
  console.log('[Webhook] 📦 Raw payload received:');
  console.log(JSON.stringify(payload, null, 2));

  // 7) استخرج اسم الحدث — dispatch مركزي حسب نوعه
  let event: string | null = null;
  if (typeof payload === 'object' && payload !== null && 'event' in payload) {
    const maybeEvent = (payload as Record<string, unknown>).event;
    if (typeof maybeEvent === 'string') {
      event = maybeEvent;
    }
  }
  if (event === null) {
    console.error('[Webhook] ❌ Missing or invalid event field');
    return NextResponse.json({ error: 'Invalid event' }, { status: 400 });
  }
  console.log(`[Webhook] 📨 Event received: ${event}`);

  // 8) التوجيه حسب نوع الحدث
  if (event === 'app.installed') {
    return handleAppInstalled(payload);
  }

  if (event !== 'order.created') {
    // ⚠️ لا نرفض — أي حدث غير متوقع → 200 مع تجاهل آمن لمنع إعادة المحاولة.
    console.log(`[Webhook] ℹ️ Ignoring unknown event: ${event}`);
    return NextResponse.json({ success: true, message: 'Event ignored' });
  }

  // من هنا: event === 'order.created'
  const orderPayload = payload as SallaWebhookPayload;

  // 9) استخرج orderId
  const orderId = orderPayload.data?.id;
  if (typeof orderId !== 'number') {
    console.error('[Webhook] ❌ Missing order id in payload.data.id');
    return NextResponse.json({ error: 'Missing order id' }, { status: 400 });
  }

  // 10) جهّز Supabase client — فشل الإنشاء لا يمنع الرد بـ 200
  let supabase: SupabaseClient;
  try {
    supabase = buildSupabaseClient();
  } catch (clientErr) {
    const message = clientErr instanceof Error ? clientErr.message : 'Unknown error';
    console.error(`[Webhook] ❌ Failed to build Supabase client:`, message);
    return NextResponse.json(
      {
        success: false,
        orderId,
        message: 'Supabase configuration error — check env vars',
      },
      { status: 200 } // 200 لأن الـ webhook استُقبل — فشل المعالجة لن يُعاد للمحاولة
    );
  }

  // 11) انفّذ المعالجة (awaited — Vercel يقتل الـ background promises بعد 200)
  //     في حالة الفشل، نسجّل الخطأ لكن لا نُرجع 4xx/5xx — سلة ستُكرّر وإلّا
  //     تُلوِّث سجلاتنا. الفشل الفعلي يُسجَّل في Vercel Logs + order_routing_log.
  await processOrderAndReturn(orderId, orderPayload, supabase);

  // 12) ⚡ أرجع 200 بعد اكتمال المعالجة
  return NextResponse.json(
    {
      success: true,
      orderId,
      message: 'Order processed',
    },
    { status: 200 }
  );
}

// ─── GET /api/salla/webhook — للتحقق وفحص الحالة ────────────────────────

export async function GET(request: NextRequest): Promise<NextResponse> {
  const challenge = request.nextUrl.searchParams.get('challenge');
  if (challenge) {
    console.log('[Webhook] 🔐 Challenge received — echoing back');
    return new NextResponse(challenge, { status: 200 });
  }

  return NextResponse.json({
    message: 'Salla Webhook Handler is active',
    timestamp: new Date().toISOString(),
    handledEvents: Array.from(HANDLED_EVENTS),
    docs: 'POST order.created or app.installed to this endpoint',
  });
}

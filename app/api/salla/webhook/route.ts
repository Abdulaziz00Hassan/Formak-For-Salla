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
 * غلاف آمن لتشغيل الـ background processor مع تسجيل الأخطاء.
 * يُرجع فوراً — لا حاجة لانتظار.
 */
function runInBackground(orderId: number, payload: SallaWebhookPayload, supabase: SupabaseClient): void {
  // لا await — هذا هو جوهر التصميم غير الحاضن.
  // .catch() ضروري لمنع unhandled promise rejection.
  processOrderInBackground(payload, {
    supabase,
    sallaMerchantId: payload.merchant,
    // استدعاء WhatsApp Cloud API الحقيقي من Meta.
    // (نمرّر الدالة كمرجع — تستوفي نفس التوقيع المطلوب من order-processor)
    sendWhatsApp: sendWhatsAppNotification,
  })
    .then((summary) => {
      console.log(`[Webhook] ✅ Background processing finished for Order #${orderId}`, summary);
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[Webhook] ❌ Background processing failed for Order #${orderId}:`, message);
    });
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

// ─── app.installed handler ───────────────────────────────────────────────

/**
 * يعالج حدث app.installed من سلة.
 *
 * ⚠️ الفرق الجوهري عن التصميم الأولي (المُكتشف من السجلات الحية):
 *   - هذا الحدث لا يحوي access_token/refresh_token/expires.
 *   - التوكنات تُستبدل في OAuth callback (POST /oauth2/token) وتُخزَّن هناك.
 *   - هذا الـ webhook إشعار فقط — يُسجَّل ويُستخدم لربط merchant_id
 *     إن لزم (مثلاً لتأكيد أن التاجر فعّل التطبيق فعلاً).
 *
 * ⚠️ التصميم الحالي:
 *   - نُسجّل الـ event مع merchant و installation_id و scopes.
 *   - لا نكتب في merchants لأن التوكنات موجودة بالفعل في الـ callback.
 *   - إن كانت callback قد خزّنت صفاً بـ salla_store_id=placeholder، يمكن
 *     لاحقاً بناء منطق UPDATE هنا لربط merchant_id الفعلي.
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

  // ⚠️ ملاحظة على التصميم: هذا الحدث إشعار فقط. التوكنات في OAuth callback.
  //    لا نكتب في merchants هنا لأن:
  //    (أ) لا نملك access_token/refresh_token في هذا الـ payload.
  //    (ب) الـ callback خزّنها بالفعل (في المسار السعيد).
  //    (ج) التكرار هنا سيُنشئ صفوفاً ناقصة (merchant بدون tokens).

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

  // 11) أطلق المعالجة في الخلفية (fire-and-forget) — لا await
  runInBackground(orderId, orderPayload, supabase);

  // 12) ⚡ أرجع 200 فوراً — قبل أي عمل ثقيل
  return NextResponse.json(
    {
      success: true,
      orderId,
      message: 'Order received, processing in background',
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

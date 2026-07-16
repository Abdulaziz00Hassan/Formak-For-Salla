/**
 * Salla Webhook Handler — نقطة استقبال طلبات سلة
 *
 * ⚠️ قاعدة حرجة: هذا الراوت يجب أن يردّ بـ HTTP 200 خلال < 200ms.
 *    أي عمل ثقيل (Regex، Supabase، WhatsApp) يحدث في الخلفية بعد الرد.
 *
 * المسار:
 *  1) قراءة جسم الطلب كـ text (للتحقق من التوقيع).
 *  2) التحقق من `X-Salla-Signature` عبر `crypto.timingSafeEqual`.
 *  3) طباعة الـ payload الخام للفحص الميداني.
 *  4) إرجاع `200 { success: true }` فوراً.
 *  5) تشغيل `processOrderInBackground` كـ fire-and-forget (لا await).
 *
 * مرجع الوثيقة: Formak-Ai-Context-v2.md — القسم 4 (آلية العمل) + القسم 7.
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

/** الأحداث التي نعالجها. أي حدث آخر نتجاهله بهدوء بعد إرجاع 200. */
const HANDLED_EVENTS: ReadonlySet<string> = new Set(['order.created']);

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

  // 5) حلّل الـ payload واطبعه للفحص الميداني
  let payload: SallaWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as SallaWebhookPayload;
  } catch (err) {
    console.error('[Webhook] ❌ Invalid JSON payload:', err);
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // 6) ⚠️ الفحص الميداني: طباعة الـ payload كاملاً
  console.log('[Webhook] 📦 Raw payload received:');
  console.log(JSON.stringify(payload, null, 2));

  // 7) تجاهل الأحداث غير المطلوبة
  if (!HANDLED_EVENTS.has(payload.event)) {
    console.log(`[Webhook] ℹ️ Ignoring event: ${payload.event}`);
    return NextResponse.json({ success: true, message: 'Event ignored' });
  }

  // 8) جهّز المعالجة الخلفية
  const orderId = payload.data?.id;
  if (typeof orderId !== 'number') {
    console.error('[Webhook] ❌ Missing order id in payload.data.id');
    return NextResponse.json({ error: 'Missing order id' }, { status: 400 });
  }

  // 9) أطلق المعالجة في الخلفية (fire-and-forget) — لا await
  //    إذا فشل إنشاء العميل (غياب المتغيرات البيئية)، نُسجّل الخطأ ونُرجع 200.
  //    webhook handler يجب ألا يفشل أبداً — فشل الـ DB يجب ألّا يمنع سلة من
  //    رؤية الاستجابة. السجلات ستُسجَّل في console للمراجعة.
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

  runInBackground(orderId, payload, supabase);

  // 10) ⚡ أرجع 200 فوراً — قبل أي عمل ثقيل
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
    docs: 'POST order.created to this endpoint',
  });
}

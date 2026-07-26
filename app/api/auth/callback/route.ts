/**
 * Salla OAuth — Step 2: Callback Handler (Token Exchange + Merchant Storage)
 *
 * نقطة الرجوع من سلة بعد موافقة/رفض التاجر. GET فقط.
 *
 * يُتوقَّع من سلة:
 *   ?code=...    (نجح التفويض)
 *   ?scope=...   (الصلاحيات الممنوحة — سنتحقق تحويها offline_access)
 *   ?state=...   (يجب أن يطابق ما خزّنّا في cookie)
 *   أو:
 *   ?error=...   (التاجر رفض أو خطأ من سلة)
 *
 * المسار:
 *  1) لو ?error موجود → redirect إلى /auth/error (دون كشف تفاصيل حساسة).
 *  2) تحقق state (CSRF) — منطق شرطي كما هو.
 *  3) تحقق وجود code. غيابه → رفض (نفس المسار).
 *  4) POST إلى https://accounts.salla.sa/oauth2/token لـ تبادل code
 *     بـ access_token/refresh_token (server-side فقط — client_secret
 *     لا يخرج من الخادم أبداً).
 *  5) ⚠️ Custom Mode: رد تبادل التوكن قد لا يحوي merchant.
 *      - سلة ترسل merchant عبر حدث webhook منفصل (app.installed).
 *      - هذا الملف يستخرج merchant من حقول متعددة (merchant/id/store_id).
 *      - إن وُجد: upsert في merchants بـ onConflict: salla_store_id.
 *      - إن لم يوجد: redirect بـ ?salla_connected=awaiting_merchant.
 *
 * ⚠️ لا آلية تجديد تلقائي هنا — تُبنى في مرحلة منفصلة كما في Phase 7.
 * ⚠️ scope في رد سلة يجب أن يحوي offline_access. إن غاب → نُسجّل خطأ واضحاً
 *    (refresh_token سيكون null وعمود merchants.refresh_token NOT NULL).
 *
 * مرجع: Formak-Ai-Context-v3.md + Formak-Phase7-to-Launch-v2.md (Phase 9).
 */

import { NextRequest, NextResponse } from 'next/server';

import { createOrderRoutingSupabaseClient } from '@/app/lib/order-processor';

const STATE_COOKIE_NAME = 'salla_oauth_state';
const SALLA_TOKEN_ENDPOINT = 'https://accounts.salla.sa/oauth2/token';

const SUCCESS_PATH = '/dashboard/mappings';
const ERROR_PATH = '/auth/error';

// ─── Types ───────────────────────────────────────────────────────────────

interface SallaTokenSuccess {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  // ⚠️ ملاحظة: رد Custom Mode OAuth لتبادل التوكن لا يحوي merchant.
  // سلة ترسل merchant_id + التوكنات عبر حدث webhook منفصل
  // (app.store.authorize) — الكتابة في DB تتم في app/api/salla/webhook/route.ts.
}

interface SallaTokenErrorPayload {
  error: string;
  error_description?: string;
}

function isSallaTokenSuccess(value: unknown): value is SallaTokenSuccess {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['access_token'] === 'string' &&
    typeof v['refresh_token'] === 'string' &&
    typeof v['scope'] === 'string'
    // التحقق من merchant محذوف — لا يصل هنا في Custom Mode.
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function getBaseOrigin(request: NextRequest): string {
  const callbackUrl = process.env.SALLA_CALLBACK_URL;
  if (callbackUrl) {
    try {
      return new URL(callbackUrl).origin;
    } catch {
      // fall through to request origin
    }
  }
  return new URL(request.url).origin;
}

function readRequiredEnv(): {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
} {
  const clientId = process.env.SALLA_CLIENT_ID;
  const clientSecret = process.env.SALLA_CLIENT_SECRET;
  const callbackUrl = process.env.SALLA_CALLBACK_URL;
  if (!clientId || !clientSecret || !callbackUrl) {
    throw new Error(
      'Missing SALLA_CLIENT_ID, SALLA_CLIENT_SECRET, or SALLA_CALLBACK_URL'
    );
  }
  return { clientId, clientSecret, callbackUrl };
}

async function exchangeCodeForToken(code: string): Promise<SallaTokenSuccess> {
  const { clientId, clientSecret, callbackUrl } = readRequiredEnv();

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: callbackUrl,
  });

  const res = await fetch(SALLA_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    throw new Error(`Token endpoint returned non-JSON (HTTP ${res.status})`);
  }

  if (!res.ok || !isSallaTokenSuccess(data)) {
    // 🔍 تشخيص مؤقت: اطبع الـstatus والـbody كاملاً لمعرفة ما ترسله سلة.
    console.error('[Callback] ❌ Token exchange failed — diagnostic dump:');
    console.error(`[Callback]    res.status = ${res.status}`);
    console.error(`[Callback]    data       = ${JSON.stringify(data)}`);
    const err = data as Partial<SallaTokenErrorPayload> | null;
    const reason = err?.error ?? `http_${res.status}`;
    const desc = err?.error_description ? `: ${err.error_description}` : '';
    throw new Error(`token_exchange_failed (${reason})${desc}`);
  }

  if (!data.scope.split(/\s+/).includes('offline_access')) {
    throw new Error(
      'missing_offline_access_scope — refresh_token لن يُسلَّم، أعد التفويض بـ scope=offline_access'
    );
  }

  // 🔍 تشخيص (مفتاح لفهم سبب الخطأ): اطبع مفاتيح الردّ لنعرف هل يحوي merchant.
  // ⚠️ لا نطبع القيم — مفاتيح فقط (آمن، لا يكشف أسرار).
  console.log(
    `[Callback] ✅ Token exchange succeeded. Response keys: ${Object.keys(data).join(', ')}`
  );

  return data;
}

function computeExpiresAt(expiresIn: number | undefined): Date {
  if (typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0) {
    return new Date(Date.now() + expiresIn * 1000);
  }
  // افتراضي: 14 يوم (مدة access_token الرسمية في OAuth سلة).
  return new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
}

function parseMerchantId(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function buildRedirect(
  baseOrigin: string,
  path: string,
  query: Record<string, string>
): NextResponse {
  const url = new URL(path, baseOrigin);
  for (const [k, v] of Object.entries(query)) {
    url.searchParams.set(k, v);
  }
  const response = NextResponse.redirect(url, { status: 302 });
  response.cookies.delete(STATE_COOKIE_NAME);
  return response;
}

// ─── Handler ─────────────────────────────────────────────────────────────

export async function GET(request: NextRequest): Promise<NextResponse> {
  const searchParams = request.nextUrl.searchParams;
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const sallaError = searchParams.get('error');

  const baseOrigin = getBaseOrigin(request);

  // ── (1) رفض المستخدم / خطأ صريح من سلة ────────────────────────────
  if (sallaError) {
    return buildRedirect(baseOrigin, ERROR_PATH, { error: sallaError });
  }

  // ── (2) التحقق من state (CSRF) — منطق شرطي ──────────────────────
  // حالتان:
  //  (أ) الـcookie موجودة → التاجر مرّ عبر /api/salla/oauth/start → نفّذ
  //      تحقق صارم. أي اختلاف = CSRF attack محتمل → ارفض.
  //  (ب) الـcookie غائبة → التاجر بدأ التثبيت مباشرة من رابط سلة (install
  //      link) دون المرور بـ start route. في هذه الحالة لا يوجد state للمقارنة
  //      به — تجاوز الفحص والاستمرار (الحماية الإضافية: code يُستبدل مرة
  //      واحدة فقط، فلو سُرق الرابط بعد الاستخدام يصبح عديم النفع).
  const cookieState = request.cookies.get(STATE_COOKIE_NAME)?.value;
  if (cookieState !== undefined) {
    if (!state || state !== cookieState) {
      return buildRedirect(baseOrigin, ERROR_PATH, {
        error: 'state_mismatch',
      });
    }
  }

  // ── (3) التحقق من code ─────────────────────────────────────────────
  if (!code) {
    return buildRedirect(baseOrigin, ERROR_PATH, {
      error: 'missing_code',
    });
  }

  // ── (4) المسار السعيد: تبادل التوكن + تخزين + تحويل ───────────────
  // ⚠️ Custom Mode: رد تبادل التوكن قد لا يحوي merchant (نادر في سلة).
  //    سلة ترسل merchant عبر حدث webhook منفصل (app.installed).
  //    هذا الملف يستخرج merchant من حقول متعددة (merchant / id / store_id)
  //    — إن لم يوجد، نُسجّل تحذيراً ونحوّل التاجر لـ dashboard
  //    بحالة awaiting_merchant ليكمل الربط يدوياً.
  try {
    const tokenData = await exchangeCodeForToken(code);

    // نحاول استخراج salla_store_id من حقول متعددة في الرد.
    // ⚠️ التحويل يمر بـ unknown أولاً لأن SallaTokenSuccess interface لا يحوي
    //    index signature، فلا يمكن التحويل المباشر إلى Record<string, unknown>.
    const tokenDataRecord = tokenData as unknown as Record<string, unknown>;
    const rawMerchant =
      tokenDataRecord['merchant'] ??
      tokenDataRecord['id'] ??
      tokenDataRecord['store_id'];
    const sallaStoreId = parseMerchantId(rawMerchant);

    if (sallaStoreId === null) {
      // ⚠️ لا merchant في رد التوكن — اعرض التحذير وحوّل لـ dashboard.
      // التاجر سيحتاج إكمال الربط يدوياً (مثلاً عبر app.installed webhook).
      console.warn(
        '[Callback] ⚠️ Token response has no merchant field. Keys seen: ' +
          Object.keys(tokenData).join(', ')
      );
      return buildRedirect(baseOrigin, SUCCESS_PATH, {
        salla_connected: 'awaiting_merchant',
      });
    }

    const expiresAt = computeExpiresAt(tokenData.expires_in);
    const supabase = createOrderRoutingSupabaseClient();

    const { error: dbError } = await supabase.from('merchants').upsert(
      {
        salla_store_id: sallaStoreId,
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        token_expires_at: expiresAt.toISOString(),
      },
      { onConflict: 'salla_store_id' }
    );

    if (dbError) {
      console.error(
        `[Callback] ❌ DB upsert failed for salla_store_id=${sallaStoreId}:`,
        dbError
      );
      return buildRedirect(baseOrigin, SUCCESS_PATH, {
        salla_connected: 'db_error',
        salla_store_id: String(sallaStoreId),
      });
    }

    console.log(
      `[Callback] ✅ Merchant upserted: salla_store_id=${sallaStoreId}`
    );
    return buildRedirect(baseOrigin, SUCCESS_PATH, { salla_connected: '1' });
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown_error';
    console.error('[Callback] ❌ Token exchange or storage failed:', reason);
    return buildRedirect(baseOrigin, ERROR_PATH, { error: reason });
  }
}

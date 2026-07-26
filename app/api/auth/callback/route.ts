/**
 * Salla OAuth — Step 2: Callback Handler (Token Exchange Only)
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
 *  5) ⚠️ في Custom Mode: رد تبادل التوكن لا يحوي merchant.
 *      سلة ترسل merchant + tokens عبر حدث webhook منفصل
 *      (app.store.authorize) على نفس رابط الـwebhook.
 *      → هذا الملف لا يكتب في قاعدة البيانات. يوجّه التاجر فقط لـ
 *        /dashboard/mappings?salla_connected=pending (سيتحوّل إلى "1"
 *        بعد وصول webhook authorize).
 *
 * ⚠️ لا آلية تجديد تلقائي هنا — تُبنى في مرحلة منفصلة كما في Phase 7.
 * ⚠️ scope في رد سلة يجب أن يحوي offline_access. إن غاب → نُسجّل خطأ واضحاً
 *    (refresh_token سيكون null وعمود merchants.refresh_token NOT NULL).
 *
 * مرجع: Formak-Ai-Context-v3.md + Formak-Phase7-to-Launch-v2.md (Phase 9).
 */

import { NextRequest, NextResponse } from 'next/server';

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

  return data;
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

  // ── (4) المسار السعيد: تبادل التوكن + تحويل فقط ─────────────────
  // ⚠️ Custom Mode: رد تبادل التوكن لا يحوي merchant.
  //    سلة ترسل merchant + tokens لاحقاً عبر webhook app.store.authorize
  //    (المعالَج في app/api/salla/webhook/route.ts).
  //    هذا الملف لا يكتب في قاعدة البيانات — يوجّه التاجر فقط.
  //    ?salla_connected=pending (وليس =1) → يتغير إلى "1" بعد نجاح webhook authorize.
  try {
    await exchangeCodeForToken(code);
    return buildRedirect(baseOrigin, SUCCESS_PATH, { salla_connected: 'pending' });
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown_error';
    return buildRedirect(baseOrigin, ERROR_PATH, { error: reason });
  }
}

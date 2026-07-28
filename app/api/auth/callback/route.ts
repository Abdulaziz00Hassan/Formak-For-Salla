/**
 * Salla OAuth — Step 2: Callback Handler (Token Exchange + Diagnostic User Info)
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
 *  5) ⚠️ Custom Mode OAuth في سلة لا يحوي `merchant` في رد تبادل التوكن.
 *      نقوم باستدعاء تشخيصي (best-effort) لـ user info API:
 *      `GET https://accounts.salla.sa/oauth2/user/info` بـ access_token.
 *      هذا الاستدعاء **مستقل تماماً** عن الـcallback — أي فشل (4xx/5xx/timeout)
 *      يُسجَّل بـ console.error فقط ولا يوقف التوجيه.
 *  6) دائماً redirect إلى ?salla_connected=pending.
 *
 * ⚠️ الكتابة الفعلية في جدول merchants تتم في webhook app.store.authorize
 *    (معالَج في app/api/salla/webhook/route.ts) — **مستقل تماماً** عن هذا الملف.
 *    هذا الملف لا يكتب في قاعدة البيانات. دوره: تبادل التوكن + diagnostic + redirect.
 *
 * ⚠️ لا آلية تجديد تلقائي هنا — تُبنى في مرحلة منفصلة كما في Phase 7.
 * ⚠️ scope في رد سلة يجب أن يحوي offline_access. إن غاب → نُسجّل خطأ واضحاً
 *    (refresh_token سيكون null وعمود merchants.refresh_token NOT NULL).
 *
 * مرجع: Formak-Ai-Context-v3.md + Formak-Phase7-to-Launch-v2.md (Phase 9).
 */

import { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
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
  // الكتابة في DB تتم في webhook app.store.authorize
  // (معالَج في app/api/salla/webhook/route.ts) — مستقل تماماً.
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

function parseMerchantId(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * يجلب معلومات التاجر من Salla User Info API باستخدام access_token.
 *
 * ⚠️ السبب في وجود هذه الدالة (مُكتشف من السجلات الحية 2026-07-27):
 *    Custom Mode OAuth في سلة **لا يُرجع `merchant` في رد تبادل التوكن**.
 *    المفاتيح الفعلية: `access_token, expires_in, refresh_token, scope, token_type`.
 *    للحصول على `salla_store_id` يجب استدعاءٌ ثانٍ.
 *
 * المنهجية:
 *   GET https://accounts.salla.sa/oauth2/user/info
 *   Authorization: Bearer {access_token}
 *   (الـendpoint الصحيح لـ OAuth UserInfo في سلة — مختلف عن /admin/v2/me)
 *
 * ⚠️ timeout 5s عبر AbortController — لا نريد أن نُعطّل الـ OAuth إن كانت
 *    واجهة Salla بطيئة مؤقتاً. عند الفشل → null → await_merchant.
 *
 * 🔍 التشخيص (مفتاح للفهم): نطبع الـstatus والـbody كاملاً قبل أي محاولة
 *    قراءة حقل معيّن. هذا مماثل لما فعلناه في exchangeCodeForToken — لمعرفة
 *    البنية الفعلية للرد.
 *
 * @param accessToken - access_token الناتج من exchangeCodeForToken
 * @returns salla_store_id كرقم، أو null عند أي فشل (للـ graceful degradation)
 */
async function fetchSallaMerchantInfo(accessToken: string): Promise<number | null> {
  const controller = new AbortController();
  const timeoutMs = 5000;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch('https://accounts.salla.sa/oauth2/user/info', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });

    // 🔍 تشخيص (مطابق لما فعلناه بـ exchangeCodeForToken): اطبع status و body
    //    قبل أي محاولة قراءة حقل معيّن. لا نطبع القيم الكاملة (لا access_token
    //    في الرد — فقط معلومات المستخدم).
    let data: unknown = null;
    try {
      data = await res.json();
    } catch (err) {
      console.error(
        '[Callback][UserInfo] ❌ Failed to parse JSON:',
        err instanceof Error ? err.message : 'Unknown'
      );
    }

    console.error('[Callback][UserInfo] status=' + res.status);
    console.error('[Callback][UserInfo] body=' + JSON.stringify(data));

    if (!res.ok) {
      console.error(
        `[Callback][UserInfo] ❌ HTTP ${res.status} — non-blocking, will be set by webhook`
      );
      return null;
    }

    // 🔍 تشخيص بعد نجاح res.ok: اطبع الرد الخام كاملاً قبل أي محاولة قراءة حقل.
    //    البنية المفترضة {status, success, data:{id}} **تخمين غير مؤكَّد** —
    //    لا تفترض بنية جديدة، اطبع ما يصل فعلياً.
    console.error(
      '[Callback][UserInfo] ✅ res.ok — full raw body: ' + JSON.stringify(data)
    );

    // Salla تُلفّ الرد في { status, success, data: { id, name, email, ... } }
    // لكن البنية الفعلية قد تختلف — التشخيص أعلاه سيكشفها.
    if (typeof data !== 'object' || data === null) return null;
    const outer = data as Record<string, unknown>;
    const inner = outer['data'];
    if (typeof inner !== 'object' || inner === null) return null;
    const id = (inner as Record<string, unknown>)['id'];
    if (typeof id === 'number' && Number.isFinite(id)) return id;
    if (typeof id === 'string') {
      const parsed = parseInt(id, 10);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      console.error(
        `[Callback][UserInfo] ❌ Timed out after ${timeoutMs}ms — non-blocking`
      );
    } else {
      console.error(
        '[Callback][UserInfo] ❌ Unexpected error:',
        err instanceof Error ? err.message : 'Unknown error'
      );
    }
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * يربط التوكنات المستلَمة من OAuth بصف `merchants` المعلَّق (placeholder).
 *
 * ⚠️ خلفية التصميم (مُحدَّثة 2026-07-27 — الجولة 6):
 *    - `app.installed` webhook يصل أولاً → يُنشئ صفاً في `merchants` عبر
 *      upsert بـ `{salla_store_id}` فقط (الحقول NOT NULL الأخرى — tokens —
 *      تُملأ لاحقاً من هنا).
 *    - OAuth callback يصل ثانياً → يجد الصف المعلَّق عبر
 *      `WHERE access_token IS NULL ORDER BY created_at DESC LIMIT 1`
 *      ويُحدّثه بالتوكنات.
 *    - الترتيب العكسي (callback قبل webhook) مدعوم أيضاً: SELECT سيُعيد
 *      صفر صفوف → console.error فقط، لا انكسار.
 *
 * ⚠️ تفسير `WHERE access_token IS NULL`:
 *    - يضمن أننا نُحدّث **الصف المعلَّق الأحدث فقط** (الذي أنشأه webhook
 *      ولم تُحدَّث توكناته بعد).
 *    - إن كان للتاجر صف قديم مكتمل (tokens موجودة)، لن نلمسه — نتجنّب
 *      استبدال توكنات صالحة بمجموعة جديدة قد تكون مُلغاة.
 *    - هذا أيضاً يمنع تطابقاً خاطئاً مع صفوف متاجر أخرى.
 *
 * @returns true عند نجاح الـUPDATE (أو عدم وجود صف — قرار ناعم).
 */
async function linkTokensToPendingMerchant(
  accessToken: string,
  refreshToken: string,
  expiresIn: number
): Promise<boolean> {
  let supabase: SupabaseClient;
  try {
    supabase = createOrderRoutingSupabaseClient();
  } catch (clientErr) {
    const message = clientErr instanceof Error ? clientErr.message : 'Unknown error';
    console.error(
      '[Callback] ❌ Cannot build Supabase client for token linking:',
      message
    );
    return false;
  }

  // 1) ابحث عن صف معلَّق — حتى 5 محاولات بفاصل 700ms.
  //    السبب: app.installed webhook قد يصل بعد callback (سباق مع OAuth).
  //    الانتظار القصير يعطي webhook وقتاً للوصول بدون تأخير التحويل تأخيراً محسوساً.
  //
  // ⚠️ منطق الإيقاف:
  //   - خطأ/استثناء في SELECT → return false فوراً (لا فائدة من إعادة المحاولة).
  //   - صف وُجد → break + UPDATE.
  //   - صفر صفوف متتالية 5 مرات → console.error ناعم + return false (الـcallback
  //     يكمل بـ salla_connected=pending كما هو مصمَّم).
  let pendingRowId: string | null = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const { data, error } = await supabase
        .from('merchants')
        .select('id')
        .is('access_token', null)
        .order('created_at', { ascending: false })
        .limit(1);

      if (error) {
        const e = error as { message?: string };
        console.error(
          `[Callback] ❌ Failed to search for pending merchant row (attempt ${attempt}/5):`,
          e.message ?? 'Unknown Supabase error'
        );
        return false;
      }

      if (Array.isArray(data) && data.length > 0) {
        const first = data[0] as { id?: unknown };
        if (typeof first.id === 'string' && first.id.length > 0) {
          pendingRowId = first.id;
          break; // وُجد الصف — توقف عن الحلقة وامضِ إلى UPDATE
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error(
        `[Callback] ❌ Pending merchant lookup exception (attempt ${attempt}/5):`,
        message
      );
      return false;
    }

    // لم نجد صفاً في هذه المحاولة — انتظر 700ms قبل المحاولة التالية.
    // ⚠️ لا انتظار بعد المحاولة الأخيرة (تحسين بسيط لتجنّب 700ms هدر).
    if (attempt < 5) {
      await new Promise<void>((resolve) => setTimeout(resolve, 700));
    }
  }

  if (pendingRowId === null) {
    console.error(
      '[Callback] No pending merchant row after 5 attempts (~3.5s) — webhook may have failed or Salla delivered it very late'
    );
    return false;
  }

  // 2) حساب token_expires_at — expires_in بالثواني (OAuth2 spec).
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

  // 3) UPDATE الصف المعلَّق بالتوكنات.
  try {
    const { error } = await supabase
      .from('merchants')
      .update({
        access_token: accessToken,
        refresh_token: refreshToken,
        token_expires_at: expiresAt,
      })
      .eq('id', pendingRowId);

    if (error) {
      const e = error as { message?: string };
      console.error(
        `[Callback] ❌ Failed to update pending merchant ${pendingRowId}:`,
        e.message ?? 'Unknown Supabase error'
      );
      return false;
    }

    console.log(
      `[Callback] ✅ Pending merchant ${pendingRowId} updated with tokens (expires_at=${expiresAt})`
    );
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(
      `[Callback] ❌ Merchant update exception for ${pendingRowId}:`,
      message
    );
    return false;
  }
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

  // ── (4) المسار السعيد: تبادل التوكن + ربط بصف معلَّق + تشخيص + تحويل ──
  // ⚠️ ملاحظة حرجة (مُحدَّثة — الجولة 6):
  //    1) Custom Mode OAuth في سلة لا يحوي `merchant` في رد التوكن
  //       (مُثبت 2026-07-27 — المفاتيح الفعلية:
  //        access_token, expires_in, refresh_token, scope, token_type).
  //    2) الترتيب النموذجي للأحداث:
  //         (أ) `app.installed` webhook يصل أولاً → يُنشئ صف placeholder
  //             في `merchants` بـ `{salla_store_id}` فقط (توكنات NULL).
  //         (ب) OAuth callback يصل ثانياً → يجد الصف المعلَّق ويملأ التوكنات.
  //       (الترتيب العكسي مدعوم أيضاً — console.error ناعم، لا انكسار).
  //    3) `fetchSallaMerchantInfo` يبقى **تشخيصياً بحتاً** (لا يُستخدم لربط
  //       الـDB). مستقبلاً عند تأكيد بنية الرد من السجلات قد نستخدمه لربط
  //       `salla_store_id` بدلاً من الاعتماد على webhook فقط.
  //    4) `salla_connected`:
  //         - `'1'`   عند نجاح UPDATE للتوكنات (التاجر جاهز لاستقبال الطلبات).
  //         - `'pending'` عند عدم وجود صف معلَّق أو فشل التحديث (webhook لم يصل بعد).
  try {
    const tokenData = await exchangeCodeForToken(code);

    // 🆕 ربط التوكنات بصف merchants المعلَّق — SELECT WHERE access_token IS NULL
    //    ثم UPDATE بالـid. فشل المنطق كله (SELECT أو UPDATE) → salla_connected=pending.
    let tokensLinked = false;
    try {
      tokensLinked = await linkTokensToPendingMerchant(
        tokenData.access_token,
        tokenData.refresh_token,
        tokenData.expires_in
      );
    } catch (linkErr) {
      // لن يحدث — linkTokensToPendingMerchant تلتقط كل الأخطاء.
      console.error(
        '[Callback] ❌ Unexpected error in linkTokensToPendingMerchant (non-blocking):',
        linkErr instanceof Error ? linkErr.message : 'Unknown'
      );
    }

    // 🆕 استدعاء user info — best-effort، لفّه بـ try/catch مستقل
    //    (دفاع مزدوج — الدالة نفسها فيها try/catch خاص بها أيضاً).
    try {
      const sallaStoreId = await fetchSallaMerchantInfo(tokenData.access_token);
      if (sallaStoreId !== null) {
        console.log(
          `[Callback][UserInfo] ✅ salla_store_id=${sallaStoreId} (diagnostic only — actual write via webhook)`
        );
      } else {
        console.log(
          '[Callback][UserInfo] ℹ️ No salla_store_id extracted (will be set by webhook)'
        );
      }
    } catch (userInfoErr) {
      // لن يحدث — fetchSallaMerchantInfo يلتقط كل أخطاء الشبكة/JSON
      // لكن هذا دفاع في العمق.
      console.error(
        '[Callback][UserInfo] ❌ Unexpected error (non-blocking):',
        userInfoErr instanceof Error ? userInfoErr.message : 'Unknown'
      );
    }

    // 🆕 قرار التحويل النهائي: '1' عند نجاح الربط، 'pending' عند الفشل/الغياب.
    const finalStatus: '1' | 'pending' = tokensLinked ? '1' : 'pending';
    if (tokensLinked) {
      console.log(
        '[Callback] ✅ Tokens linked — redirecting with salla_connected=1'
      );
    } else {
      console.log(
        '[Callback] ⚠️ Tokens not linked — redirecting with salla_connected=pending'
      );
    }
    return buildRedirect(baseOrigin, SUCCESS_PATH, {
      salla_connected: finalStatus,
    });
  } catch (err) {
    // فشل تبادل التوكن (أو قراءة body) — هذا خطأ حقيقي يستحق صفحة الخطأ
    const reason = err instanceof Error ? err.message : 'unknown_error';
    console.error('[Callback] ❌ Token exchange failed:', reason);
    return buildRedirect(baseOrigin, ERROR_PATH, { error: reason });
  }
}

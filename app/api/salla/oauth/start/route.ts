/**
 * Salla OAuth — Step 1: Generate Authorization URL and Redirect
 *
 * نقطة بداية Custom Mode OAuth مع سلة. GET فقط.
 *
 * المسار:
 *  1) توليد state عشوائي (crypto.randomBytes 32-byte → hex) لحماية CSRF.
 *  2) تخزين state في HTTP-only cookie مؤقت (10 دقائق) يُحذف في callback.
 *  3) بناء رابط التفويض:
 *     https://accounts.salla.sa/oauth2/auth?client_id=...&response_type=code
 *     &redirect_uri=...&scope=offline_access&state=...
 *  4) تحويل 302 إلى سلة.
 *
 * ⚠️ scope = "offline_access" حرفياً. أي تعديل (إضافة scopes أخرى مفصولة
 *    بمسافة) قد يُغيّر رد سلة. غياب offline_access → لن يصل refresh_token
 *    → سيفشل إدراج merchants لأن العمود NOT NULL.
 *
 * مرجع: Formak-Ai-Context-v3.md + Formak-Phase7-to-Launch-v2.md (Phase 9).
 */

import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';

const STATE_COOKIE_NAME = 'salla_oauth_state';
const STATE_TTL_SECONDS = 600;

const SALLA_AUTH_ENDPOINT = 'https://accounts.salla.sa/oauth2/auth';

interface EnvCheck {
  ok: boolean;
  message?: string;
}

function checkEnv(): EnvCheck {
  const clientId = process.env.SALLA_CLIENT_ID;
  const callbackUrl = process.env.SALLA_CALLBACK_URL;

  if (!clientId) {
    return { ok: false, message: 'Missing SALLA_CLIENT_ID' };
  }
  if (!callbackUrl) {
    return { ok: false, message: 'Missing SALLA_CALLBACK_URL' };
  }
  return { ok: true };
}

function generateState(): string {
  return crypto.randomBytes(32).toString('hex');
}

function buildAuthUrl(state: string): string {
  const clientId = process.env.SALLA_CLIENT_ID as string;
  const callbackUrl = process.env.SALLA_CALLBACK_URL as string;

  const url = new URL(SALLA_AUTH_ENDPOINT);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', callbackUrl);
  url.searchParams.set('scope', 'offline_access');
  url.searchParams.set('state', state);

  return url.toString();
}

export async function GET(_request: NextRequest): Promise<NextResponse> {
  const envCheck = checkEnv();
  if (!envCheck.ok) {
    return NextResponse.json(
      { error: 'OAuth start misconfigured', reason: envCheck.message },
      { status: 500 }
    );
  }

  const state = generateState();
  const authUrl = buildAuthUrl(state);

  const response = NextResponse.redirect(authUrl, { status: 302 });
  response.cookies.set({
    name: STATE_COOKIE_NAME,
    value: state,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: STATE_TTL_SECONDS,
  });

  return response;
}

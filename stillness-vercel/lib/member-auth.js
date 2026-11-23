import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const accessCookie = 'stillness_access';
export const refreshCookie = 'stillness_refresh';
const recoveryCookie = 'stillness_recovery';

export function appOrigin(req) {
  const configured = process.env.APP_ORIGIN || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '');
  if (!configured) throw new Error('Application origin is missing.');
  const url = new URL(configured);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('Application origin must use HTTPS.');
  }
  const publicOrigin = process.env.STILLNESS_PUBLIC_ORIGIN;
  const requestHost = req?.headers?.host;
  if (publicOrigin && typeof requestHost === 'string') {
    const publicUrl = new URL(publicOrigin);
    if (publicUrl.protocol === 'https:' && requestHost.toLowerCase() === publicUrl.host) return publicUrl.origin;
  }
  return url.origin;
}

export function fail(res, status, error, code) {
  return res.status(status).json(code ? { error, code } : { error });
}

export function requireSameOrigin(req, res) {
  const { origin, 'sec-fetch-site': fetchSite, 'content-type': contentType = '' } = req.headers || {};
  let allowedOrigin;
  try { allowedOrigin = appOrigin(req); } catch {
    fail(res, 503, 'Membership is being configured. Please try again later.');
    return false;
  }
  // Preview hosts must match Vercel's injected deployment hostname, never a user-supplied Host header.
  const previewOrigin = process.env.VERCEL_ENV === 'preview' && process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '';
  if (fetchSite === 'cross-site' || (origin && origin !== allowedOrigin && origin !== previewOrigin)) {
    fail(res, 403, 'This action must be made from Stillness.');
    return false;
  }
  if ((!req.method || ['POST', 'PATCH'].includes(req.method)) && !/^application\/json(?:\s*;|$)/i.test(contentType)) {
    fail(res, 415, 'Send this action as JSON.');
    return false;
  }
  return true;
}

export function readCookie(req, name) {
  for (const field of (req.headers?.cookie || '').split(';')) {
    const [key, ...rest] = field.trim().split('=');
    if (key === name) {
      try { return decodeURIComponent(rest.join('=')); } catch { return ''; }
    }
  }
  return '';
}

export function writeCookie(req, res, name, value, maxAge) {
  const all = res.getHeader('Set-Cookie') || [];
  const secure = appOrigin(req).startsWith('https:') ? '; Secure' : '';
  res.setHeader('Set-Cookie', [
    ...(Array.isArray(all) ? all : [all]),
    `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`
  ]);
}

export function setMemberSession(req, res, data) {
  const maxAge = Math.min(86_400, Math.max(60, Number(data.expires_in) || 3600));
  writeCookie(req, res, accessCookie, data.access_token, maxAge);
  writeCookie(req, res, refreshCookie, data.refresh_token, 60 * 60 * 24 * 30);
}

export function clearMemberSession(req, res) {
  for (const name of [accessCookie, refreshCookie, recoveryCookie]) writeCookie(req, res, name, '', 0);
}

export function clearRecovery(req, res) {
  writeCookie(req, res, recoveryCookie, '', 0);
}

function recoveryProof(token, ends) {
  const secret = process.env.MEMBERS_COOKIE_SECRET;
  if (!secret || secret.length < 32) throw new Error('Recovery signing secret is missing.');
  return createHmac('sha256', secret).update(`${ends}:${token}`).digest('base64url');
}

export function setRecovery(req, res, token) {
  const ends = Date.now() + 600_000;
  writeCookie(req, res, recoveryCookie, `${ends}.${recoveryProof(token, ends)}`, 600);
}

export function hasRecovery(req, token) {
  const [ends, proof] = readCookie(req, recoveryCookie).split('.');
  if (!token || !/^\d{13}$/.test(ends || '') || Date.now() >= Number(ends) || !/^[\w-]{43}$/.test(proof || '')) return false;
  const expected = recoveryProof(token, ends);
  return timingSafeEqual(Buffer.from(proof), Buffer.from(expected));
}

export function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, codeChallenge };
}

export async function authRequest(path, { method = 'GET', token, body } = {}) {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!base || !key) throw new Error('Account service settings are missing.');
  const headers = { apikey: key, 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(new URL(`/auth/v1${path}`, base).toString(), {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8000), cache: 'no-store'
  });
  const data = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, data };
}

export function isVerified(user) {
  return Boolean(user?.id && user?.email && user.email_confirmed_at);
}

export function ownerAccount(user) {
  const allowed = (process.env.MEMBER_ADMIN_EMAILS || '').split(',').map(email => email.trim().toLowerCase()).filter(Boolean);
  return isVerified(user) && allowed.includes(user.email.toLowerCase());
}

export async function requireMember(req, res) {
  const token = readCookie(req, accessCookie);
  if (!token) {
    fail(res, 401, 'Sign in to continue.', 'sign_in_required');
    return null;
  }
  try {
    const auth = await authRequest('/user', { token });
    if (!auth.ok) {
      fail(res, auth.status >= 500 ? 503 : 401,
        auth.status >= 500 ? 'The account service is temporarily unavailable.' : 'Sign in to continue.');
      return null;
    }
    if (!isVerified(auth.data)) {
      fail(res, 403, 'Verify your email address to continue.');
      return null;
    }
    if (hasRecovery(req, token)) {
      fail(res, 403, 'Choose a new password to finish recovering your account.');
      return null;
    }
    if (req.headers?.['x-stillness-member'] && req.headers['x-stillness-member'] !== auth.data.id) {
      fail(res, 401, 'Your account changed in another tab. Reload Stillness to continue.');
      return null;
    }
    return auth.data;
  } catch {
    fail(res, 503, 'The account service is temporarily unavailable. Please try again.');
    return null;
  }
}

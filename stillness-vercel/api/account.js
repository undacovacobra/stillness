import {
  accessCookie, refreshCookie, appOrigin, authRequest, clearMemberSession, clearRecovery,
  fail, hasRecovery, isVerified, ownerAccount, pkce, readCookie, requireSameOrigin,
  setMemberSession, setRecovery, writeCookie
} from '../lib/member-auth.js';
import { getMember, listMembers, saveProfile } from '../lib/member-store.js';

const signedOut = { user: null };
const recoveryAccessCookie = 'stillness_recovery_access';
const temporary = 'Account service is temporarily unavailable. Please try again.';

function validEmail(value) {
  return typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validPassword(value) {
  return typeof value === 'string' && value.length >= 10 && Buffer.byteLength(value, 'utf8') <= 72;
}

function verifyCookie(flow) {
  return `stillness_pkce_${flow}`;
}

function publicData(member) {
  if (!member) return null;
  const {
    user_id, name, goal, status, period_ends_at, trial_used, remaining_seconds,
    topup_seconds, last_used_at, cancel_at_period_end, stripe_customer_id, subscription_id
  } = member;
  return {
    user_id, name, goal, status, period_ends_at, trial_used, remaining_seconds,
    topup_seconds, last_used_at, cancel_at_period_end,
    billing_customer: Boolean(stripe_customer_id), has_subscription: Boolean(subscription_id)
  };
}

async function snapshot(user) {
  return {
    user: { id: user.id, email: user.email },
    member: publicData(await getMember(user.id, user.email)),
    owner: ownerAccount(user)
  };
}

function recoverySnapshot(user) {
  return { user: { id: user.id, email: user.email }, member: null, owner: false, recovery: true };
}

async function activeSession(req, res, { allowRefresh = false } = {}) {
  const recoveryAccess = readCookie(req, recoveryAccessCookie);
  if (hasRecovery(req, recoveryAccess)) {
    const auth = await authRequest('/user', { token: recoveryAccess });
    if (auth.ok && isVerified(auth.data)) return { user: auth.data, access: recoveryAccess, recovery: true };
    if (auth.status >= 500) throw new Error('Recovery verification unavailable.');
  }
  let access = readCookie(req, accessCookie);
  if (access) {
    const auth = await authRequest('/user', { token: access });
    if (auth.ok && isVerified(auth.data)) return { user: auth.data, access, recovery: false };
    if (auth.status >= 500) throw new Error('Session verification unavailable.');
  }
  const refresh = readCookie(req, refreshCookie);
  if (!allowRefresh || !refresh) return null;
  const auth = await authRequest('/token?grant_type=refresh_token', {
    method: 'POST', body: { refresh_token: refresh }
  });
  if (!auth.ok || !isVerified(auth.data?.user)) {
    if (auth.status >= 500 || auth.status === 429) throw new Error('Session refresh unavailable.');
    return null;
  }
  setMemberSession(req, res, auth.data);
  return { user: auth.data.user, access: auth.data.access_token, recovery: false };
}

function clearRecoveryCredentials(req, res) {
  clearRecovery(req, res);
  writeCookie(req, res, recoveryAccessCookie, '', 0);
}

async function beginEmailFlow(req, res, action, email, password) {
  const flow = action === 'forgot' ? 'recovery' : 'signup';
  if (!validEmail(email)) return fail(res, 400, 'Enter a valid email address.');
  if (flow === 'signup' && !validPassword(password)) {
    return fail(res, 400, 'Use a password of at least 10 characters and at most 72 bytes.');
  }
  const callback = new URL('/', appOrigin(req));
  callback.searchParams.set('flow', flow);
  const { verifier, codeChallenge } = pkce();
  const auth = await authRequest(`/${flow === 'signup' ? 'signup' : 'recover'}?redirect_to=${encodeURIComponent(callback.toString())}`, {
    method: 'POST',
    body: {
      email, ...(flow === 'signup' ? { password } : {}),
      code_challenge: codeChallenge, code_challenge_method: 's256'
    }
  });
  if (auth.status === 429) return fail(res, 429, 'Too many email requests. Please wait a little before trying again.');
  // A failed reset request must not reveal whether an account exists.
  if (auth.status >= 500) return fail(res, 503, temporary);
  if (flow === 'signup' && !auth.ok) {
    const invalidPassword = auth.data?.error_code === 'weak_password' || auth.data?.code === 'weak_password';
    if (invalidPassword) return fail(res, 400, 'Choose a stronger password and try again.');
    if (![400, 422].includes(auth.status)) return fail(res, 503, temporary);
  }
  if (auth.ok) writeCookie(req, res, verifyCookie(flow), verifier, 60 * 60);
  return res.status(200).json({
    message: flow === 'signup'
      ? 'Check your email for a confirmation link. Open it on this device and in this browser.'
      : 'If that email has an account, a reset link is on its way. Open it in this browser.'
  });
}

async function acceptEmailCode(req, res, { code, flow }) {
  if (!['signup', 'recovery'].includes(flow) || typeof code !== 'string' || !/^[\w.-]{8,256}$/.test(code)) {
    return fail(res, 400, 'That link is incomplete. Request a new link.');
  }
  const verifier = readCookie(req, verifyCookie(flow));
  if (!/^[\w-]{43}$/.test(verifier)) {
    return fail(res, 400, 'Open the link in the browser where you requested it, or request a new link.');
  }
  const auth = await authRequest('/token?grant_type=pkce', {
    method: 'POST', body: { auth_code: code, code_verifier: verifier }
  });
  if (!auth.ok || !isVerified(auth.data?.user)) {
    return fail(res, auth.status >= 500 ? 503 : 400,
      auth.status >= 500 ? temporary : 'That link is no longer valid. Request a new link.');
  }
  writeCookie(req, res, verifyCookie(flow), '', 0);
  clearRecoveryCredentials(req, res);
  if (flow === 'recovery') {
    clearMemberSession(req, res);
    writeCookie(req, res, recoveryAccessCookie, auth.data.access_token, 600);
    setRecovery(req, res, auth.data.access_token);
    return res.status(200).json(recoverySnapshot(auth.data.user));
  }
  setMemberSession(req, res, auth.data);
  return res.status(200).json(await snapshot(auth.data.user));
}

async function login(req, res, email, password) {
  if (!validEmail(email) || typeof password !== 'string' || !password || Buffer.byteLength(password, 'utf8') > 72) {
    return fail(res, 400, 'Enter your email and password.');
  }
  const auth = await authRequest('/token?grant_type=password', { method: 'POST', body: { email, password } });
  if (!auth.ok) {
    const reason = auth.data?.error_code || auth.data?.code;
    if (reason === 'email_not_confirmed') return fail(res, 403, 'Check your email and confirm it before signing in.');
    if (auth.status === 429) return fail(res, 429, 'Too many sign-in attempts. Please wait a little and try again.');
    if (auth.status >= 500) return fail(res, 503, temporary);
    return fail(res, 401, 'That email and password do not match.');
  }
  if (!isVerified(auth.data?.user)) return fail(res, 403, 'Verify your email before signing in.');
  clearRecoveryCredentials(req, res);
  setMemberSession(req, res, auth.data);
  return res.status(200).json(await snapshot(auth.data.user));
}

async function updatePassword(req, res, session, password, currentPassword) {
  if (!validPassword(password)) {
    return fail(res, 400, 'Use a password of at least 10 characters and at most 72 bytes.');
  }
  if (!session.recovery) {
    if (typeof currentPassword !== 'string' || !currentPassword || Buffer.byteLength(currentPassword, 'utf8') > 72) {
      return fail(res, 400, 'Enter your current password.');
    }
    const confirm = await authRequest('/token?grant_type=password', {
      method: 'POST', body: { email: session.user.email, password: currentPassword }
    });
    if (!confirm.ok) {
      if (confirm.status >= 500) return fail(res, 503, temporary);
      if (confirm.status === 429) return fail(res, 429, 'Wait a little before trying your password again.');
      return fail(res, 400, 'That current password did not match.');
    }
    session.access = confirm.data.access_token;
  }
  const updated = await authRequest('/user', { method: 'PUT', token: session.access, body: { password } });
  if (!updated.ok) {
    return fail(res, updated.status >= 500 ? 503 : 400,
      updated.status >= 500 ? temporary : 'Choose a different, stronger password and try again.');
  }
  await authRequest('/logout?scope=global', { method: 'POST', token: session.access }).catch(() => null);
  clearMemberSession(req, res);
  clearRecoveryCredentials(req, res);
  return res.status(200).json({ ...signedOut, message: 'Password updated. Sign in with your new password.' });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (!['GET', 'POST'].includes(req.method)) return fail(res, 405, 'Method not allowed.');
  if (!requireSameOrigin(req, res)) return;
  try {
    if (req.method === 'GET') {
      const session = await activeSession(req, res, { allowRefresh: true });
      if (req.query?.view === 'admin') {
        if (!session || session.recovery || !ownerAccount(session.user)) return fail(res, 403, 'Owner access only.');
        const offset = Math.min(100_000, Math.max(0, Math.floor(Number(req.query?.offset) || 0)));
        const members = await listMembers({ limit: 100, offset });
        return res.status(200).json({ members: members.map(member => ({ ...publicData(member), email: member.email })), nextOffset: members.length === 100 ? offset + 100 : null });
      }
      if (!session) return res.status(200).json(signedOut);
      return res.status(200).json(session.recovery ? recoverySnapshot(session.user) : await snapshot(session.user));
    }
    const body = req.body || {};
    const { action, password } = body;
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (action === 'login') return await login(req, res, email, password);
    if (['signup', 'forgot'].includes(action)) return await beginEmailFlow(req, res, action, email, password);
    if (action === 'accept') return await acceptEmailCode(req, res, body);
    if (action === 'logout') {
      const access = readCookie(req, accessCookie) || readCookie(req, recoveryAccessCookie);
      if (access) await authRequest('/logout?scope=local', { method: 'POST', token: access }).catch(() => null);
      clearMemberSession(req, res);
      clearRecoveryCredentials(req, res);
      return res.status(200).json(signedOut);
    }

    const session = await activeSession(req, res, { allowRefresh: true });
    if (!session) return fail(res, 401, 'Sign in to continue.');
    if (action === 'password') return await updatePassword(req, res, session, password, body.currentPassword);
    if (session.recovery) return fail(res, 403, 'Choose a new password to finish recovering your account.');
    if (action === 'profile') {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const goal = typeof body.goal === 'string' ? body.goal.trim() : '';
      if (!name || name.length > 80 || !goal || goal.length > 100 || /[\u0000-\u001F\u007F]/.test(name + goal)) {
        return fail(res, 400, 'Enter a name and a short goal.');
      }
      await getMember(session.user.id, session.user.email);
      await saveProfile(session.user.id, { name, goal });
      return res.status(200).json(await snapshot(session.user));
    }
    return fail(res, 400, 'Unknown account action.');
  } catch {
    return fail(res, 503, temporary);
  }
}

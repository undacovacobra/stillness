import { createHash } from 'node:crypto';

async function membershipRpc(name, input) {
  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim();
  const secret = (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !secret) throw new Error('Membership storage is unavailable.');

  const headers = { apikey: secret, 'Content-Type': 'application/json' };
  // Supabase's opaque secret keys are accepted in the gateway header only.
  if (!secret.startsWith('sb_secret_')) headers.Authorization = 'Bearer ' + secret;

  try {
    const endpoint = new URL('/rest/v1/rpc/' + name, url);
    const result = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(8000),
    });
    if (!result.ok) throw new Error();
    return await result.json();
  } catch {
    throw new Error('Membership storage is unavailable.');
  }
}

export function getMember(userId, verifiedEmail = null) {
  return membershipRpc('stillness_get_member', { p_user_id: userId, p_email: verifiedEmail });
}

export function saveProfile(userId, { name, goal }) {
  return membershipRpc('stillness_save_profile', { p_user_id: userId, p_name: name, p_goal: goal });
}

export function listMembers({ limit = 100, offset = 0 } = {}) {
  return membershipRpc('stillness_list_members', { p_limit: limit, p_offset: offset });
}

export function setStripeCustomer(userId, stripeCustomerId) {
  return membershipRpc('stillness_set_stripe_customer', { p_user_id: userId, p_customer_id: stripeCustomerId });
}

export function findMemberByCustomer(stripeCustomerId) {
  return membershipRpc('stillness_find_member_by_customer', { p_customer_id: stripeCustomerId });
}

export function claimTrialCard(userId, customerId, setupId, cardFingerprint) {
  const cardHash = typeof cardFingerprint === 'string' && cardFingerprint
    ? createHash('sha256').update(cardFingerprint).digest('hex')
    : null;
  return membershipRpc('stillness_claim_trial_card', {
    p_user_id: userId,
    p_customer_id: customerId,
    p_setup_id: setupId,
    p_card_hash: cardHash,
  });
}

export function applyBillingEvent({
  eventId,
  eventCreated = 0,
  userId,
  customerId,
  subscriptionId = null,
  status = null,
  periodEndsAt = null,
  periodStartsAt = null,
  entitlement,
  trialClaimId = null,
  topupPurchaseId = null,
  cancelAtPeriodEnd = null,
}) {
  return membershipRpc('stillness_apply_billing_event', {
    p_event_id: eventId,
    p_event_created: eventCreated,
    p_user_id: userId,
    p_customer_id: customerId,
    p_subscription_id: subscriptionId,
    p_status: status,
    p_period_ends_at: periodEndsAt,
    p_period_starts_at: periodStartsAt,
    p_entitlement: entitlement,
    p_trial_claim_id: trialClaimId,
    p_topup_purchase_id: topupPurchaseId,
    p_cancel_at_period_end: cancelAtPeriodEnd,
  });
}

export function reserveUsage(userId, requestId, { seconds = 0, kind = 'voice' } = {}) {
  return membershipRpc('stillness_reserve_usage', {
    p_user_id: userId,
    p_request_id: requestId,
    p_seconds: seconds,
    p_kind: kind === 'tts' ? 'voice' : kind,
  });
}

export function settleUsage(userId, requestId, usedSeconds) {
  return membershipRpc('stillness_settle_usage', {
    p_user_id: userId,
    p_request_id: requestId,
    p_used_seconds: usedSeconds,
  });
}

(() => {
  const accountPath = '/api/account';
  const billingPath = '/api/billing';
  const plans = new Set(['trialing', 'active']);
  const goals = {
    sleep: 'Let the day settle.',
    focus: 'Make a little room for what matters.',
    calm: 'Take a slow breath before the next thing.'
  };
  const headings = {
    loading: 'memberLoadingTitle',
    login: 'memberAuthTitle',
    welcome: 'memberWelcomeTitle',
    profile: 'memberProfileTitle',
    admin: 'memberAdminTitle'
  };
  const byId = id => document.getElementById(id);
  const text = (id, value) => { byId(id).textContent = value; };
  const reveal = (id, visible) => { byId(id).hidden = !visible; };

  let snapshot = { user: null };
  let visiblePage = 'loading';
  let authMode = 'login';
  let pendingGenerationProblem = '';
  let refreshTimer;
  let refreshRequest;
  let accountRevision = 0;
  let channel;
  let ownerOffset = null;

  function memberIsActive(member) {
    return member && plans.has(member.status) && Date.parse(member.period_ends_at) > Date.now();
  }

  function isRecovery() {
    return snapshot.recovery === true;
  }

  function remainingSeconds(member) {
    return (Number(member?.remaining_seconds) || 0) + (Number(member?.topup_seconds) || 0);
  }

  function readableTime(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    if (total === 0) return '0 min';
    const minutes = Math.floor(total / 60);
    const partial = total % 60;
    return minutes && partial ? `${minutes} min ${partial} sec` : minutes ? `${minutes} min` : `${partial} sec`;
  }

  function readableDate(timestamp) {
    const date = new Date(timestamp || '');
    return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
  }

  function accountGreeting(member) {
    const name = String(member?.name || '').trim();
    const goal = String(member?.goal || '').trim();
    if (!name) return '';
    const knownGoal = Object.hasOwn(goals, goal) ? goal
      : /\b(sleep|rest|bedtime|insomnia)\b/i.test(goal) ? 'sleep'
      : /\b(focus|study|concentrate|clarity|distraction)\b/i.test(goal) ? 'focus'
      : /\b(calm|stress|anxiety|overwhelm|worry)\b/i.test(goal) ? 'calm'
      : '';
    const phrase = knownGoal ? goals[knownGoal] : `One breath toward “${goal}”.`;
    return `Welcome, ${name}. ${phrase}`;
  }

  function describePlan(member) {
    if (memberIsActive(member)) return member.status === 'trialing' ? '10-day trial' : 'Stillness monthly · $11.99';
    if (member?.status === 'past_due') return 'Payment needs attention';
    if (member?.status === 'trial_ineligible') return 'This card has already been used for a Stillness trial';
    if (member?.status === 'canceled' || member?.cancel_at_period_end) return 'Membership ended';
    if (member?.status === 'incomplete') return 'Payment setup pending';
    return 'No active membership';
  }

  function generationProblem() {
    if (!snapshot.user || isRecovery()) return 'Sign in to start a meditation.';
    if (!snapshot.member?.name || !snapshot.member?.goal) return 'Complete your welcome to start a meditation.';
    if (!memberIsActive(snapshot.member)) return 'Start a trial or membership to generate narration.';
    if (remainingSeconds(snapshot.member) <= 0) return 'You’ve used your narration allowance.';
    return '';
  }

  function canGenerate() {
    return !generationProblem();
  }

  function libraryKey() {
    return snapshot.user?.id && !isRecovery() ? `stillness_session_library_v1:${snapshot.user.id}` : null;
  }

  async function apiRequest(path, payload) {
    const options = { credentials: 'same-origin', cache: 'no-store' };
    if (payload) {
      options.method = 'POST';
      options.headers = { 'Content-Type': 'application/json' };
      options.body = JSON.stringify(payload);
    }
    const response = await fetch(path, options);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : 'Stillness couldn’t complete that request. Try again.');
    return body;
  }

  function recommendedPage() {
    if (isRecovery() || !snapshot.user) return 'login';
    if (!snapshot.member?.name || !snapshot.member?.goal) return 'welcome';
    return 'studio';
  }

  function updateBalance() {
    const member = snapshot.member;
    const problem = generationProblem();
    text('membershipGreeting', accountGreeting(member));
    text('membershipAllowance', problem || `${readableTime(remainingSeconds(member))} of narration available`);
    byId('beginMeditationBtn').setAttribute('aria-describedby', 'membershipAllowance');
    for (const id of ['beginMeditationBtn', 'beginFromScriptBtn']) {
      byId(id).disabled = Boolean(problem);
    }
    reveal('membershipStudioProfile', Boolean(problem) && Boolean(snapshot.user));
    reveal('membershipScriptProfile', Boolean(problem) && Boolean(snapshot.user));
    reveal('memberAdminButton', snapshot.owner === true);
  }

  function renderBilling() {
    const member = snapshot.member;
    const eligible = memberIsActive(member);
    const trial = member?.status === 'trialing';
    const previouslyTried = Boolean(member?.trial_used || member?.status === 'trial_ineligible');
    const delinquent = ['past_due', 'incomplete', 'unpaid'].includes(member?.status);
    const endDate = readableDate(member?.period_ends_at);
    text('memberPlanStatus', describePlan(member));
    text('memberPlanDate', eligible && endDate
      ? member?.cancel_at_period_end ? `Access ends ${endDate}.` : trial ? `First charge ${endDate} unless canceled.` : `Included minutes reset ${endDate}.`
      : '');
    text('memberPlanDescription', eligible
      ? trial ? 'This trial includes 15 narrated minutes.' : 'Your subscription includes 120 narrated minutes per paid period.'
      : previouslyTried ? 'Subscribe for 120 narrated minutes per month.' : 'The 10-day trial includes 15 narrated minutes. A card is required. After 10 days, pay $11.99 per month unless canceled.');
    reveal('memberBalance', eligible || remainingSeconds(member) > 0);
    text('memberIncluded', readableTime(member?.remaining_seconds));
    text('memberTopupLeft', readableTime(member?.topup_seconds));
    const subscribe = byId('memberSubscribe');
    subscribe.dataset.billing = previouslyTried ? 'subscribe-paid' : 'subscribe';
    subscribe.textContent = previouslyTried ? 'Subscribe · $11.99/month' : 'Start 10-day trial';
    const hasBilling = Boolean(member?.billing_customer || member?.has_subscription);
    reveal('memberSubscribe', !eligible && !(delinquent && hasBilling));
    reveal('memberTopup', eligible && member?.status === 'active');
    reveal('memberPortal', hasBilling);
  }

  function showPage(page, { focus = true } = {}) {
    visiblePage = page;
    const panel = byId('memberPanel');
    reveal('memberPanel', page !== 'studio');
    reveal('memberStudio', page === 'studio');
    reveal('memberNavigation', page === 'studio');
    reveal('memberBack', page === 'profile' || page === 'admin');
    for (const section of ['loading', 'login', 'welcome', 'profile', 'admin']) {
      reveal(`member${section[0].toUpperCase()}${section.slice(1)}`, section === page);
    }
    if (headings[page]) panel.setAttribute('aria-labelledby', headings[page]);
    else panel.removeAttribute('aria-labelledby');
    if (focus) {
      const heading = headings[page] ? byId(headings[page]) : byId('memberStudio').querySelector('section:not(.hidden) h1');
      heading?.focus({ preventScroll: true });
      window.scrollTo(0, 0);
    }
  }

  function setAuthMode(mode) {
    authMode = mode;
    const authCopy = {
      login: ['Welcome to Stillness', 'Sign in for a meditation made around you.', 'Sign in'],
      signup: ['Create your account', 'We’ll email you a link to verify your address.', 'Create account'],
      forgot: ['Reset your password', 'We’ll email you a link to choose a new password.', 'Send reset link'],
      recovery: ['Choose a new password', 'Enter a new password to return to Stillness.', 'Set password'],
      resend: ['Resend verification', 'Enter the email and password you used to create your account.', 'Send verification email']
    }[mode];
    text('memberAuthTitle', authCopy[0]);
    text('memberAuthLead', authCopy[1]);
    text('memberAuthSubmit', authCopy[2]);
    text('memberAuthSwitch', mode === 'login' ? 'Create account' : 'Back to sign in');
    reveal('memberAuthForgot', mode === 'login' || mode === 'signup');
    reveal('memberResend', false);
    reveal('memberAuthSwitch', mode !== 'recovery');
    reveal('memberEmailField', mode !== 'recovery');
    reveal('memberPasswordField', mode !== 'forgot');
    byId('memberEmail').required = mode !== 'recovery';
    const password = byId('memberPassword');
    password.value = '';
    password.required = mode !== 'forgot';
    password.minLength = mode === 'login' ? 1 : 10;
    password.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    text('memberAuthFeedback', '');
  }

  function applySnapshot(next, { navigate = false } = {}) {
    const previousId = snapshot.user?.id;
    if (previousId && previousId !== next.user?.id) {
      snapshot = { user: null };
      showPage('loading', { focus: false });
      window.location.reload();
      return;
    }
    snapshot = next;
    if (isRecovery() && authMode !== 'recovery') setAuthMode('recovery');
    if (!isRecovery() && authMode === 'recovery') setAuthMode('login');
    updateBalance();
    if (snapshot.user && !isRecovery()) renderBilling();
    const page = recommendedPage();
    const ownerAccessRevoked = visiblePage === 'admin' && !snapshot.owner;
    if (ownerAccessRevoked) byId('memberAdminList').replaceChildren();
    if (navigate || visiblePage === 'loading' || ownerAccessRevoked || page === 'login' && visiblePage !== 'login') {
      showPage(page, { focus: navigate });
    }
  }

  async function refreshAccount() {
    if (refreshRequest) return refreshRequest;
    const revision = accountRevision;
    refreshRequest = apiRequest(accountPath).then(next => {
      if (revision === accountRevision) applySnapshot(next);
      return next;
    }).finally(() => { refreshRequest = undefined; });
    return refreshRequest;
  }

  function scheduleBalanceRefresh() {
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => refreshAccount().catch(() => {}), 650);
  }

  async function requestGeneration(path, options) {
    pendingGenerationProblem = '';
    const requestedBy = snapshot.user?.id;
    const headers = new Headers(options.headers);
    if (requestedBy) headers.set('X-Stillness-Member', requestedBy);
    const request = { ...options, headers, credentials: 'same-origin', cache: 'no-store' };
    let response = await fetch(path, request);
    if (response.status === 401 && requestedBy) {
      const refreshed = await refreshAccount().catch(() => null);
      if (refreshed?.user?.id === requestedBy && !refreshed.recovery && !options.signal?.aborted) {
        response = await fetch(path, request);
      }
    }
    if (response.status === 402 || response.status === 403 || response.status === 401) {
      const issue = await response.clone().json().catch(() => ({}));
      pendingGenerationProblem = typeof issue.error === 'string' ? issue.error : generationProblem() || 'Open your profile to check your membership.';
    }
    if (path === '/api/tts') {
      const included = response.headers.get('X-Stillness-Remaining-Seconds');
      const extra = response.headers.get('X-Stillness-Topup-Seconds');
      if (snapshot.user?.id === requestedBy && snapshot.member && included !== null && extra !== null) {
        const amounts = [Number(included), Number(extra)];
        if (amounts.every(value => Number.isSafeInteger(value) && value >= 0)) {
          snapshot.member = { ...snapshot.member, remaining_seconds: amounts[0], topup_seconds: amounts[1] };
          updateBalance();
          if (visiblePage === 'profile') renderBilling();
        }
      }
      scheduleBalanceRefresh();
    }
    return response;
  }

  function readGoal(prefix, member) {
    const preset = Object.hasOwn(goals, member?.goal) ? member.goal : member?.goal ? 'custom' : '';
    byId(`member${prefix}Name`).value = member?.name || '';
    byId(`member${prefix}Goal`).value = preset;
    byId(`member${prefix}Custom`).value = preset === 'custom' ? member.goal : '';
    syncCustomGoal(prefix);
  }

  function syncCustomGoal(prefix) {
    const custom = byId(`member${prefix}Custom`);
    custom.required = byId(`member${prefix}Goal`).value === 'custom';
    custom.parentElement.hidden = !custom.required;
  }

  function dataFrom(form) {
    return Object.fromEntries(new FormData(form));
  }

  async function withButton(button, feedbackId, action) {
    if (!button || button.disabled) return;
    button.disabled = true;
    text(feedbackId, '');
    try {
      await action();
    } catch (error) {
      text(feedbackId, error.message || 'Stillness couldn’t complete that request. Try again.');
    } finally {
      button.disabled = false;
    }
  }

  async function submitAuth(event) {
    event.preventDefault();
    const { email, password } = dataFrom(event.currentTarget);
    await withButton(byId('memberAuthSubmit'), 'memberAuthFeedback', async () => {
      const mode = authMode;
      accountRevision++;
      const result = mode === 'recovery'
        ? await apiRequest(accountPath, { action: 'password', password })
        : await apiRequest(accountPath, {
          action: mode === 'resend' ? 'signup' : mode,
          email: email.trim(),
          ...(mode === 'forgot' ? {} : { password })
        }).catch(error => {
          if (mode === 'login' && /confirm|verify/i.test(error.message)) reveal('memberResend', true);
          throw error;
        });
      if (mode === 'recovery') {
        signInAfterPasswordChange();
        return;
      }
      if (result.user) {
        applySnapshot(result, { navigate: true });
        channel?.postMessage('session');
        return;
      }
      byId('memberPassword').value = '';
      reveal('memberResend', mode === 'signup');
      text('memberAuthFeedback', result.message || (mode === 'signup' || mode === 'resend'
        ? 'Check your email to verify your account.'
        : 'Check your email for the reset link.'));
    });
  }

  async function submitProfile(event, feedbackId) {
    event.preventDefault();
    const { name, goal, customGoal } = dataFrom(event.currentTarget);
    const selectedGoal = goal === 'custom' ? customGoal.trim() : goal;
    await withButton(event.submitter, feedbackId, async () => {
      if (!name.trim() || !selectedGoal) throw new Error('Enter your name and choose a goal.');
      accountRevision++;
      const result = await apiRequest(accountPath, { action: 'profile', name: name.trim(), goal: selectedGoal });
      applySnapshot(result.user ? result : await apiRequest(accountPath), { navigate: visiblePage === 'welcome' });
      text(feedbackId, 'Your details are saved.');
    });
  }

  async function submitPassword(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const { currentPassword, password } = dataFrom(form);
    await withButton(event.submitter, 'memberPasswordFeedback', async () => {
      accountRevision++;
      await apiRequest(accountPath, { action: 'password', currentPassword, password });
      form.reset();
      signInAfterPasswordChange();
    });
  }

  function signInAfterPasswordChange() {
    snapshot = { user: null };
    showPage('loading', { focus: false });
    channel?.postMessage('session');
    const url = new URL(window.location.href);
    url.searchParams.set('password', 'updated');
    window.location.replace(url.href);
  }

  function showProfile(problem = '') {
    if (recommendedPage() !== 'studio') {
      showPage(recommendedPage());
      return;
    }
    for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
    text('memberBillingFeedback', problem);
    text('memberProfileEmail', snapshot.user.email || '');
    text('memberProfileFeedback', '');
    readGoal('Profile', snapshot.member);
    renderBilling();
    showPage('profile');
    refreshAccount().catch(() => {});
  }

  async function signOut(button) {
    const feedback = visiblePage === 'welcome' ? 'memberWelcomeFeedback' : 'memberLogoutFeedback';
    await withButton(button, feedback, async () => {
      accountRevision++;
      await apiRequest(accountPath, { action: 'logout' });
      snapshot = { user: null };
      showPage('loading', { focus: false });
      channel?.postMessage('session');
      window.location.reload();
    });
  }

  async function billingAction(button) {
    await withButton(button, 'memberBillingFeedback', async () => {
      const { url } = await apiRequest(billingPath, { action: button.dataset.billing });
      if (typeof url !== 'string') throw new Error('Stripe couldn’t open that page. Try again.');
      const host = new URL(url);
      if (host.protocol !== 'https:' || !['checkout.stripe.com', 'billing.stripe.com'].includes(host.hostname)) {
        throw new Error('Stripe returned an unexpected billing link.');
      }
      window.location.assign(host.href);
    });
  }

  async function renderOwner() {
    if (!snapshot.owner) return;
    ownerOffset = 0;
    byId('memberAdminList').replaceChildren();
    showPage('admin');
    await loadOwnerMembers();
  }

  async function loadOwnerMembers() {
    const next = byId('memberAdminMore');
    if (!snapshot.owner || ownerOffset === null || next.disabled) return;
    const list = byId('memberAdminList');
    next.disabled = true;
    reveal('memberAdminMore', false);
    text('memberAdminFeedback', 'Loading members…');
    try {
      const { members, nextOffset } = await apiRequest(`${accountPath}?view=admin&offset=${ownerOffset}`);
      if (!snapshot.owner || visiblePage !== 'admin') return;
      if (!Array.isArray(members)) throw new Error('The member list is temporarily unavailable.');
      ownerOffset = Number.isSafeInteger(nextOffset) ? nextOffset : null;
      const count = list.childElementCount + members.length;
      text('memberAdminFeedback', `${count} ${count === 1 ? 'account' : 'accounts'}${ownerOffset === null ? '' : ' shown'}`);
      for (const member of members) {
        const row = document.createElement('article');
        row.className = 'member-admin-row';
        const name = document.createElement('h2');
        name.textContent = member.name || 'Account';
        const email = document.createElement('p');
        email.textContent = member.email || '';
        const usage = document.createElement('p');
        const lastUsed = readableDate(member.last_used_at);
        usage.textContent = `${describePlan(member)} · ${readableTime(remainingSeconds(member))} left${lastUsed ? ` · Last used ${lastUsed}` : ''}`;
        row.append(name, email, usage);
        list.append(row);
      }
    } catch (error) {
      text('memberAdminFeedback', error.message);
    } finally {
      next.disabled = false;
      reveal('memberAdminMore', ownerOffset !== null && snapshot.owner === true && visiblePage === 'admin');
    }
  }

  function consumeReturnUrl() {
    const url = new URL(window.location.href);
    const code = url.searchParams.get('code');
    const flow = url.searchParams.get('flow');
    const billing = url.searchParams.get('billing');
    const passwordUpdated = url.searchParams.get('password') === 'updated';
    const authError = url.searchParams.has('error') || new URLSearchParams(url.hash.slice(1)).has('error');
    const callback = Boolean(code || flow || authError);
    for (const key of ['code', 'flow', 'billing', 'password', 'error', 'error_code', 'error_description']) url.searchParams.delete(key);
    if (callback) url.hash = '';
    if (url.href !== window.location.href) history.replaceState(null, '', url.pathname + url.search + url.hash);
    return { code, flow, billing, authError, passwordUpdated };
  }

  async function handleBillingReturn(billing) {
    if (recommendedPage() !== 'studio') return;
    if (billing === 'cancel') {
      showProfile('Checkout was canceled.');
      return;
    }
    if (billing !== 'return') return;
    showProfile('Stripe is confirming your billing update.');
    const before = snapshot.member;
    for (const delay of [1200, 2200, 3500, 5500]) {
      await new Promise(resolve => window.setTimeout(resolve, delay));
      if (!snapshot.user) return;
      await refreshAccount().catch(() => {});
      if (snapshot.member && (snapshot.member.status !== before?.status || remainingSeconds(snapshot.member) !== remainingSeconds(before))) {
        if (visiblePage === 'profile') text('memberBillingFeedback', 'Your account is up to date.');
        return;
      }
    }
    if (visiblePage === 'profile') text('memberBillingFeedback', 'Your profile shows the latest confirmed membership and balance.');
  }

  async function loadMembership(redirect = {}) {
    reveal('memberRetry', false);
    text('memberLoadingMessage', 'Checking your account…');
    let callbackError = '';
    let accepted;
    try {
      if (redirect.code && ['signup', 'recovery'].includes(redirect.flow)) {
        try {
          accepted = await apiRequest(accountPath, { action: 'accept', code: redirect.code, flow: redirect.flow });
        } catch (error) {
          callbackError = error.message;
        }
      }
      applySnapshot(accepted?.user ? accepted : await apiRequest(accountPath));
      if (redirect.passwordUpdated && visiblePage === 'login') {
        text('memberAuthFeedback', 'Your password was updated. Sign in with your new password.');
      } else if (approvedAuthReturn(redirect, accepted)) {
        text('memberAuthFeedback', 'Your email was verified. You can sign in now.');
      } else if (visiblePage === 'login' && (callbackError || redirect.authError)) {
        text('memberAuthFeedback', callbackError || 'This link has expired. Return to this same browser and ask for a new email.');
      }
      if (accepted?.user) channel?.postMessage('session');
      if (redirect.billing) void handleBillingReturn(redirect.billing);
    } catch (error) {
      showPage('loading', { focus: false });
      text('memberLoadingMessage', error.message);
      reveal('memberRetry', true);
    }
  }

  function approvedAuthReturn(redirect, accepted) {
    return visiblePage === 'login' && redirect.flow === 'signup' && Boolean(accepted) && !accepted.user;
  }

  function initMembership() {
    if ('BroadcastChannel' in window) {
      channel = new BroadcastChannel('stillness-account');
      channel.addEventListener('message', () => refreshAccount().catch(() => {}));
    }
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && visiblePage !== 'loading') refreshAccount().catch(() => {});
    });
    byId('memberRetry').addEventListener('click', () => loadMembership());
    byId('memberAuthForm').addEventListener('submit', submitAuth);
    byId('memberAuthSwitch').addEventListener('click', () => setAuthMode(authMode === 'login' ? 'signup' : 'login'));
    byId('memberAuthForgot').addEventListener('click', () => setAuthMode('forgot'));
    byId('memberResend').addEventListener('click', () => setAuthMode('resend'));
    byId('memberWelcomeForm').addEventListener('submit', event => submitProfile(event, 'memberWelcomeFeedback'));
    byId('memberProfileForm').addEventListener('submit', event => submitProfile(event, 'memberProfileFeedback'));
    byId('memberPasswordForm').addEventListener('submit', submitPassword);
    byId('memberBack').addEventListener('click', () => showPage(recommendedPage()));
    for (const prefix of ['Welcome', 'Profile']) byId(`member${prefix}Goal`).addEventListener('change', () => syncCustomGoal(prefix));
    for (const button of document.querySelectorAll('[data-member-logout]')) button.addEventListener('click', () => signOut(button));
    for (const button of document.querySelectorAll('[data-billing]')) button.addEventListener('click', () => billingAction(button));
    for (const button of document.querySelectorAll('[data-member-profile]')) button.addEventListener('click', () => showProfile());
    byId('memberAdminButton').addEventListener('click', renderOwner);
    byId('memberAdminMore').addEventListener('click', loadOwnerMembers);
    void loadMembership(consumeReturnUrl());
  }

  window.StillnessMembership = {
    canGenerate,
    libraryKey,
    generationProblem,
    requestGeneration,
    generationDenial: () => pendingGenerationProblem,
    openGenerationProfile() {
      showProfile(pendingGenerationProblem || generationProblem());
    }
  };
  window.addEventListener('DOMContentLoaded', initMembership);
})();

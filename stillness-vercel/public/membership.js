(() => {
  const accountPath = '/api/account';
  const billingPath = '/api/billing';
  const campaignKey = 'stillness-campaign-source';
  const plans = new Set(['trialing', 'active']);
  const trialOffer = 'Try 15 narrated minutes over 10 days. No card required. The trial ends automatically.';
  const libraryLocked = 'Start a trial or subscribe to access your saved sessions.';
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
  let campaignRequest;
  let reportedSession;
  let visiblePage = 'loading';
  let authMode = 'login';
  let googleAvailable = false;
  let oauthPending = false;
  let oauthNotice = 'Checking Google sign-in…';
  let pendingGenerationProblem = '';
  let refreshTimer;
  let entitlementTimer;
  let refreshRequest;
  let accountRevision = 0;
  let channel;
  let ownerOffset = null;
  let ownerSearch = '';
  let ownerMemberLoad = 0;
  let ownerActivityBefore = null;
  let ownerActivityLoad = 0;
  let ownerTemplates = [];
  let profileRequested = false;

  function memberIsActive(member) {
    return member && member.access_active !== false && plans.has(member.status) &&
      Date.parse(member.period_ends_at) > Date.now();
  }

  function trialCanStart(member) {
    if (!member || memberIsActive(member) || member.trial_used) return false;
    if (typeof member.trial_eligible === 'boolean') return member.trial_eligible;
    return member.status === 'inactive';
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
    if (member?.status === 'canceled' || member?.cancel_at_period_end) return 'Membership ended';
    if (member?.status === 'incomplete') return 'Payment setup pending';
    if (member?.trial_used && !member?.has_subscription) return 'Trial ended';
    return 'No active membership';
  }

  function generationProblem() {
    if (!snapshot.user || isRecovery()) return 'Sign in to start a meditation.';
    if (!snapshot.member?.name || !snapshot.member?.goal) return 'Complete your welcome to start a meditation.';
    if (!memberIsActive(snapshot.member)) {
      return trialCanStart(snapshot.member)
        ? 'Start your free trial to generate narration.'
        : 'An active membership is needed to generate narration.';
    }
    if (remainingSeconds(snapshot.member) <= 0) return 'You’ve used your narration allowance.';
    return '';
  }

  function canGenerate() {
    return !generationProblem();
  }

  function hasPaidNarration(member = snapshot.member) {
    return Boolean(snapshot.user && !isRecovery() && member?.name && member?.goal &&
      member.status === 'active' && memberIsActive(member));
  }

  function kokoroSeconds(member = snapshot.member) {
    return Number(member?.kokoro_remaining_seconds) || 0;
  }

  function canUseKokoro() {
    return hasPaidNarration() && kokoroSeconds() > 0;
  }

  function libraryKey() {
    return snapshot.user?.id && !isRecovery() && memberIsActive(snapshot.member)
      ? `stillness_session_library_v1:${snapshot.user.id}` : null;
  }

  function refreshEntitlement() {
    window.clearTimeout(entitlementTimer);
    updateBalance();
    if (snapshot.user && !isRecovery()) renderBilling();
    if (!libraryKey()) {
      const closed = window.StillnessStudio?.lockLibrary?.();
      if (closed && visiblePage === 'studio') showProfile(libraryLocked);
      return;
    }
    const untilEnd = Date.parse(snapshot.member.period_ends_at) - Date.now();
    const delay = Math.min(Math.max(untilEnd, 0) + 1, 2_147_483_647);
    entitlementTimer = window.setTimeout(() => {
      refreshEntitlement();
      void refreshAccount().catch(() => {});
    }, delay);
  }

  async function apiRequest(path, payload) {
    const options = { credentials: 'same-origin', cache: 'no-store' };
    if (payload) {
      options.method = 'POST';
      options.headers = { 'Content-Type': 'application/json' };
      options.body = JSON.stringify(payload);
    }
    const response = await fetch(path, options).catch(() => {
      throw new Error('Stillness couldn’t connect. Check your connection and try again.');
    });
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
    const outOfPremium = hasPaidNarration(member) && remainingSeconds(member) <= 0;
    const canReplayWithoutMinutes = Boolean(libraryKey()) && remainingSeconds(member) <= 0;
    const kokoro = canUseKokoro();
    text('membershipGreeting', accountGreeting(member));
    text('membershipAllowance', outOfPremium ? kokoro
      ? 'Premium minutes used. ' + readableTime(kokoroSeconds(member)) + ' of Kokoro Heart left.'
      : 'You’ve used this month’s premium and Kokoro Heart minutes.' :
      problem || `${readableTime(remainingSeconds(member))} of narration available`);
    byId('beginMeditationBtn').setAttribute('aria-describedby', 'membershipAllowance');
    for (const id of ['beginMeditationBtn', 'beginFromScriptBtn']) {
      byId(id).disabled = Boolean(problem);
      reveal(id, !outOfPremium);
    }
    text('membershipStudioProfile', trialCanStart(member) ? 'View free trial' : 'Open membership settings');
    reveal('membershipStudioOptions', outOfPremium);
    reveal('membershipScriptOptions', outOfPremium);
    text('membershipScriptVoiceBalance', byId('membershipAllowance').textContent);
    for (const button of document.querySelectorAll('[data-start-kokoro]')) {
      button.hidden = !kokoro;
    }
    for (const shortcut of document.querySelectorAll('[data-library-shortcut]')) {
      shortcut.hidden = !canReplayWithoutMinutes;
    }
    if (!canUseKokoro()) reveal('membershipPlayerOptions', false);
    reveal('membershipStudioProfile', !outOfPremium && Boolean(problem) && Boolean(snapshot.user));
    reveal('membershipScriptProfile', !outOfPremium && Boolean(problem) && Boolean(snapshot.user));
    reveal('memberAdminButton', snapshot.owner === true);
    reveal('memberWelcomeAdminButton', snapshot.owner === true);
  }

  function renderBilling() {
    const member = snapshot.member;
    const eligible = memberIsActive(member);
    const trial = eligible && member.status === 'trialing';
    const paid = eligible && member.status === 'active';
    const stripeTrial = trial && member.has_subscription;
    const canStart = trialCanStart(member);
    const paymentPending = ['past_due', 'incomplete', 'unpaid'].includes(member?.status);
    const hasBilling = Boolean(member?.billing_customer || member?.has_subscription);
    const endDate = readableDate(member?.period_ends_at);

    text('memberPlanStatus', describePlan(member));
    text('memberPlanDate', eligible && endDate
      ? trial ? `Trial ends ${endDate}.`
        : member.cancel_at_period_end ? `Access ends ${endDate}.` : `Included minutes reset ${endDate}.`
      : '');
    text('memberPlanDescription', trial
      ? stripeTrial ? 'Manage your trial and renewal in billing.' : 'Your trial includes 15 narrated minutes and ends automatically.'
      : paid
        ? 'Each billing period includes 120 premium narration minutes and 60 Kokoro Heart minutes.'
        : canStart
          ? trialOffer
          : 'Subscribe for 120 premium narration minutes and 60 Kokoro Heart minutes per month.');
    reveal('memberBalance', eligible || Number(member?.topup_seconds) > 0);
    text('memberIncluded', readableTime(eligible ? member.remaining_seconds : 0));
    text('memberTopupLeft', readableTime(member?.topup_seconds));
    text('memberKokoroLeft', readableTime(kokoroSeconds(member)));
    byId('memberKokoroLeft').parentElement.hidden = !paid;
    byId('memberTopupLeft').parentElement.hidden = trial && !member.topup_seconds;

    reveal('memberStartTrial', canStart);
    const subscribe = byId('memberSubscribe');
    subscribe.className = canStart || trial ? 'text-action member-inline' : 'main-button';
    reveal('memberSubscribe', !paid && !stripeTrial && !(paymentPending && hasBilling));
    reveal('memberTopup', paid);
    reveal('memberPortal', hasBilling);
  }

  function renderWelcome() {
    const member = snapshot.member;
    const ready = Boolean(member?.name && member?.goal && trialCanStart(member));
    reveal('memberWelcomeForm', !ready);
    reveal('memberWelcomeTrial', ready);
    text('memberWelcomeTrialTerms', trialOffer);
    text('memberWelcomeTitle', ready ? 'Start your free trial' : 'Make it yours');
    text('memberWelcomeLead', ready ? accountGreeting(member) : 'Choose what you want to make more room for.');
  }

  function showPage(page, { focus = true } = {}) {
    visiblePage = page;
    if (page === 'login') renderOAuthOptions();
    if (page === 'welcome') renderWelcome();
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
      signup: ['Create your account', 'Choose how you’d like to sign up.', 'Create account'],
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
    renderOAuthOptions();
  }

  function renderOAuthOptions() {
    reveal('memberOAuth', ['login', 'signup'].includes(authMode));
    byId('memberOAuthGoogle').disabled = oauthPending || !googleAvailable;
    text('memberOAuthNotice', oauthNotice);
  }

  async function loadOAuthOptions() {
    try {
      const options = await apiRequest(`${accountPath}?view=providers`);
      googleAvailable = options.google === true;
      oauthNotice = googleAvailable ? '' : 'Google sign-in is currently unavailable. You can continue with email.';
    } catch {
      oauthNotice = 'Couldn’t check Google sign-in. You can continue with email.';
    }
    renderOAuthOptions();
  }

  async function signInWithGoogle() {
    if (oauthPending || !googleAvailable) return;
    oauthPending = true;
    text('memberAuthFeedback', '');
    renderOAuthOptions();
    try {
      const result = await apiRequest(accountPath, { action: 'oauth', provider: 'google' });
      const destination = new URL(result.url);
      if (destination.protocol !== 'https:' || destination.pathname !== '/auth/v1/authorize'
          || destination.searchParams.get('provider') !== 'google') {
        throw new Error('Stillness couldn’t open Google sign-in. Try again.');
      }
      window.location.assign(destination.href);
    } catch (error) {
      oauthPending = false;
      renderOAuthOptions();
      text('memberAuthFeedback', error.message || 'Stillness couldn’t open Google sign-in. Try again.');
    }
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
    if (snapshot.user && !isRecovery()) void attributeCampaign();
    if (isRecovery() && authMode !== 'recovery') setAuthMode('recovery');
    if (!isRecovery() && authMode === 'recovery') setAuthMode('login');
    refreshEntitlement();
    const page = recommendedPage();
    const ownerAccessRevoked = visiblePage === 'admin' && !snapshot.owner;
    if (ownerAccessRevoked) {
      byId('memberAdminList').replaceChildren();
      byId('memberAdminActivityList').replaceChildren();
      byId('memberAdminEmailForm').reset();
      reveal('memberAdminPreviewPanel', false);
      ownerTemplates = [];
    }
    const trialAlreadyStarted = visiblePage === 'welcome' && page === 'studio' && !trialCanStart(snapshot.member);
    if (navigate || visiblePage === 'loading' || ownerAccessRevoked || trialAlreadyStarted ||
        page === 'login' && visiblePage !== 'login') {
      showPage(page, { focus: navigate || trialAlreadyStarted });
    }
    if (profileRequested && page === 'studio') {
      profileRequested = false;
      try { window.sessionStorage.removeItem('stillness-open-profile'); } catch {}
      showProfile();
    }
  }

  function attributeCampaign() {
    if (campaignRequest) return campaignRequest;
    let source;
    try { source = sessionStorage.getItem(campaignKey); } catch { return; }
    if (!source) return;
    campaignRequest = apiRequest(accountPath, { action: 'campaign-source', source }).then(() => {
      try { sessionStorage.removeItem(campaignKey); } catch {}
    }).catch(() => {}).finally(() => { campaignRequest = null; });
    return campaignRequest;
  }

  async function recordCompletedSession() {
    if (!snapshot.user || reportedSession === snapshot.user.id) return;
    const id = snapshot.user.id;
    reportedSession = id;
    try {
      await attributeCampaign();
      if (snapshot.user?.id === id) await apiRequest(accountPath, { action: 'campaign-session' });
    } catch {
      if (reportedSession === id) reportedSession = null;
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
    if (path === '/api/tts' || path === '/api/kokoro') {
      const included = response.headers.get('X-Stillness-Remaining-Seconds');
      const extra = response.headers.get('X-Stillness-Topup-Seconds');
      const kokoro = response.headers.get('X-Stillness-Kokoro-Seconds');
      if (snapshot.user?.id === requestedBy && snapshot.member && included !== null && extra !== null) {
        const amounts = [Number(included), Number(extra)];
        if (amounts.every(value => Number.isSafeInteger(value) && value >= 0)) {
          snapshot.member = { ...snapshot.member, remaining_seconds: amounts[0], topup_seconds: amounts[1] };
          if (kokoro !== null && Number.isSafeInteger(Number(kokoro)) && Number(kokoro) >= 0) {
            snapshot.member.kokoro_remaining_seconds = Number(kokoro);
          }
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
    const fromWelcome = event.currentTarget.id === 'memberWelcomeForm';
    const { name, goal, customGoal, marketingEmail } = dataFrom(event.currentTarget);
    const selectedGoal = goal === 'custom' ? customGoal.trim() : goal;
    await withButton(event.submitter, feedbackId, async () => {
      if (!name.trim() || !selectedGoal) throw new Error('Enter your name and choose a goal.');
      accountRevision++;
      const details = { action: 'profile', name: name.trim(), goal: selectedGoal };
      if (fromWelcome && marketingEmail === 'on') details.marketingEmail = true;
      const result = await apiRequest(accountPath, details);
      const next = result.user ? result : await apiRequest(accountPath);
      applySnapshot(next, { navigate: fromWelcome && !trialCanStart(next.member) });
      if (fromWelcome && visiblePage === 'welcome') {
        showPage('welcome');
        return;
      }
      text(feedbackId, 'Your details are saved.');
    });
  }

  async function submitEmailPreference(event) {
    event.preventDefault();
    const enabled = byId('memberMarketingEmail').checked;
    await withButton(event.submitter, 'memberEmailSettingsFeedback', async () => {
      accountRevision++;
      applySnapshot(await apiRequest(accountPath, { action: 'email-preference', enabled }));
      text('memberEmailSettingsFeedback', 'Your email preference is saved.');
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
    text('memberEmailSettingsFeedback', '');
    byId('memberMarketingEmail').checked = snapshot.member?.marketing_email_opt_in === true;
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

  async function startTrial(button) {
    if (!trialCanStart(snapshot.member)) return;
    const fromWelcome = visiblePage === 'welcome';
    const feedback = fromWelcome ? 'memberWelcomeFeedback' : 'memberBillingFeedback';
    await withButton(button, feedback, async () => {
      accountRevision++;
      let result;
      try {
        await attributeCampaign();
        result = await apiRequest(accountPath, { action: 'trial' });
      } catch (error) {
        void refreshAccount().catch(() => {});
        throw error;
      }
      if (!memberIsActive(result.member) || result.member.status !== 'trialing') {
        throw new Error('Stillness couldn’t confirm the trial. Check your membership and try again.');
      }
      applySnapshot(result, { navigate: fromWelcome });
      if (visiblePage === 'profile') {
        text('memberBillingFeedback', 'Your free trial has started. There’s no charge.');
        byId('memberPlanStatus').focus();
      }
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
    if (!byId('memberAdminAlerts')) {
      byId('memberAdminEmailTab').insertAdjacentHTML('afterend',
        '<button id="memberAdminAlertsTab" type="button" class="text-action" aria-controls="memberAdminAlerts" aria-pressed="false">Alerts</button>');
      byId('memberAdminEmail').insertAdjacentHTML('beforebegin', `
        <section id="memberAdminAlerts" aria-label="Owner alerts" hidden>
          <p id="memberAdminAlertsSummary" class="member-detail"></p>
          <p id="memberAdminAlertsFeedback" class="notice" role="status"></p>
          <form id="memberAdminCreditForm" class="member-form">
            <label>Available Gemini credits (USD)
              <input id="memberAdminCreditBalance" type="number" min="0" max="10000" step="0.01" required>
            </label>
            <a id="memberAdminGeminiBilling" class="text-action member-inline" href="https://aistudio.google.com/projects" target="_blank" rel="noopener noreferrer">View live Gemini balance ↗</a>
            <p class="member-detail">Use the Stillness Google account to see the prepaid balance or add credits. Enter the balance shown by Google after a top-up. Stillness estimates the balance between updates.</p>
            <button type="submit" class="main-button">Save balance</button>
          </form>
          <button id="memberAdminAlertTest" class="text-action member-inline" type="button">Send test email</button>
        </section>
      `);
      byId('memberAdminAlertsTab').addEventListener('click', () => showAdminSection('alerts'));
      byId('memberAdminCreditForm').addEventListener('submit', event => {
        event.preventDefault();
        const dollars = byId('memberAdminCreditBalance').valueAsNumber;
        ownerAlertAction({ action: 'admin-credit-save', cents: Math.round(dollars * 100) });
      });
      byId('memberAdminAlertTest').addEventListener('click', () => ownerAlertAction({ action: 'admin-alert-test' }));
    }
    showPage('admin');
    await showAdminSection('users');
  }

  async function showAdminSection(section) {
    if (!snapshot.owner) return;
    const emails = section === 'email';
    const users = section === 'users';
    const alerts = section === 'alerts';
    const publishing = section === 'publishing';
    byId('memberAdminUsersTab').setAttribute('aria-pressed', String(users));
    byId('memberAdminEmailTab').setAttribute('aria-pressed', String(emails));
    byId('memberAdminAlertsTab').setAttribute('aria-pressed', String(alerts));
    byId('memberAdminPublishingTab').setAttribute('aria-pressed', String(publishing));
    reveal('memberAdminUsers', users);
    reveal('memberAdminEmail', emails);
    reveal('memberAdminAlerts', alerts);
    reveal('memberAdminPublishing', publishing);
    if (alerts) {
      await ownerAlertAction();
      return;
    }
    if (users) {
      await searchOwnerMembers();
      return;
    }
    if (publishing) {
      await loadOwnerActivity(true);
      return;
    }
    text('memberAdminEmailFeedback', 'Loading emails…');
    reveal('memberAdminEmailForm', false);
    reveal('memberAdminActivity', false);
    reveal('memberAdminPreviewPanel', false);
    try {
      const result = await apiRequest(accountPath + '?view=admin-email');
      if (!snapshot.owner || visiblePage !== 'admin') return;
      renderOwnerEmails(result);
      text('memberAdminEmailFeedback', '');
    } catch (error) {
      text('memberAdminEmailFeedback', error.message);
    }
  }

  async function ownerAlertAction(body) {
    if (!snapshot.owner) return;
    const form = byId('memberAdminCreditForm');
    const test = byId('memberAdminAlertTest');
    const input = byId('memberAdminCreditBalance');
    const submit = form.querySelector('button[type="submit"]');
    if (submit.disabled) return;
    submit.disabled = true;
    test.disabled = true;
    text('memberAdminAlertsFeedback', body ? 'Working…' : 'Loading alerts…');
    try {
      const result = body
        ? await apiRequest(accountPath, body)
        : await apiRequest(accountPath + '?view=admin-alerts');
      if (!snapshot.owner || visiblePage !== 'admin') return;
      if (typeof result.billingUrl === 'string' && result.billingUrl.startsWith('https://aistudio.google.com/')) {
        byId('memberAdminGeminiBilling').href = result.billingUrl;
      }
      if (result.credit) {
        const credit = result.credit;
        const money = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
        const estimate = credit.available === null ? 'Enter your Google AI Studio balance to enable early warnings.'
          : `Estimated balance ${money(credit.available)}. Credit target ${money(credit.target)} for ${credit.members} active accounts.`;
        input.value = credit.recorded === null ? '' : (credit.recorded / 100).toFixed(2);
        text('memberAdminAlertsSummary', [estimate, result.email ? 'Alerts go to ' + result.email + '.' : 'Email delivery needs setup.'].join(' '));
      }
      text('memberAdminAlertsFeedback', result.message || (body ? 'Balance saved.' : ''));
    } catch (error) {
      text('memberAdminAlertsFeedback', error.message);
    } finally {
      submit.disabled = false;
      test.disabled = false;
    }
  }

  async function searchOwnerMembers(event) {
    event?.preventDefault();
    ownerOffset = 0;
    ownerSearch = byId('memberAdminSearch').value.trim();
    byId('memberAdminList').replaceChildren();
    await loadOwnerMembers(true);
  }

  async function loadOwnerActivity(reset = false) {
    const button = byId('memberAdminPublishingMore');
    const panel = byId('memberAdminPublishing');
    if (!snapshot.owner || panel.hidden || (!reset && (button.disabled || ownerActivityBefore === null))) return;
    const load = ++ownerActivityLoad;
    const list = byId('memberAdminPublishingList');
    if (reset) {
      ownerActivityBefore = null;
      list.replaceChildren();
    }
    button.disabled = true;
    reveal('memberAdminPublishingMore', false);
    text('memberAdminPublishingStatus', 'Loading activity…');
    try {
      const before = ownerActivityBefore === null ? '' : '&before=' + ownerActivityBefore;
      const { entries, nextBefore } = await apiRequest(accountPath + '?view=admin-activity' + before);
      if (load !== ownerActivityLoad || !snapshot.owner || visiblePage !== 'admin' || panel.hidden) return;
      ownerActivityBefore = Number.isSafeInteger(nextBefore) ? nextBefore : null;
      for (const entry of entries) {
        const row = document.createElement('article');
        row.className = 'member-admin-row';
        const heading = document.createElement('h3');
        heading.textContent = entry.title;
        if (typeof entry.url === 'string' && entry.url.startsWith('https://')) {
          const link = document.createElement('a');
          link.href = entry.url;
          link.rel = 'noopener noreferrer';
          link.target = '_blank';
          link.textContent = entry.title + ' ↗';
          heading.replaceChildren(link);
        }
        const meta = document.createElement('p');
        const stamp = document.createElement('time');
        const date = new Date(entry.occurred_at);
        stamp.dateTime = entry.time_known ? date.toISOString() : date.toISOString().slice(0, 10);
        stamp.textContent = entry.time_known
          ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
          : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' }).format(date);
        if (!entry.time_known) stamp.title = 'Exact time unavailable';
        meta.append(entry.platform + ' · ' + entry.action + ' · ', stamp);
        row.append(heading, meta);
        list.append(row);
      }
      text('memberAdminPublishingStatus', list.childElementCount ? '' : 'No publishing activity yet.');
    } catch (error) {
      if (load === ownerActivityLoad) text('memberAdminPublishingStatus', error.message);
    } finally {
      if (load === ownerActivityLoad) {
        button.disabled = false;
        reveal('memberAdminPublishingMore', ownerActivityBefore !== null && snapshot.owner && !panel.hidden);
      }
    }
  }

  async function loadOwnerMembers(replace = false) {
    const next = byId('memberAdminMore');
    if (!snapshot.owner || ownerOffset === null || (next.disabled && !replace)) return;
    const loadId = ++ownerMemberLoad;
    const list = byId('memberAdminList');
    next.disabled = true;
    reveal('memberAdminMore', false);
    text('memberAdminFeedback', 'Loading members…');
    try {
      const { members, nextOffset } = await apiRequest(`${accountPath}?view=admin&offset=${ownerOffset}&search=${encodeURIComponent(ownerSearch)}`);
      if (!snapshot.owner || visiblePage !== 'admin' || loadId !== ownerMemberLoad) return;
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
        const ending = memberIsActive(member) ? readableDate(member.period_ends_at) : '';
        usage.textContent = [describePlan(member), readableTime(remainingSeconds(member)) + ' left',
          readableTime(member.voice_seconds_used) + ' used', ending && 'Access through ' + ending].filter(Boolean).join(' · ');
        const account = document.createElement('p');
        account.textContent = ['Joined ' + readableDate(member.created_at), lastUsed && 'Last used ' + lastUsed,
          member.marketing_email_opt_in ? 'Marketing emails on' : 'Marketing emails off'].filter(Boolean).join(' · ');
        row.append(name, email, usage, account);
        list.append(row);
      }
    } catch (error) {
      if (loadId === ownerMemberLoad) text('memberAdminFeedback', error.message);
    } finally {
      if (loadId === ownerMemberLoad) {
        next.disabled = false;
        reveal('memberAdminMore', ownerOffset !== null && snapshot.owner === true && visiblePage === 'admin');
      }
    }
  }

  function renderOwnerTemplate() {
    const template = ownerTemplates.find(item => item.kind === byId('memberAdminTemplate').value);
    if (!template) return;
    byId('memberAdminEmailSubject').value = template.subject;
    byId('memberAdminEmailBody').value = template.body;
    text('memberAdminTemplateWhen', template.when);
    text('memberAdminEmailFieldsHelp', 'Available placeholders ' + template.variables.map(key => '{{' + key + '}}').join(', ') +
      '. Stillness adds the greeting, signature, and any required unsubscribe information.');
    byId('memberAdminEmailReset').disabled = !template.custom;
    reveal('memberAdminPreviewPanel', false);
  }

  function renderOwnerEmails({ templates, activity, sending }, selected) {
    ownerTemplates = templates;
    const select = byId('memberAdminTemplate');
    select.replaceChildren(...templates.map(template => {
      const option = document.createElement('option');
      option.value = template.kind;
      option.textContent = template.label;
      return option;
    }));
    if (selected) select.value = selected;
    const sendingStatus = sending.mode === 'off' ? 'Sending is off. A verified sender is required.'
      : sending.mode === 'beta' ? 'Sending is limited to invited testers.'
        : sending.offers ? 'Sending is on, including subscription follow-ups.' : 'Trial emails are on. Subscription follow-ups are off.';
    text('memberAdminEmailStatus', sendingStatus);
    renderOwnerTemplate();
    reveal('memberAdminEmailForm', true);

    const list = byId('memberAdminActivityList');
    list.replaceChildren();
    const labels = { accepted: 'Accepted by email provider', failed: 'Failed', unconfirmed: 'Send unconfirmed',
      processing: 'Processing', skipped: 'Skipped', expired: 'Expired', queued: 'Queued', scheduled: 'Scheduled' };
    for (const job of activity) {
      const label = templates.find(template => template.kind === job.kind)?.label || job.kind;
      const row = document.createElement('p');
      row.className = 'admin-activity-row';
      const date = readableDate(job.attempted_at || job.due_at);
      row.textContent = [label, job.email, labels[job.status] || job.status, date].join(' · ');
      list.append(row);
    }
    if (!activity.length) list.textContent = 'No trial email activity yet.';
    reveal('memberAdminActivity', true);
  }

  async function editOwnerEmail(action) {
    const fields = byId('memberAdminEmailFields');
    if (!snapshot.owner || fields.disabled) return;
    const kind = byId('memberAdminTemplate').value;
    const subject = byId('memberAdminEmailSubject').value;
    const body = byId('memberAdminEmailBody').value;
    fields.disabled = true;
    text('memberAdminEmailFeedback', '');
    try {
      const result = await apiRequest(accountPath, { action: 'admin-email-' + action, kind, subject, body });
      if (!snapshot.owner || visiblePage !== 'admin') return;
      if (action === 'preview') {
        text('memberAdminPreviewSubject', result.preview.subject);
        text('memberAdminPreviewText', result.preview.text);
        byId('memberAdminPreviewFrame').srcdoc = result.preview.html;
        reveal('memberAdminPreviewPanel', true);
        return;
      }
      renderOwnerEmails(result, kind);
      text('memberAdminEmailFeedback', action === 'reset' ? 'Default message restored.' : 'Email template saved.');
    } catch (error) {
      text('memberAdminEmailFeedback', error.message);
    } finally {
      fields.disabled = false;
    }
  }

  function consumeReturnUrl() {
    const url = new URL(window.location.href);
    profileRequested = url.searchParams.get('view') === 'profile';
    try {
      if (profileRequested) window.sessionStorage.setItem('stillness-open-profile', '1');
      profileRequested ||= window.sessionStorage.getItem('stillness-open-profile') === '1';
    } catch {}
    if (url.searchParams.get('view') === 'profile') url.searchParams.delete('view');
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
      if (redirect.code && ['signup', 'recovery', 'oauth'].includes(redirect.flow)) {
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
        const retryMessage = redirect.flow === 'oauth'
          ? 'Sign-in was canceled or couldn’t finish. Try again from this page.'
          : 'This link has expired. Return to this same browser and ask for a new email.';
        text('memberAuthFeedback', callbackError || retryMessage);
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
    const campaign = new URLSearchParams(location.search);
    const source = campaign.get('utm_source');
    if (campaign.get('utm_campaign') === 'bedtime' && ['youtube', 'instagram', 'stillness_sample'].includes(source)) {
      try { sessionStorage.setItem(campaignKey, source); } catch {}
    }
    if (campaign.get('entry') === 'signup' && !['code', 'flow', 'error', 'password'].some(key => campaign.has(key))) {
      setAuthMode('signup');
    }
    if ('BroadcastChannel' in window) {
      channel = new BroadcastChannel('stillness-account');
      channel.addEventListener('message', () => refreshAccount().catch(() => {}));
    }
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && visiblePage !== 'loading') {
        refreshEntitlement();
        void refreshAccount().catch(() => {});
      }
    });
    byId('memberRetry').addEventListener('click', () => loadMembership());
    byId('memberAuthForm').addEventListener('submit', submitAuth);
    byId('memberOAuthGoogle').addEventListener('click', signInWithGoogle);
    window.addEventListener('pageshow', event => {
      if (event.persisted) {
        oauthPending = false;
        renderOAuthOptions();
        refreshEntitlement();
        void refreshAccount().catch(() => {});
      }
    });
    byId('memberAuthSwitch').addEventListener('click', () => setAuthMode(authMode === 'login' ? 'signup' : 'login'));
    byId('memberAuthForgot').addEventListener('click', () => setAuthMode('forgot'));
    byId('memberResend').addEventListener('click', () => setAuthMode('resend'));
    byId('memberWelcomeForm').addEventListener('submit', event => submitProfile(event, 'memberWelcomeFeedback'));
    byId('memberProfileForm').addEventListener('submit', event => submitProfile(event, 'memberProfileFeedback'));
    byId('memberEmailSettingsForm').addEventListener('submit', submitEmailPreference);
    byId('memberPasswordForm').addEventListener('submit', submitPassword);
    byId('memberBack').addEventListener('click', () => showPage(recommendedPage()));
    for (const prefix of ['Welcome', 'Profile']) byId(`member${prefix}Goal`).addEventListener('change', () => syncCustomGoal(prefix));
    for (const button of document.querySelectorAll('[data-member-logout]')) button.addEventListener('click', () => signOut(button));
    for (const id of ['memberWelcomeStartTrial', 'memberStartTrial']) {
      byId(id).addEventListener('click', event => startTrial(event.currentTarget));
    }
    byId('memberWelcomeLater').addEventListener('click', () => showPage('studio'));
    for (const button of document.querySelectorAll('[data-billing]')) button.addEventListener('click', () => billingAction(button));
    for (const button of document.querySelectorAll('[data-buy-voice-time]')) button.addEventListener('click', () => {
      showProfile();
      void billingAction(byId('memberTopup'));
    });
    for (const button of document.querySelectorAll('[data-member-profile]')) button.addEventListener('click', () => showProfile());
    byId('memberAdminButton').addEventListener('click', renderOwner);
    byId('memberWelcomeAdminButton').addEventListener('click', renderOwner);
    byId('memberAdminMore').addEventListener('click', () => loadOwnerMembers());
    byId('memberAdminSearchForm').addEventListener('submit', searchOwnerMembers);
    byId('memberAdminUsersTab').addEventListener('click', () => showAdminSection('users'));
    byId('memberAdminEmailTab').addEventListener('click', () => showAdminSection('email'));
    byId('memberAdminPublishingTab').addEventListener('click', () => showAdminSection('publishing'));
    byId('memberAdminPublishingMore').addEventListener('click', () => loadOwnerActivity());
    byId('memberAdminTemplate').addEventListener('change', renderOwnerTemplate);
    byId('memberAdminEmailForm').addEventListener('submit', event => {
      event.preventDefault();
      void editOwnerEmail(event.submitter?.value === 'preview' ? 'preview' : 'save');
    });
    byId('memberAdminEmailReset').addEventListener('click', () => editOwnerEmail('reset'));
    void loadMembership(consumeReturnUrl());
    void loadOAuthOptions();
  }

  window.StillnessMembership = {
    canGenerate,
    recordCompletedSession,
    canUseKokoro,
    libraryKey,
    generationProblem,
    requestGeneration,
    generationDenial: () => pendingGenerationProblem,
    openLibraryProfile: () => showProfile(libraryLocked),
    openGenerationProfile() {
      showProfile(pendingGenerationProblem || generationProblem());
    }
  };
  window.addEventListener('DOMContentLoaded', initMembership);
})();

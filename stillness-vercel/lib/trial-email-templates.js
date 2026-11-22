const dateFormat = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC',
});

const templates = {
  welcome: {
    label: 'Welcome', when: 'After a verified signup if the trial hasn’t started',
    subject: 'Welcome to Stillness',
    body: 'When you’re ready, set aside a few quiet minutes. Start your free trial in Stillness.\n{{app_url}}',
    variables: ['app_url'],
  },
  started: {
    label: 'Trial started', when: 'When a member starts the free trial',
    subject: 'Your Stillness trial has started',
    body: 'You have 15 narrated minutes over 10 days. Your trial ends on {{trial_end}}. No card is needed and you won’t be charged automatically.\n\nStart a session\n{{app_url}}',
    variables: ['trial_end', 'app_url'],
  },
  reminder: {
    label: 'Trial ending soon', when: 'Scheduled two days before the trial ends',
    subject: 'Your Stillness trial ends soon',
    body: 'Your trial ends on {{trial_end}}. You have {{minutes_left}} of narrated time left. Access to your saved sessions pauses when the trial ends.\n\nOpen Stillness\n{{app_url}}',
    variables: ['trial_end', 'minutes_left', 'app_url'],
  },
  ended: {
    label: 'Trial ended', when: 'When a regular trial ends',
    subject: 'Your Stillness trial has ended',
    body: 'Your trial has ended and access to your saved sessions is paused. No payment was taken.',
    variables: ['trial_end', 'app_url'],
  },
  'ended-beta': {
    label: 'Beta feedback', when: 'When an invited tester’s trial ends',
    subject: 'Your Stillness trial has ended',
    body: 'Your trial has ended and access to your saved sessions is paused. No payment was taken.\n\nFeel free to reply with feedback about how your sessions went.',
    variables: ['trial_end', 'app_url'],
  },
  offer: {
    label: 'Subscription follow-up', when: 'Scheduled three days after the trial for opted-in members',
    subject: 'Continue with Stillness',
    body: 'If you’d like to keep using Stillness and regain access to your saved sessions, you can view the membership plan from your profile.\n{{profile_url}}',
    variables: ['profile_url', 'app_url'],
  },
};

const placeholder = /\{\{\s*([a-z_]+)\s*\}\}/g;

export function knownEmailTemplate(kind) {
  return typeof kind === 'string' && Object.hasOwn(templates, kind);
}

export function validateEmailTemplate({ kind, subject, body }) {
  if (!knownEmailTemplate(kind) || typeof subject !== 'string' || typeof body !== 'string') return null;
  const headline = subject.trim();
  const message = body.replace(/\r\n/g, '\n').trim();
  if (!headline || !message || headline.length > 150 || message.length > 8000 ||
      /[\u0000-\u001f\u007f]/.test(headline) || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(message) ||
      /\{\{|\}\}/.test(headline)) return null;
  const allowed = templates[kind].variables;
  if (Array.from(message.matchAll(placeholder)).some(match => !allowed.includes(match[1])) ||
      /\{\{|\}\}/.test(message.replace(placeholder, ''))) return null;
  return { kind, subject: headline, body: message };
}

export function listEmailTemplates(overrides) {
  return Object.entries(templates).map(([kind, defaults]) => {
    const override = overrides.find(item => item.kind === kind);
    return { kind, ...defaults, ...override, custom: Boolean(override) };
  });
}

export function renderEmailTemplate(job, config) {
  const kind = job.kind === 'ended' && config.mode === 'beta' ? 'ended-beta' : job.kind;
  const candidate = job.template && validateEmailTemplate({ ...job.template, kind });
  const { subject, body } = candidate || templates[kind];
  const url = config.origin + '/';
  const seconds = Math.max(0, job.remaining_seconds || 0);
  const values = {
    app_url: url,
    profile_url: url + '?view=profile',
    trial_end: job.trial_ends_at ? dateFormat.format(new Date(job.trial_ends_at)) + ' UTC' : '',
    minutes_left: Math.floor(seconds / 60) + ' min ' + (seconds % 60) + ' sec',
  };
  const name = job.name?.replace(/[\r\n]/g, ' ');
  const greeting = name ? 'Hi ' + name + ',' : 'Hi there,';
  return { subject, text: greeting + '\n\n' + body.replace(placeholder, (_, key) => values[key]) + '\n\nStillness' };
}

export function previewEmailTemplate(template, origin) {
  const beta = template.kind === 'ended-beta';
  const preview = renderEmailTemplate({
    kind: beta ? 'ended' : template.kind, name: 'Taylor', trial_ends_at: '2026-12-02T09:00:00Z',
    remaining_seconds: 410, template,
  }, { origin, mode: beta ? 'beta' : 'launch' });
  if (template.kind === 'offer') preview.text += '\n\n[Unsubscribe link and business mailing address]';
  return preview;
}

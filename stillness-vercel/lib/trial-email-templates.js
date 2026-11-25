import { brandedEmail } from './branded-email.js';

const dateFormat = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC',
});

const templates = {
  welcome: {
    label: 'Welcome', when: 'After a verified signup if the trial hasn’t started',
    subject: 'Welcome to Stillness',
    body: 'Take a few minutes for whatever’s on your mind. Tell Stillness what you need today, then choose how long you’d like to sit.\n\nYour free trial is ready when you are. No card is needed.\n{{app_url}}',
    variables: ['app_url'],
  },
  started: {
    label: 'Trial started', when: 'When a member starts the free trial',
    subject: 'Your Stillness trial has started',
    body: 'Your trial is underway. You have 15 narrated minutes to make a few sessions of your own over the next 10 days.\n\nYour trial ends on {{trial_end}}. No card is needed, and you won’t be charged automatically.\n{{app_url}}',
    variables: ['trial_end', 'app_url'],
  },
  reminder: {
    label: 'Trial ending soon', when: 'Scheduled two days before the trial ends',
    subject: 'Your Stillness trial ends soon',
    body: 'If you’d like another quiet moment this week, you have {{minutes_left}} of narrated time left. Your trial ends on {{trial_end}}, and access to your saved sessions pauses then.\n{{app_url}}',
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

export function renderEmailTemplate(job, config, footer) {
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
  const message = body.replace(placeholder, (_, key) => values[key]);
  const appAction = { welcome: 'Start your free trial', started: 'Start a session' }[kind] || 'Open Stillness';
  const unsubscribe = footer ? '\n\nUnsubscribe from Stillness offers\n' +
    [footer.unsubscribeUrl, footer.postalAddress].filter(Boolean).join('\n') : '';
  return {
    subject,
    text: greeting + '\n\n' + message + '\n\nStillness' + unsubscribe,
    html: brandedEmail({
      subject, greeting, origin: config.origin, body: message, footer,
      actions: { [values.app_url]: appAction, [values.profile_url]: 'View membership' },
    }),
  };
}

export function previewEmailTemplate(template, origin) {
  const beta = template.kind === 'ended-beta';
  return renderEmailTemplate({
    kind: beta ? 'ended' : template.kind, name: 'Taylor', trial_ends_at: '2026-12-02T09:00:00Z',
    remaining_seconds: 410, template,
  }, { origin, mode: beta ? 'beta' : 'launch' },
    template.kind === 'offer' ? { postalAddress: '[Business mailing address]' } : undefined);
}

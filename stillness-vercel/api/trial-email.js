import { setEmailPreference } from '../lib/member-store.js';
import { deliverTrialEmails, emailConfig, secureMatch, tokenMember } from '../lib/trial-email.js';

function preferencePage(res, status, title, message, button = '') {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(status).send('<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>' + title + ' · Stillness</title>' +
    '<style>body{margin:12vh auto;padding:0 24px;max-width:32rem;background:#191612;color:#ece4d7;font:1rem/1.6 system-ui}button{font:inherit;padding:.65rem 1rem}</style>' +
    '</head><body><main><h1>' + title + '</h1><p>' + message + '</p>' + button + '</main></body></html>');
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const secret = process.env.CRON_SECRET?.trim();
  const token = req.query?.token;
  if (token !== undefined && ['GET', 'POST'].includes(req.method)) {
    const member = secret && secret.length >= 32 ? tokenMember(token, secret) : null;
    if (!member) return preferencePage(res, 400, 'Link unavailable', 'You can change email preferences from your Stillness profile.');
    if (req.method === 'GET') {
      return preferencePage(res, 200, 'Email preferences', 'Unsubscribe from offers and product updates from Stillness.',
        '<form method="post"><button type="submit">Unsubscribe</button></form>');
    }
    try {
      await setEmailPreference(member, false);
      return preferencePage(res, 200, 'You’re unsubscribed', 'Stillness will continue to send account and trial notices.');
    } catch {
      return preferencePage(res, 503, 'Try again', 'We couldn’t save your preference. Please try again.');
    }
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  if (!secret || secret.length < 32 || !secureMatch(req.headers?.authorization, 'Bearer ' + secret)) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  const config = emailConfig();
  if (!config) return res.status(200).json({ enabled: false });
  try {
    const result = await deliverTrialEmails({ config });
    return res.status(200).json({ enabled: true, ...result });
  } catch {
    return res.status(503).json({ error: 'Trial emails could not be processed.' });
  }
}

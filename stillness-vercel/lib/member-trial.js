import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { readCookie, writeCookie } from './member-auth.js';

const deviceCookie = 'stillness_trial_device';
const deviceTtl = 180 * 24 * 60 * 60;

function keyedHash(purpose, value, encoding = 'hex') {
  const secret = process.env.MEMBERS_COOKIE_SECRET;
  if (!secret || secret.length < 32) throw new Error('Trial signing secret is missing.');
  return createHmac('sha256', secret).update(`stillness-trial:${purpose}:${value}`).digest(encoding);
}

function readDevice(req, res) {
  const [id, signature, extra] = readCookie(req, deviceCookie).split('.');
  if (!extra && /^[\w-]{22}$/.test(id || '') && /^[\w-]{43}$/.test(signature || '')) {
    const expected = keyedHash('proof', id, 'base64url');
    if (timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return id;
  }
  const fresh = randomBytes(16).toString('base64url');
  writeCookie(req, res, deviceCookie, `${fresh}.${keyedHash('proof', fresh, 'base64url')}`, deviceTtl);
  return fresh;
}

function networkPrefix(req) {
  // Vercel supplies this header at the edge. Do not trust a client-supplied forwarding chain.
  const isVercel = process.env.VERCEL === '1' || Boolean(process.env.VERCEL_ENV);
  const address = isVercel ? req.headers?.['x-vercel-forwarded-for'] : req.socket?.remoteAddress;
  if (typeof address !== 'string') return null;
  const ip = address.trim();
  const family = isIP(ip);
  if (family === 4) return `v4:${ip}`;
  if (family !== 6) return null;

  const normalized = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(normalized);
  if (mapped) {
    const [high, low] = mapped.slice(1).map(part => Number.parseInt(part, 16));
    return 'v4:' + [high >> 8, high & 255, low >> 8, low & 255].join('.');
  }
  const [start, end] = normalized.split('::');
  const left = start ? start.split(':') : [];
  const right = end ? end.split(':') : [];
  const words = end === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return 'v6/64:' + words.slice(0, 4).join(':');
}

export function trialIdentifiers(req, res) {
  const network = networkPrefix(req);
  if (!network) return null;
  return {
    deviceHash: keyedHash('device', readDevice(req, res)),
    networkHash: keyedHash('network', network)
  };
}

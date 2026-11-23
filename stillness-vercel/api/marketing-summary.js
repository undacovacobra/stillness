import { timingSafeEqual } from 'node:crypto';
import { readMarketingSummary } from '../lib/member-store.js';

export async function GET(request) {
  const headers = { 'Cache-Control': 'private, no-store' };
  const key = process.env.MARKETING_REPORT_KEY;
  const expected = Buffer.from(`Bearer ${key}`);
  const received = Buffer.from(request.headers.get('authorization') || '');
  if (!key || expected.length !== received.length || !timingSafeEqual(expected, received)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401, headers });
  }
  try {
    return Response.json({ periodDays: 7, channels: await readMarketingSummary() }, { headers });
  } catch {
    return Response.json({ error: 'Marketing report unavailable' }, { status: 503, headers });
  }
}

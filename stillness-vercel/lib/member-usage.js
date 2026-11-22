import { randomUUID } from 'node:crypto';
import { fail, requireMember, requireSameOrigin } from './member-auth.js';
import { reserveUsage, settleUsage } from './member-store.js';

function pcmSeconds(bytes, mimeType) {
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE') {
    let dataLength = 0;
    let byteRate = 0;
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const name = bytes.toString('ascii', offset, offset + 4);
      const size = bytes.readUInt32LE(offset + 4);
      if (size > bytes.length - offset - 8) return 0;
      if (name === 'fmt ' && size >= 16) byteRate = bytes.readUInt32LE(offset + 16);
      if (name === 'data') dataLength += size;
      offset += 8 + size + size % 2;
    }
    return byteRate > 0 ? dataLength / byteRate : 0;
  }
  if (!/^audio\/(?:L16|pcm)(?:;|$)/i.test(mimeType || '') || bytes.length % 2) return 0;
  const rate = Number(/(?:^|[; ])rate=(\d+)/i.exec(mimeType)?.[1] || 24000);
  const channels = Number(/(?:^|[; ])channels=(\d+)/i.exec(mimeType)?.[1] || 1);
  return rate >= 8000 && rate <= 48000 && [1, 2].includes(channels) ? bytes.length / (2 * rate * channels) : 0;
}

function renderedSeconds(body) {
  const data = body?.data;
  if (typeof data !== 'string' || data.length === 0 || data.length > 5_900_000) return 0;
  const seconds = pcmSeconds(Buffer.from(data, 'base64'), body.mimeType);
  return Number.isFinite(seconds) && seconds > 0 && seconds <= 240 ? Math.ceil(seconds) : 0;
}

function sendBalance(res, balance) {
  for (const [name, value] of [
    ['X-Stillness-Remaining-Seconds', balance?.remaining_seconds],
    ['X-Stillness-Topup-Seconds', balance?.topup_seconds],
  ]) {
    if (Number.isSafeInteger(value) && value >= 0) res.setHeader(name, String(value));
  }
}

function rejectReserve(res, result) {
  if (result?.reason === 'rate_limited') {
    return fail(res, 429, 'The daily preparation limit has been reached. Try again tomorrow.', 'usage_rate_limited');
  }
  if (result?.reason === 'inactive') {
    return fail(res, 402, 'Start your trial or reactivate your membership to generate a session.', 'membership_required');
  }
  if (result?.reason === 'limit') {
    return fail(res, 402, 'There is not enough narration time left for this request. Try a shorter practice or add minutes.', 'usage_exhausted');
  }
  if (result?.reason === 'duplicate') return fail(res, 409, 'That audio request is already being processed.');
  return fail(res, 503, 'Usage could not be checked. Please try again.');
}

export function withUsage(kind, generation, validate) {
  return async function memberGeneration(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    if (req.method !== 'POST') return fail(res, 405, 'Method not allowed.');
    if (!requireSameOrigin(req, res)) return;
    const member = await requireMember(req, res);
    if (!member) return;
    const invalid = validate(req.body);
    if (invalid) return fail(res, 400, invalid);

    const id = randomUUID();
    const seconds = kind === 'voice' ? 5 + req.body.text.trim().split(/\s+/).length : 0;
    let held = false;
    try {
      const reservation = await reserveUsage(member.id, id, { kind, seconds });
      sendBalance(res, reservation);
      if (!reservation?.allowed) return rejectReserve(res, reservation);
      held = true;
      const headers = {};
      const result = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        setHeader(name, value) { headers[name] = value; },
        json(body) { this.body = body; return this; },
        send(body) { this.body = body; return this; }
      };
      await generation(req, result);
      const success = result.statusCode >= 200 && result.statusCode < 300;
      const used = success && kind === 'voice' ? renderedSeconds(result.body) : 0;
      const charged = await settleUsage(member.id, id, used);
      held = false;
      sendBalance(res, charged);
      if (success && !charged?.accepted) {
        return fail(res, 402, 'There is not enough narration time left for this audio. Add minutes and try again.', 'usage_exhausted');
      }
      if (success && kind === 'voice' && !used) return fail(res, 502, 'The audio could not be read. Please try again.');
      for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
      if (success && kind === 'kokoro') return res.status(result.statusCode).send(result.body);
      return res.status(result.statusCode).json(result.body);
    } catch {
      if (held) await settleUsage(member.id, id, 0).catch(() => null);
      return fail(res, 503, 'Session preparation is temporarily unavailable. Please try again.');
    }
  };
}

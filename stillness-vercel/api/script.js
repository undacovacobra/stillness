import { buildPersonalScriptRequest, parsePersonalScript, validatePersonalScriptRequest } from '../lib/personal-script.js';
import { respondToProviderRateLimit } from '../lib/provider-errors.js';

const unavailable = 'Studio service is temporarily unavailable. Please try again shortly.';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const apiKey = (process.env.GEMINI_API_KEY || process.env.api_key_google || '').trim();
  if (!apiKey) {
    return res.status(503).json({ error: unavailable });
  }
  const body = req.body;
  const structured = body && typeof body === 'object' &&
    ['intention', 'style', 'durationMin', 'chapterCount'].some(key => Object.hasOwn(body, key));
  let input;
  if (structured) {
    try {
      input = validatePersonalScriptRequest(body);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  } else if (!body || Array.isArray(body) || typeof body.prompt !== 'string' || !body.prompt.trim()) {
    return res.status(400).json({ error: 'Missing meditation request' });
  }

  const models = ['gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-2.5-flash'];
  for (const model of models) {
    // A model that rejects schema configuration gets one unconstrained attempt.
    // Its output must still pass the same local chapter validation.
    for (let attempt = 0; attempt < (structured ? 2 : 1); attempt++) {
      try {
        const payload = structured ? buildPersonalScriptRequest(input, attempt === 0) : {
          contents: [{ parts: [{ text: body.prompt }] }]
        };
        const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: 'POST',
          signal: AbortSignal.timeout(25000),
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey
          },
          body: JSON.stringify(payload)
        });
        if (resp.status === 429) {
          return await respondToProviderRateLimit(resp, res, { model, service: 'script' });
        }
        if (!resp.ok) {
          if (structured && attempt === 0 && resp.status === 400) {
            const data = await resp.json().catch(() => ({}));
            if (/schema|response.?mime.?type|json.?mode/i.test(data?.error?.message || '')) continue;
          }
          break;
        }
        const data = await resp.json();
        const candidate = data.candidates?.[0];
        if (candidate?.finishReason && candidate.finishReason !== 'STOP') break;
        const text = (candidate?.content?.parts || [])
          .filter(part => !part.thought && typeof part.text === 'string')
          .map(part => part.text).join('');
        if (!text.trim()) break;
        if (structured) {
          const chapters = parsePersonalScript(text, input.chapterCount);
          return res.status(200).json({ chapters, text: JSON.stringify(chapters), model });
        }
        return res.status(200).json({ text, model });
      } catch {
        // Do not expose provider errors, request content, or credentials.
        break;
      }
    }
  }
  return res.status(502).json({ error: unavailable });
}

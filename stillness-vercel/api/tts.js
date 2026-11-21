import { respondToProviderRateLimit } from '../lib/provider-errors.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const apiKey = (process.env.GEMINI_API_KEY || process.env.api_key_google || '').trim();
  if (!apiKey) {
    return res.status(503).json({ error: 'Studio service is temporarily unavailable. Please try again shortly.' });
  }
  const { text, voiceName, style, model: requestedModel } = req.body || {};
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'Missing text' });
  }

  const supportedModels = ['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts', 'gemini-2.5-flash-preview-tts'];
  if (requestedModel !== undefined && !supportedModels.includes(requestedModel)) {
    return res.status(400).json({ error: 'Unsupported voice model.' });
  }
  const models = requestedModel ? [requestedModel] : supportedModels;
  let lastErr = 'No TTS model succeeded';
  for (const model of models) {
    try {
      const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        signal: AbortSignal.timeout(35000),
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: text,
              speech_metadata: {
                style: style || 'very slow, soft, warm, gentle meditation guide with a soothing unhurried cadence'
              }
            }]
          }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: voiceName || 'Vindemiatrix' }
              }
            }
          }
        })
      });
      if (resp.status === 429) {
        return await respondToProviderRateLimit(resp, res, { model, service: 'voice' });
      }
      if (!resp.ok) {
        console.warn({ event: 'voice_generation_failed', model, status: resp.status });
        const errData = await resp.json().catch(() => ({}));
        lastErr = `${model}: HTTP ${resp.status} ${errData?.error?.message || ''}`.trim();
        continue;
      }
      const data = await resp.json();
      const parts = data.candidates?.[0]?.content?.parts || [];
      const audioPart = parts.find(p => p.inlineData && p.inlineData.data);
      if (audioPart?.inlineData?.data) {
        return res.status(200).json({
          data: audioPart.inlineData.data,
          mimeType: audioPart.inlineData.mimeType || 'audio/L16;rate=24000',
          model
        });
      }
      lastErr = `${model}: returned no audio`;
    } catch (e) {
      console.warn({ event: 'voice_generation_failed', model, failure: e.name || 'Error' });
      lastErr = `${model}: ${e.message}`;
    }
  }
  return res.status(502).json({ error: 'Studio service is temporarily unavailable. Please try again shortly.' });
}

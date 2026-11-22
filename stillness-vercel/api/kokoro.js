import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutoTokenizer, StyleTextToSpeech2Model, env } from '@huggingface/transformers';
import { KokoroTTS } from 'kokoro-js';
import { encodeWav } from '../lib/encode-wav.js';
import { withUsage } from '../lib/member-usage.js';

const modelId = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const revision = '1939ad2a8e416c0acfeecc08a694d14ef25f2231';
env.cacheDir = join(tmpdir(), 'stillness-kokoro-model');
let voiceModel;

async function loadVoice() {
  const [model, tokenizer] = await Promise.all([
    StyleTextToSpeech2Model.from_pretrained(modelId, {
      revision, dtype: 'fp32', device: 'cpu',
      session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 },
    }),
    AutoTokenizer.from_pretrained(modelId, { revision }),
  ]);
  return new KokoroTTS(model, tokenizer);
}

async function generate(req, res) {
  const text = req.body.text.trim();
  const started = Date.now();
  try {
    voiceModel ??= loadVoice().catch(error => {
      voiceModel = undefined;
      throw error;
    });
    const voice = await voiceModel;
    const modelReady = Date.now();
    const { audio, sampling_rate: sampleRate } = await voice.generate(text, { voice: 'af_heart', speed: 0.75 });
    if (!audio?.length) throw new Error('Empty audio');
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Server-Timing', `model;dur=${modelReady - started}, synthesis;dur=${Date.now() - modelReady}`);
    return res.status(200).send(Buffer.from(encodeWav(audio, sampleRate)));
  } catch (error) {
    console.error('Kokoro generation failed', error.name, error.code ?? '');
    return res.status(503).json({ error: 'Kokoro Heart could not prepare this audio. Try again.' });
  }
}

export default withUsage('kokoro', generate, body => {
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  return text && text.length <= 360 ? null : 'Provide up to 360 characters.';
});

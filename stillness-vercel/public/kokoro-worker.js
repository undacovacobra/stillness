import { KokoroTTS } from 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js';

const modelId = 'onnx-community/Kokoro-82M-v1.0-ONNX';
let model;

self.addEventListener('message', async ({ data: text }) => {
  try {
    model ??= await KokoroTTS.from_pretrained(modelId, { dtype: 'q8', device: 'wasm' });
    const { audio, sampling_rate: sampleRate } = await model.generate(text, { voice: 'af_heart', speed: 0.75 });
    if (!audio?.length) throw new Error('Kokoro returned an empty clip.');
    const wav = encodeWav(audio, sampleRate);
    self.postMessage({ wav }, [wav]);
  } catch (error) {
    console.warn('Kokoro narration could not be generated:', error);
    self.postMessage({ error: 'Kokoro could not prepare this clip. Please try again.' });
  }
});

function encodeWav(samples, sampleRate) {
  // 16-bit PCM works with the existing player across mobile browsers.
  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  view.setUint32(0, 0x52494646); // RIFF
  view.setUint32(4, 36 + dataSize, true);
  view.setUint32(8, 0x57415645); // WAVE
  view.setUint32(12, 0x666d7420); // fmt
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(36, 0x64617461); // data
  view.setUint32(40, dataSize, true);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(44 + index * 2, Math.round(sample * 32767), true);
  }
  return buffer;
}

import generate from '../lib/gemini-tts.js';
import { withUsage } from '../lib/member-usage.js';

const voices = new Set(['Vindemiatrix', 'Algieba', 'Achernar', 'Charon']);

export default withUsage('voice', generate, body => {
  if (typeof body?.text !== 'string' || !body.text.trim() || body.text.length > 650) {
    return 'Send a narration segment of 650 characters or fewer.';
  }
  if (body.voiceName && !voices.has(body.voiceName)) return 'Choose a Stillness voice.';
  if (body.style !== undefined && (typeof body.style !== 'string' || body.style.length > 160)) return 'Choose a Stillness speaking style.';
  return null;
});

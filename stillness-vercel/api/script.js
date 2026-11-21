import generate from '../lib/gemini-script.js';
import { validatePersonalScriptRequest } from '../lib/personal-script.js';
import { withUsage } from '../lib/member-usage.js';

export default withUsage('script', generate, body => {
  try {
    validatePersonalScriptRequest(body);
    return null;
  } catch (error) {
    return error.message;
  }
});

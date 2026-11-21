# Stillness — Custom Guided Meditation Studio (Vercel Ready)

## Quick Deploy to Vercel
1. Import this repository at https://vercel.com/new.
2. Set **Root Directory** to `stillness-vercel`, Framework Preset to **Other**, and Output Directory to `public`. The `api` directory contains the server functions.
3. In Vercel Project Settings -> **Environment Variables**, add:
   - **Key:** `GEMINI_API_KEY` (the existing `api_key_google` name is also supported)
   - **Value:** your Google AI Studio Gemini API key
   - **Type:** Secret (check Production, Preview, and Development)
4. Click **Deploy** (or **Redeploy** if you added the variable after deploying).
5. Share your live `https://your-project.vercel.app` link — everyone gets live personalized AI meditations and gentle studio voice automatically with your API key kept private on the server.

The app always calls its own `/api/script` and `/api/tts` endpoints. Visitors never enter or save credentials, and old browser keys cannot override the server configuration. Voice settings show connection status and offer a voice test. Share the deployed link; downloading the HTML alone does not include the server functions.

`/api/status` reports only whether configuration is present, not whether Google has accepted the key or whether quota is available. After changing environment variables, redeploy so the functions receive them.

Run the regression tests with `npm test` (Node.js 22 or later).

## Personal scripts and session library

Review Script automatically composes from the full personal note. The server keeps writing instructions separate from the note and validates the requested chapter count. If generation fails, the script view labels its local template as a draft and offers a retry.

**Script Detail** offers **Wordy**, **Average** (default), and **Minimal**. These control how much the guide speaks, with more quiet time at lower detail levels. Changing detail generates a fresh script. The selection is saved with library sessions; older saved sessions use Average and keep their original script.

After finishing or ending a session, choose **Save Session**. **Library** lets you read, replay, or delete saved practices. The exact script and the final voice, pause, and sound settings are stored in this browser on this device. Audio is generated again on replay; saved practices are not audio recordings and do not sync across devices. Clearing browser storage removes the library.

Previewing a voice also selects it for the session. Switching previews cancels older requests, and studio failures are shown rather than silently substituting the same browser voice.

## Audio reliability

Background recordings are served from `public/audio` with [recording credits](public/audio/credits.md), so playback does not depend on another media host's rate limits. Phone-blocked narration is retained for **Resume Audio**; the session clock waits for narration and stops during audio failures. Long chapters are spoken in smaller sequential pieces without changing the script.

Google usage limits return HTTP 429 with a specific voice or script code and `Retry-After`, without trying every model again. Server diagnostics include status and model only, never personal notes or credentials.

## Pauses

Silent practice pauses never exceed 60 seconds, including older library sessions. Openings and closings use short transitions; breathing and reflection have longer cue-specific allowances. Brief, Balanced, Spacious, and Minimal Flow still shape the pacing within that ceiling. Unused target time is not padded with excessive silence, so sparse sessions may show a shorter estimated runtime.

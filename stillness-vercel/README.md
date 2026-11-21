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

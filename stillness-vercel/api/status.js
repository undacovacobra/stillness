export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ configured: Boolean((process.env.GEMINI_API_KEY || process.env.api_key_google || '').trim()) });
}

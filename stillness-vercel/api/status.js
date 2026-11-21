export default function handler(req, res) {
  res.status(200).json({ configured: Boolean(process.env.GEMINI_API_KEY) });
}

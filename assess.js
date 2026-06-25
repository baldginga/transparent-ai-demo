/**
 * api/assess.js — Vercel serverless function
 *
 * This file runs on Vercel's edge and acts as the proxy between the browser
 * and the Anthropic API. The ANTHROPIC_API_KEY environment variable is set
 * via the Vercel dashboard (Project Settings → Environment Variables) and
 * never reaches the browser.
 *
 * Local testing: vercel dev
 */

const ALLOWED_MODELS = ['claude-sonnet-4-6'];
const MAX_BODY_CHARS = 8000;

export default async function handler(req, res) {
  // CORS preflight
  res.setHeader('Access-Control-Allow-Origin',  process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Basic validation
  const body = req.body;
  if (!body?.messages?.length) {
    return res.status(400).json({ error: 'messages array is required' });
  }
  const lastContent = body.messages[body.messages.length - 1]?.content;
  if (typeof lastContent !== 'string' || lastContent.length > MAX_BODY_CHARS) {
    return res.status(400).json({ error: 'Invalid or oversized message content' });
  }
  if (body.model && !ALLOWED_MODELS.includes(body.model)) {
    return res.status(400).json({ error: `Model "${body.model}" is not permitted` });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY not set in environment');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  // Proxy to Anthropic
  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      body.model      || 'claude-sonnet-4-6',
        max_tokens: body.max_tokens || 1000,
        system:     body.system     || '',
        messages:   body.messages,
      }),
    });

    const data = await upstream.json();

    // Audit log (Vercel captures stdout)
    const text     = data.content?.[0]?.text || '';
    const decMatch = text.match(/<decision>([\s\S]*?)<\/decision>/);
    console.log(JSON.stringify({
      ts:       new Date().toISOString(),
      event:    'assess_complete',
      decision: decMatch?.[1]?.trim() || 'unparseable',
      tokens:   data.usage?.output_tokens,
      status:   upstream.status,
    }));

    return res.status(upstream.status).json(data);

  } catch (err) {
    console.error('Proxy error:', err.message);
    return res.status(502).json({ error: 'Could not reach the AI service. Please try again.' });
  }
}

/**
 * api/assess-gemini.js — Vercel serverless function using Google Gemini (free tier)
 *
 * To use this instead of the Anthropic version:
 *   1. Rename this file to assess.js (replacing the existing one)
 *   2. In Vercel dashboard → Settings → Environment Variables, add:
 *        GEMINI_API_KEY   (get free at https://aistudio.google.com/apikey)
 *   3. Remove ANTHROPIC_API_KEY if you had it set
 *
 * Free tier limits (Gemini Flash, as of mid-2026):
 *   - 1,500 requests per day
 *   - 15 requests per minute
 *   - No credit card required
 *   - Note: Google may use free-tier prompts for model training
 */

const GEMINI_MODEL   = 'gemini-2.5-flash';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const MAX_BODY_CHARS = 8000;

// The same system prompt from the Anthropic version — Gemini understands it fine
const SYSTEM_PROMPT = `You are an AI decision-maker assessing NZ Jobseeker Support eligibility.
Your role is to demonstrate transparent AI governance: every step of your reasoning must be explicit,
stated in plain English, and challengeable by the applicant.

OFFICIAL RATES (from 1 April 2026 — Annual General Adjustment):
Source: workandincome.govt.nz/products/benefit-rates/benefit-rates-april-2026.html
- Single 18–24, no children:          approx $348/week gross
- Single 25+, no children:            $372.55/week gross
- Single (any age) with dependants:   approx $430/week gross (higher rate applies)
- Partnered (each, if both eligible): approx $313/week gross each
- Winter Energy Payment (automatic, May–Oct): $20.46/wk single · $31.82/wk with dependants

INCOME ABATEMENT RULES (workandincome.govt.nz — income deduction tables):
- Income-free amount: $160/week gross (before tax)
- SINGLE: benefit reduces by $0.70 per $1 earned above $160/week
  Formula: Reduction = (gross weekly income − $160) × 0.70
  Adjusted benefit = base rate − reduction
- COUPLE (both eligible): each benefit reduces by $0.35 per $1 of COMBINED income above $160/week
- COUPLE (only one eligible): use single abatement rules on applicant income only

ELIGIBILITY CRITERIA (Social Security Act 2018):
1. AGE: Must be 18 or over. Exception: 16–17 if has dependent children.
2. RESIDENCY: Must be NZ citizen, permanent resident, or approved visa with work rights. Ordinarily resident in NZ.
3. EMPLOYMENT SITUATION: Must NOT be in full-time employment (30+ hrs/week) — OR has a health condition reducing capacity to work.
4. WORK TEST: Must be available for and actively seeking full-time work — UNLESS medically certified as unable.
5. STUDY: Cannot be in full-time study (30+ hrs/week). Exceptions: approved employment training through Work and Income.
6. INCOME TEST: Combined gross income must be below the weekly cut-out point.

REVIEW AND CHALLENGE PROCESS:
- Request a Review of Decision within 3 months: workandincome.govt.nz/about-work-and-income/feedback-and-complaints/review-of-decisions.html
- Can escalate to Social Security Appeal Authority (independent tribunal)
- Free help: Citizens Advice Bureau, Community Law Centres — call 0800 559 009

RESPONSE FORMAT — use EXACTLY these XML tags:
<reasoning>
Work through every criterion numbered. Show income calculations with actual numbers.
State what you are inferring and any uncertainties.
1. AGE: ...  2. RESIDENCY: ...  3. EMPLOYMENT SITUATION: ...  4. WORK TEST: ...  5. STUDY STATUS: ...
6. INCOME TEST (show formula): ...  ADDITIONAL ENTITLEMENTS: ...  CONCLUSION: ...
</reasoning>
<decision>APPROVED or DECLINED or FURTHER_INFORMATION_NEEDED</decision>
<rate>estimated weekly gross NZD or N/A</rate>
<adjusted_rate>rate after income abatement, or same as rate if no abatement</adjusted_rate>
<summary>3 plain-English sentences. If approved, mention Winter Energy Payment.</summary>
<obligations>Key obligations if approved (2–4 points), or N/A</obligations>
<rights>Numbered steps to challenge this decision. Include the Review of Decision URL.</rights>`;

export default async function handler(req, res) {
  // CORS preflight
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Validate input
  const body = req.body;
  if (!body?.messages?.length) {
    return res.status(400).json({ error: 'messages array is required' });
  }
  const userMessage = body.messages[body.messages.length - 1]?.content;
  if (typeof userMessage !== 'string' || userMessage.length > MAX_BODY_CHARS) {
    return res.status(400).json({ error: 'Invalid or oversized message content' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('GEMINI_API_KEY not set');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  try {
    // Gemini uses a different request format to Anthropic.
    // The system prompt goes in systemInstruction, the user message in contents.
    const geminiPayload = {
      systemInstruction: {
        parts: [{ text: SYSTEM_PROMPT }]
      },
      contents: [
        {
          role: 'user',
          parts: [{ text: userMessage }]
        }
      ],
      generationConfig: {
        maxOutputTokens: 1500,
        temperature:     0.2,   // lower = more consistent, factual responses
      }
    };

    const upstream = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(geminiPayload),
    });

    const geminiData = await upstream.json();

    if (!upstream.ok) {
      console.error('Gemini API error:', geminiData);
      return res.status(upstream.status).json({
        error: geminiData?.error?.message || 'Upstream API error',
      });
    }

    // Gemini's response structure is different from Anthropic's.
    // We convert it to the Anthropic format the frontend expects,
    // so no changes are needed in index.html.
    const text = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      return res.status(502).json({ error: 'No content in Gemini response' });
    }

    // Audit log
    const decMatch = text.match(/<decision>([\s\S]*?)<\/decision>/);
    console.log(JSON.stringify({
      ts:       new Date().toISOString(),
      event:    'assess_complete',
      provider: 'gemini',
      model:    GEMINI_MODEL,
      decision: decMatch?.[1]?.trim() || 'unparseable',
    }));

    // Return in the Anthropic response shape the frontend already understands
    return res.json({
      content: [{ type: 'text', text }],
      model:   GEMINI_MODEL,
    });

  } catch (err) {
    console.error('Proxy error:', err.message);
    return res.status(502).json({ error: 'Could not reach the AI service. Please try again.' });
  }
}

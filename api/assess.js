/**
 * api/assess.js — Vercel serverless function using Google Gemini (free tier)
 */

export const maxDuration = 60;

const GEMINI_MODEL   = 'gemini-2.5-flash';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const MAX_BODY_CHARS = 8000;

const SYSTEM_PROMPT = `You are an AI decision-maker assessing NZ Jobseeker Support eligibility.
Your role is to demonstrate transparent AI governance: every step of your reasoning must be explicit,
stated in plain English, and challengeable by the applicant.

OFFICIAL RATES (from 1 April 2026 — Annual General Adjustment):
Source: workandincome.govt.nz/products/benefit-rates/benefit-rates-april-2026.html
- Single 18-24, no children:          approx $348/week gross
- Single 25+, no children:            $372.55/week gross
- Single (any age) with dependants:   approx $430/week gross
- Partnered (each, if both eligible): approx $313/week gross each
- Winter Energy Payment (automatic, May-Oct): $20.46/wk single, $31.82/wk with dependants

INCOME ABATEMENT RULES (workandincome.govt.nz):
- Income-free amount: $160/week gross
- SINGLE: benefit reduces by $0.70 per $1 earned above $160/week
  Formula: Reduction = (gross weekly income - $160) x 0.70
- COUPLE (both eligible): each benefit reduces by $0.35 per $1 of COMBINED income above $160/week
- COUPLE (only one eligible): use single abatement rules on applicant income only

ELIGIBILITY CRITERIA (Social Security Act 2018):
1. AGE: Must be 18 or over. Exception: 16-17 if has dependent children.
2. RESIDENCY: Must be NZ citizen, permanent resident, or approved visa with work rights. Ordinarily resident in NZ.
3. EMPLOYMENT SITUATION: Must NOT be in full-time employment (30+ hrs/week) OR has a health condition reducing capacity to work.
4. WORK TEST: Must be available for and actively seeking full-time work - UNLESS medically certified as unable.
5. STUDY: Cannot be in full-time study. Exceptions: approved employment training through Work and Income.
6. INCOME TEST: Combined gross income must be below the weekly cut-out point.

REVIEW AND CHALLENGE PROCESS:
- Request a Review of Decision within 3 months
- URL: workandincome.govt.nz/about-work-and-income/feedback-and-complaints/review-of-decisions.html
- Can escalate to Social Security Appeal Authority
- Free help: Citizens Advice Bureau, Community Law Centres, call 0800 559 009

RESPONSE FORMAT - use EXACTLY these XML tags and no other text outside them:
<reasoning>
Work through every criterion numbered. Show income calculations with actual numbers.
State what you are inferring and any uncertainties.
1. AGE: ...
2. RESIDENCY: ...
3. EMPLOYMENT SITUATION: ...
4. WORK TEST: ...
5. STUDY STATUS: ...
6. INCOME TEST (show formula with numbers): ...
ADDITIONAL ENTITLEMENTS TO NOTE: ...
CONCLUSION: ...
</reasoning>
<decision>APPROVED or DECLINED or FURTHER_INFORMATION_NEEDED</decision>
<rate>estimated weekly gross NZD (write "estimated $X/week") or N/A</rate>
<adjusted_rate>rate after income abatement if income above $160, otherwise same as rate</adjusted_rate>
<summary>3 plain-English sentences for the applicant. If approved, mention Winter Energy Payment.</summary>
<obligations>Key obligations if approved (2-4 bullet points), or N/A if declined</obligations>
<rights>Numbered steps to challenge this decision. Include the Review of Decision URL.</rights>`;

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function retryWithBackoff(apiCall, maxRetries = 4) {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      return await apiCall();
    } catch (error) {
      attempt++;
      const isRateLimit = error.status === 429 || error.statusCode === 429 || error.message?.includes('429') || error.message?.includes('RESOURCE_EXHAUSTED');
      if (isRateLimit && attempt < maxRetries) {
        const waitTime = Math.pow(2.5, attempt) * 1500 + Math.random() * 1000;
        console.warn(`[Gemini 429] Retrying in ${Math.round(waitTime)}ms...`);
        await delay(waitTime);
      } else {
        throw error;
      }
    }
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  const userMessage = body?.messages?.[body?.messages?.length - 1]?.content;
  if (!userMessage || userMessage.length > MAX_BODY_CHARS) {
    return res.status(400).json({ error: 'Invalid or over-length content payload.' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY is missing in Vercel configuration.' });

  try {
    const geminiPayload = {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: userMessage }] }],
      generationConfig: { maxOutputTokens: 2500, temperature: 0.2 }
    };

    const geminiData = await retryWithBackoff(async () => {
      const upstream = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(geminiPayload),
      });
      const data = await upstream.json();
      if (!upstream.ok) {
        const errObj = new Error(data?.error?.message || 'Gemini error');
        errObj.status = upstream.status;
        throw errObj;
      }
      return data;
    }, 4);

    const text = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return res.status(502).json({ error: 'No content returned from Gemini.' });

    // Send back a clean, native JSON block containing the generated text
    return res.status(200).json({ text });

  } catch (err) {
    console.error('Assess handler failed:', err);
    return res.status(err.status === 429 ? 429 : 502).json({
      error: 'The AI engine is temporarily busy. Please try clicking submit again.'
    });
  }
}

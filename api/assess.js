/**
 * api/assess.js — Vercel serverless function using Google Gemini (free tier)
 *
 * Environment variables to set in Vercel dashboard → Settings → Environment Variables:
 * GEMINI_API_KEY   (get free at https://aistudio.google.com/apikey)
 */

// Tell Vercel this function can run for up to 30 seconds
// (default is 10s on the free plan, which can time out waiting for the AI)
export const maxDuration = 30;

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

// Helper function to pause execution
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Wraps an asynchronous operation with retry logic specifically tuned for Gemini 429 limits
 */
async function retryWithBackoff(apiCall, maxRetries = 4) {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      return await apiCall();
    } catch (error) {
      attempt++;
      
      // Robust detection across stringified errors, status numbers, and deep response data
      const isRateLimit = 
        error.status === 429 || 
        error.statusCode === 429 || 
        error.message?.includes('429') || 
        error.message?.includes('RESOURCE_EXHAUSTED');

      if (isRateLimit && attempt < maxRetries) {
        // Broaden base delay to give the 15 RPM window breathing room + random jitter
        const waitTime = Math.pow(2.5, attempt) * 1500 + Math.random() * 1000;
        console.warn(`[Gemini 429 Rate Limit] Attempt ${attempt} failed. Retrying in ${Math.round(waitTime)}ms...`);
        await delay(waitTime);
      } else {
        throw error;
      }
    }
  }
}

export default async function handler(req, res) {
  // ── CORS headers ──────────────────────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── Parse body ────────────────────────────────────────────────────────────
  let body;
  try {
    if (req.body && typeof req.body === 'object') {
      body = req.body;
    } else if (req.body && typeof req.body === 'string') {
      body = JSON.parse(req.body);
    } else {
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      body = JSON.parse(Buffer.concat(chunks).toString());
    }
  } catch (parseError) {
    console.error('Body parse error:', parseError.message);
    return res.status(400).json({ error: 'Could not parse request body as JSON' });
  }

  // ── Validate ──────────────────────────────────────────────────────────────
  if (!body?.messages?.length) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  const userMessage = body.messages[body.messages.length - 1]?.content;
  if (typeof userMessage !== 'string') {
    return res.status(400).json({ error: 'Last message must have string content' });
  }
  if (userMessage.length > MAX_BODY_CHARS) {
    return res.status(400).json({ error: 'Message content is too long' });
  }

  // ── Check API key ─────────────────────────────────────────────────────────
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('GEMINI_API_KEY environment variable is not set');
    return res.status(500).json({
      error: 'Server configuration error: GEMINI_API_KEY is not set. Add it in Vercel → Settings → Environment Variables.'
    });
  }

  // ── Call Gemini ───────────────────────────────────────────────────────────
  try {
    console.log('Calling Gemini API, message length:', userMessage.length);

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
        temperature:     0.2,
      }
    };

    const geminiData = await retryWithBackoff(async () => {
      const upstream = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(geminiPayload),
      });

      const data = await upstream.json();

      if (!upstream.ok) {
        const errMsg = data?.error?.message || `Gemini API error (${upstream.status})`;
        const errObj = new Error(errMsg);
        // Explicitly attach statuses to the error object so the retry handler captures it
        errObj.status = upstream.status; 
        errObj.statusCode = upstream.status;
        errObj.responseData = data;
        throw errObj;
      }

      return data;
    }, 4);

    // Extract the text from Gemini's response structure
    const text = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!text) {
      console.error('Gemini response had no text content:', JSON.stringify(geminiData));
      return res.status(502).json({ error: 'No content returned from AI service' });
    }

    // Log the decision for audit purposes
    const decMatch = text.match(/<decision>([\s\S]*?)<\/decision>/);
    console.log(JSON.stringify({
      ts:       new Date().toISOString(),
      event:    'assess_complete',
      provider: 'gemini',
      model:    GEMINI_MODEL,
      decision: decMatch?.[1]?.trim() || 'unparseable',
    }));

    return res.status(200).json({
      content: [{ type: 'text', text }],
      model:   GEMINI_MODEL,
    });

  } catch (err) {
    console.error('Unhandled error in assess function:', err.message, err.stack);
    
    // Explicitly handle fallback if retries are entirely exhausted
    if (err.status === 429 || err.statusCode === 429 || err.message?.includes('429')) {
      return res.status(429).json({
        error: 'The AI service is currently experiencing heavy volume. Please wait a few seconds and try again.'
      });
    }

    return res.status(502).json({
      error: 'Could not reach the AI service. Please try again in a moment.'
    });
  }
}

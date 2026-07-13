# Transparent AI Decisions — NZ Benefit System Demo

A research demonstration showing how AI language models can make government benefit decisions
more transparent than conventional automated systems, using New Zealand's Jobseeker Support
as a live example.

Every eligibility criterion is assessed in plain English. The full reasoning trail is
recorded as a decision receipt that citizens can read, print, and use to challenge outcomes.

---

## What this is

When rule-based automation makes a wrong government decision — as in the Australian Robodebt
scandal or the UK Post Office Horizon case — citizens receive a decision code with no
explanation and no meaningful path to challenge it. An AI language model working through
the same decision writes out its reasoning step by step. If it makes a mistake, the specific
erroneous inference is visible in the receipt and can be corrected on review.

This demo applies that approach to New Zealand's Jobseeker Support, using official eligibility
rules and April 2026 payment rates sourced from workandincome.govt.nz.

---

## Project structure

```
.
├── index.html          Frontend markup — Vue 3, served as a static file
├── app.js              Frontend logic — Vue app (CDN build, no build step)
├── api/
│   └── assess.js       Vercel Edge Function — calls Gemini, rate-limited via Upstash
├── package.json
├── vercel.json          Vercel deployment config (security headers, CSP, CORS)
└── .gitignore
```

There is no separate backend server — `api/assess.js` runs as a Vercel Edge Function.
The frontend never touches the Gemini API key. All AI calls flow through `/api/assess`,
which reads the key from the environment.

---

## Quick start (local)

### 1. Prerequisites

- Node.js 18 or newer — [nodejs.org](https://nodejs.org)
- The Vercel CLI — `npm i -g vercel`
- A Google Gemini API key (free tier available) — [aistudio.google.com](https://aistudio.google.com)
- An Upstash Redis database (free tier available) — [upstash.com](https://upstash.com), used for
  rate limiting

### 2. Set your environment variables

Create a `.env` file (or use `vercel env add` per variable — see below) with:

```
GEMINI_API_KEY=...
ALLOWED_ORIGIN=http://localhost:3000
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...
```

`UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are required for rate limiting to
be enforced. **If either is missing, `/api/assess` still works but silently allows unlimited
requests** — check the function logs for a `Rate limiting not enforced` warning if you're
unsure whether it's active. See [Configuration reference](#configuration-reference).

### 3. Run locally

```bash
vercel dev
```

This serves `index.html`/`app.js` as static files and runs `api/assess.js` as a local Edge
Function, matching production behaviour. Open the URL it prints (typically
[http://localhost:3000](http://localhost:3000)).

---

## Deployment (Vercel)

```bash
npm i -g vercel     # if not already installed
vercel               # first-time setup, links the project
```

Set the required environment variables in the Vercel dashboard (Project Settings →
Environment Variables), or via the CLI:

```bash
vercel env add GEMINI_API_KEY
vercel env add ALLOWED_ORIGIN
vercel env add UPSTASH_REDIS_REST_URL
vercel env add UPSTASH_REDIS_REST_TOKEN
```

Then deploy:

```bash
vercel --prod
```

Set `ALLOWED_ORIGIN` to your production URL (e.g. `https://your-deployed-url.vercel.app`) —
`api/assess.js` falls back to the production origin if this isn't set, but setting it
explicitly is recommended.

---

## Configuration reference

All settings are via environment variables.

| Variable                   | Required | Default                                    | Description                                         |
|-----------------------------|----------|---------------------------------------------|------------------------------------------------------|
| `GEMINI_API_KEY`            | Yes      | *(none)*                                    | Your key from aistudio.google.com                    |
| `ALLOWED_ORIGIN`            | No       | production origin                           | CORS origin allowed to call `/api/assess`             |
| `UPSTASH_REDIS_REST_URL`    | For rate limiting | *(none — limiting disabled if unset)* | Upstash Redis REST endpoint                           |
| `UPSTASH_REDIS_REST_TOKEN`  | For rate limiting | *(none — limiting disabled if unset)* | Upstash Redis REST token                              |
| `RATE_LIMIT_WINDOW`         | No       | `15`                                        | Rate limit window, in minutes                         |
| `RATE_LIMIT_MAX`            | No       | `20`                                        | Max requests per IP per window                        |

Rate limiting fails **open**: if Upstash isn't configured or is temporarily unreachable, requests
are still allowed through rather than the whole endpoint going down. This is an intentional
availability trade-off for a demo — it means the `UPSTASH_REDIS_REST_URL`/`TOKEN` pair should be
double-checked in the Vercel dashboard periodically, since there's no user-facing signal if
they're missing or expire.

---

## How the AI assessment works

The browser sends the applicant's form data to `/api/assess`. The Edge Function constructs a
structured prompt containing the eligibility rules (from workandincome.govt.nz) and the
applicant's answers, then calls the Google Gemini API.

The model is instructed to work through each criterion explicitly and return its response
in tagged XML:

```
<reasoning>   step-by-step analysis of each eligibility criterion   </reasoning>
<decision>    APPROVED | DECLINED | FURTHER_INFORMATION_NEEDED      </decision>
<rate>        estimated weekly gross payment in NZD                  </rate>
<adjusted_rate> rate after income abatement                         </adjusted_rate>
<summary>     3 plain-English sentences for the applicant            </summary>
<obligations> key obligations if approved                            </obligations>
<rights>      numbered steps to challenge the decision               </rights>
```

The frontend parses the XML tags and renders each section separately, using Vue's default
text interpolation (not `v-html`), so model output is always escaped rather than rendered as
live HTML. The `<reasoning>` block is the audit trail — the typewriter-reveal makes the AI's
thought process visceral rather than hiding it in an accordion.

---

## Eligibility rules in use

All rules are sourced from official NZ government documents:

| Rule | Source |
|------|--------|
| Weekly rates (1 Apr 2026) | [workandincome.govt.nz/products/benefit-rates/benefit-rates-april-2026.html](https://www.workandincome.govt.nz/products/benefit-rates/benefit-rates-april-2026.html) |
| Income abatement ($160 free zone, 70c/$ above) | [WINZ income deduction tables](https://www.workandincome.govt.nz/on-a-benefit/tell-us/income/deduction-tables/jobseeker-support-single.html) |
| Eligibility criteria | Social Security Act 2018, ss. 88–113 |
| Review of decision process | [workandincome.govt.nz/about-work-and-income/feedback-and-complaints/review-of-decisions.html](https://www.workandincome.govt.nz/about-work-and-income/feedback-and-complaints/review-of-decisions.html) |

---

## Important disclaimer

This is a **research demonstration only**. It is not a real Work and Income NZ
assessment system and decisions are not legally binding.

For actual benefit applications:
- Online: [my.msd.govt.nz](https://my.msd.govt.nz)
- Phone: **0800 559 009** (free call)
- In person: any Work and Income service centre

---

## Security notes

- The Gemini API key lives only in the server environment — it is never sent to or stored in
  the browser, and is sent to Gemini via the `x-goog-api-key` header rather than a URL parameter.
- The `/api/assess` endpoint validates all input before forwarding to Gemini. Oversized payloads
  are rejected with `400`. Only `POST` is accepted; all other methods get `405`.
- Rate limiting (20 requests per 15 min per IP by default) is enforced via Upstash Redis,
  keyed by client IP. See the note above on fail-open behaviour if Upstash isn't configured.
- CORS is restricted to `ALLOWED_ORIGIN` (or the production origin if unset — never a wildcard).
- CSP, HSTS, X-Frame-Options, and related security headers are set in `vercel.json`.
  `script-src` includes `'unsafe-eval'`, required by Vue 3's CDN build for in-browser template
  compilation — this is an accepted architectural trade-off of staying build-step-free, not an
  oversight.
- Error responses returned to the client are generic; specific failure detail (e.g.
  misconfiguration) is logged server-side only, not exposed to the browser.
- There is no persistent storage of applicant data. Each request is stateless.

---

## Extending the demo

**Add more benefit types**

Copy the system prompt in `api/assess.js` (the `SYSTEM_PROMPT` constant) and adapt it for
Sole Parent Support or Supported Living Payment. Add a selector on the form to route to
the appropriate prompt.

**Add human review**

Insert a step between `/api/assess` and the frontend response where a caseworker sees the
AI's reasoning before it is released to the applicant. This is the governance model
recommended for real deployments.

**Persist decision receipts**

Store the audit log in a database (e.g. Vercel Postgres, or Upstash's own Redis/KV) so
decisions can be retrieved by reference number. Useful for ombudsman review.

**Stream the reasoning**

Switch to the Gemini streaming endpoint to show the reasoning typing out in real time rather
than appearing after the full response completes.

---

## Built with

- [Vue 3](https://vuejs.org) — reactive frontend (CDN, no build step)
- [Vercel Edge Functions](https://vercel.com/docs/functions/edge-functions) — serverless API route
- [Google Gemini](https://ai.google.dev) — `gemini-2.5-flash`
- [Upstash Redis](https://upstash.com) — rate limiting (REST API, no SDK)
- [Tabler Icons](https://tabler.io/icons) — icon set
- [Google Fonts](https://fonts.google.com) — Libre Baskerville, Inter, JetBrains Mono

---

*Research project exploring transparent AI governance for public services.*
*Not affiliated with the New Zealand Ministry of Social Development.*

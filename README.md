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
├── index.html          Frontend — Vue 3, served as a static file
├── server.js           Backend — Express proxy, serves the frontend and API route
├── api/
│   ├── assess.js       Serverless function for Vercel deployment
│   └── health.js       Health check for Vercel
├── test/
│   └── smoke.js        Basic smoke tests (no AI calls needed)
├── package.json
├── vercel.json         Vercel deployment config
├── .env.example        Environment variable template
└── .gitignore
```

The frontend never touches your Anthropic API key. All AI calls flow through
`/api/assess` on the server, which adds the key from the environment.

---

## Quick start (local)

### 1. Prerequisites

- Node.js 18 or newer — [nodejs.org](https://nodejs.org)
- An Anthropic API key — [console.anthropic.com](https://console.anthropic.com)

### 2. Install dependencies

```bash
npm install
```

### 3. Set your API key

```bash
cp .env.example .env
```

Open `.env` and set your key:

```
ANTHROPIC_API_KEY=sk-ant-...
```

### 4. Start the server

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000).

For development with auto-reload:

```bash
npm run dev
```

### 5. Run smoke tests

Tests validate the server endpoints without making any real AI calls:

```bash
npm test
```

---

## Deployment

### Option A — Vercel (recommended, free tier available)

Vercel handles HTTPS, edge caching, and scaling automatically.

**1. Install the Vercel CLI**

```bash
npm i -g vercel
```

**2. Deploy**

```bash
vercel
```

Follow the prompts. Vercel will detect `vercel.json` and deploy automatically.

**3. Set the API key in Vercel**

```
vercel env add ANTHROPIC_API_KEY
```

Paste your key when prompted. Then redeploy:

```
vercel --prod
```

**4. Set your CORS origin** (optional but recommended)

In the Vercel dashboard → Project Settings → Environment Variables:

```
ALLOWED_ORIGIN = https://your-deployed-url.vercel.app
```

---

### Option B — Any Node.js host (Render, Railway, Fly.io, VPS)

1. Copy all files to your server
2. Set environment variables (at minimum `ANTHROPIC_API_KEY`, `NODE_ENV=production`)
3. Run `npm install --omit=dev`
4. Start with `npm start` or use a process manager:

```bash
# Using PM2
npm install -g pm2
pm2 start server.js --name transparent-ai
pm2 save
```

5. Put Nginx or Caddy in front for HTTPS termination.

**Nginx example config:**

```nginx
server {
    server_name yourdomain.com;

    location / {
        proxy_pass         http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }

    # Certbot manages the SSL block
}
```

Run `certbot --nginx -d yourdomain.com` to provision a free Let's Encrypt certificate.

---

### Option C — Docker

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
```

Build and run:

```bash
docker build -t transparent-ai .
docker run -p 3000:3000 -e ANTHROPIC_API_KEY=sk-ant-... transparent-ai
```

---

## Configuration reference

All settings are via environment variables.

| Variable            | Default                    | Description                                    |
|---------------------|----------------------------|------------------------------------------------|
| `ANTHROPIC_API_KEY` | *(required)*               | Your key from console.anthropic.com            |
| `PORT`              | `3000`                     | Server port                                    |
| `ALLOWED_ORIGIN`    | `http://localhost:3000`    | CORS origin — set to your production URL       |
| `RATE_LIMIT_WINDOW` | `15`                       | Rate limit window in minutes                   |
| `RATE_LIMIT_MAX`    | `20`                       | Max requests per IP per window (prod only)     |
| `NODE_ENV`          | `development`              | Set to `production` on your server             |

Rate limiting is disabled in development (`NODE_ENV !== 'production'`).

---

## How the AI assessment works

The browser sends the applicant's form data to `/api/assess`. The server constructs a
structured prompt containing the eligibility rules (from workandincome.govt.nz) and the
applicant's answers, then calls the Anthropic API.

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

The frontend parses the XML tags and renders each section separately. The `<reasoning>`
block is the audit trail — the typewriter-reveal makes the AI's thought process visceral
rather than hiding it in an accordion.

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

- The Anthropic API key lives only in the server environment — it is never sent to or stored
  in the browser.
- The `/api/assess` endpoint validates all input before forwarding to the Anthropic API.
  Oversized payloads and disallowed models are rejected with `400`.
- Rate limiting (20 requests per 15 min per IP by default) prevents runaway costs.
- Helmet provides standard security headers. CORS is restricted to `ALLOWED_ORIGIN`.
- There is no persistent storage of applicant data. Each request is stateless.

---

## Extending the demo

**Add more benefit types**

Copy the system prompt in `index.html` (the `SYSTEM_PROMPT` constant) and adapt it for
Sole Parent Support or Supported Living Payment. Add a selector on the form to route to
the appropriate prompt.

**Add human review**

Insert a step between `/api/assess` and the frontend response where a caseworker sees the
AI's reasoning before it is released to the applicant. This is the governance model
recommended for real deployments.

**Persist decision receipts**

Store the audit log in a database (PostgreSQL, SQLite) so decisions can be retrieved by
reference number. Useful for ombudsman review.

**Stream the reasoning**

Switch to the Anthropic streaming API (`stream: true`) to show the reasoning typing out in
real time rather than appearing after the full response completes.

---

## Built with

- [Vue 3](https://vuejs.org) — reactive frontend (CDN, no build step)
- [Express](https://expressjs.com) — Node.js backend proxy
- [Anthropic Claude](https://www.anthropic.com) — `claude-sonnet-4-6`
- [Tabler Icons](https://tabler.io/icons) — icon set
- [Google Fonts](https://fonts.google.com) — Libre Baskerville, Inter, JetBrains Mono

---

*Research project exploring transparent AI governance for public services.*
*Not affiliated with the New Zealand Ministry of Social Development.*

'use strict';

/**
 * server.js — Transparent AI Decisions backend
 *
 * Responsibilities:
 *  1. Serve the static frontend (index.html)
 *  2. Proxy Anthropic API calls through /api/assess so the API key
 *     never reaches the browser
 *  3. Apply rate limiting and basic request validation
 *  4. Log every decision request for audit purposes
 *
 * Environment variables (see .env.example):
 *  ANTHROPIC_API_KEY  — required
 *  PORT               — default 3000
 *  ALLOWED_ORIGIN     — CORS origin, default http://localhost:3000
 *  RATE_LIMIT_WINDOW  — minutes, default 15
 *  RATE_LIMIT_MAX     — requests per window per IP, default 20
 */

import 'dotenv/config';
import express         from 'express';
import rateLimit       from 'express-rate-limit';
import cors            from 'cors';
import helmet          from 'helmet';
import fetch           from 'node-fetch';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app       = express();

// ─────────────────────────────────────────────────────────
//  Configuration
// ─────────────────────────────────────────────────────────

const {
  ANTHROPIC_API_KEY,
  PORT             = 3000,
  ALLOWED_ORIGIN   = `http://localhost:${PORT}`,
  RATE_LIMIT_WINDOW = 15,
  RATE_LIMIT_MAX    = 20,
  NODE_ENV          = 'development',
} = process.env;

if (!ANTHROPIC_API_KEY) {
  console.error('\n❌  ANTHROPIC_API_KEY is not set.');
  console.error('    Copy .env.example to .env and add your key.\n');
  process.exit(1);
}

const isProd = NODE_ENV === 'production';

// ─────────────────────────────────────────────────────────
//  Middleware
// ─────────────────────────────────────────────────────────

// Security headers — relax CSP only enough for the CDN assets the frontend needs
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", 'cdnjs.cloudflare.com', "'unsafe-inline'"],
      styleSrc:   ["'self'", 'cdnjs.cloudflare.com', 'fonts.googleapis.com', "'unsafe-inline'"],
      fontSrc:    ["'self'", 'fonts.googleapis.com', 'fonts.gstatic.com', 'cdnjs.cloudflare.com'],
      connectSrc: ["'self'"],  // all AI calls go through this server, not the browser
      imgSrc:     ["'self'", 'data:'],
    },
  },
}));

app.use(cors({
  origin:      ALLOWED_ORIGIN,
  methods:     ['GET', 'POST'],
  credentials: false,
}));

app.use(express.json({ limit: '16kb' }));

// ─────────────────────────────────────────────────────────
//  Rate limiting
// ─────────────────────────────────────────────────────────

const apiLimiter = rateLimit({
  windowMs:          parseInt(RATE_LIMIT_WINDOW, 10) * 60 * 1000,
  max:               parseInt(RATE_LIMIT_MAX, 10),
  standardHeaders:   true,
  legacyHeaders:     false,
  message: {
    error: 'Too many requests from this IP — please try again in a few minutes.',
  },
  skip: () => !isProd,   // skip rate limiting in development
});

// ─────────────────────────────────────────────────────────
//  Request validation
// ─────────────────────────────────────────────────────────

const ALLOWED_MODELS = ['claude-sonnet-4-6'];

function validateAssessRequest(body) {
  const errors = [];

  if (!body || typeof body !== 'object') {
    return ['Request body must be a JSON object'];
  }

  if (!body.messages || !Array.isArray(body.messages)) {
    errors.push('messages array is required');
  } else if (body.messages.length === 0) {
    errors.push('messages array cannot be empty');
  } else {
    const lastMsg = body.messages[body.messages.length - 1];
    if (!lastMsg?.content || typeof lastMsg.content !== 'string') {
      errors.push('last message must have a string content field');
    } else if (lastMsg.content.length > 8000) {
      errors.push('message content exceeds maximum length (8000 chars)');
    }
  }

  if (body.model && !ALLOWED_MODELS.includes(body.model)) {
    errors.push(`model "${body.model}" is not permitted`);
  }

  return errors;
}

// ─────────────────────────────────────────────────────────
//  Audit logging
// ─────────────────────────────────────────────────────────

function auditLog(entry) {
  const line = JSON.stringify({
    ts:  new Date().toISOString(),
    ...entry,
  });
  // In production wire this to your logging service (CloudWatch, Datadog, etc.)
  console.log('[AUDIT]', line);
}

// ─────────────────────────────────────────────────────────
//  API proxy — POST /api/assess
// ─────────────────────────────────────────────────────────

app.post('/api/assess', apiLimiter, async (req, res) => {
  const clientIp = req.ip || req.connection.remoteAddress;
  const reqId    = Date.now().toString(36).toUpperCase();

  auditLog({ reqId, event: 'assess_request', ip: clientIp });

  // Validate
  const errs = validateAssessRequest(req.body);
  if (errs.length > 0) {
    auditLog({ reqId, event: 'validation_failed', errors: errs });
    return res.status(400).json({ error: errs.join('; ') });
  }

  // Build the Anthropic request — use only the fields we control
  const anthropicPayload = {
    model:      req.body.model || 'claude-sonnet-4-6',
    max_tokens: 1000,
    system:     req.body.system || '',
    messages:   req.body.messages,
  };

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(anthropicPayload),
    });

    const data = await upstream.json();

    if (!upstream.ok) {
      auditLog({ reqId, event: 'upstream_error', status: upstream.status, error: data?.error?.message });
      return res.status(upstream.status).json({
        error: data?.error?.message || 'Upstream API error',
      });
    }

    // Log decision outcome for audit (without personal data)
    const text     = data.content?.[0]?.text || '';
    const decMatch = text.match(/<decision>([\s\S]*?)<\/decision>/);
    auditLog({
      reqId,
      event:    'assess_complete',
      decision: decMatch ? decMatch[1].trim() : 'unparseable',
      tokens:   data.usage?.output_tokens,
    });

    return res.json(data);

  } catch (err) {
    auditLog({ reqId, event: 'server_error', message: err.message });
    console.error('[ERROR]', err);
    return res.status(502).json({ error: 'Could not reach the AI service. Please try again.' });
  }
});

// ─────────────────────────────────────────────────────────
//  Health check — GET /health
// ─────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({
    status:  'ok',
    service: 'transparent-ai-decisions',
    time:    new Date().toISOString(),
    env:     NODE_ENV,
  });
});

// ─────────────────────────────────────────────────────────
//  Serve static frontend
// ─────────────────────────────────────────────────────────

app.use(express.static(__dirname, {
  // Cache static assets for 1 hour in production
  maxAge: isProd ? '1h' : 0,
  // Don't list directory contents
  index: 'index.html',
}));

// Catch-all — return index.html for any unknown GET route
app.get('*', (_req, res) => {
  res.sendFile(join(__dirname, 'index.html'));
});

// ─────────────────────────────────────────────────────────
//  Error handler
// ─────────────────────────────────────────────────────────

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[UNHANDLED]', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ─────────────────────────────────────────────────────────
//  Start
// ─────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n✓  Transparent AI Decisions server running`);
  console.log(`   http://localhost:${PORT}\n`);
  console.log(`   Environment : ${NODE_ENV}`);
  console.log(`   Rate limit  : ${RATE_LIMIT_MAX} req / ${RATE_LIMIT_WINDOW} min per IP (prod only)`);
  console.log(`   CORS origin : ${ALLOWED_ORIGIN}\n`);
});

export default app;

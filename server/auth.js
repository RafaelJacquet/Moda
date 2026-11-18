// Authentification : email @frenchflair.pro -> code OTP par email -> session.
import crypto from 'node:crypto';
import express from 'express';
import { config } from './config.js';
import { db } from './db.js';
import { sendOtp } from './mailer.js';
import { rateLimit } from './security.js';

const COOKIE = 'ff_session';

// --- Primitives ---

function hash(value) {
  return crypto.createHmac('sha256', config.sessionSecret).update(value).digest('hex');
}

function timingSafeEqualHex(a, b) {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function normalizeEmail(raw) {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (email.length > 254) return null;
  const m = email.match(/^([a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?)@([a-z0-9.-]+)$/);
  if (!m) return null;
  if (m[2] !== config.authDomain) return null;
  return email;
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.isProduction,
    maxAge: config.sessionTtlMs,
    path: '/',
  };
}

// --- Middleware de session ---

export function sessionMiddleware(req, _res, next) {
  req.user = null;
  const token = req.cookies?.[COOKIE];
  if (token && /^[a-f0-9]{64}$/.test(token)) {
    const row = db
      .prepare('SELECT email, expires_at FROM sessions WHERE token_hash = ?')
      .get(hash(token));
    if (row && row.expires_at > Date.now()) {
      req.user = { email: row.email };
      req.sessionTokenHash = hash(token);
    }
  }
  next();
}

export function requireAuth(req, res, next) {
  if (req.user) return next();
  res.status(401).json({ error: 'Authentification requise' });
}

export function requireAuthPage(req, res, next) {
  if (req.user) return next();
  res.redirect('/login');
}

// Parse minimaliste des cookies (évite une dépendance)
export function cookieParser(req, _res, next) {
  req.cookies = {};
  const header = req.get('Cookie');
  if (header) {
    for (const part of header.split(';')) {
      const i = part.indexOf('=');
      if (i > 0) req.cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
  }
  next();
}

// --- Routes ---

export const authRouter = express.Router();

// Demande d'un code : 5 par 15 min par IP, 3 par 15 min par email
authRouter.post(
  '/request',
  rateLimit({ windowMs: 15 * 60 * 1000, max: config.requireOtp ? 5 : 30, keyPrefix: 'otp-ip' }),
  async (req, res) => {
    const email = normalizeEmail(req.body?.email);

    // Mode sans OTP : la session est créée directement pour toute adresse du domaine
    if (!config.requireOtp) {
      if (!email) {
        return res.status(401).json({ error: `Seules les adresses @${config.authDomain} sont autorisées.` });
      }
      const token = crypto.randomBytes(32).toString('hex');
      const now = Date.now();
      db.prepare(
        'INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)'
      ).run(hash(token), email, now, now + config.sessionTtlMs);
      res.cookie(COOKIE, token, cookieOptions());
      return res.json({ ok: true, direct: true, email });
    }

    // Réponse identique que l'email soit valide ou non : pas d'énumération
    const genericOk = () =>
      res.json({ ok: true, message: `Si l'adresse est autorisée, un code a été envoyé.` });

    if (!email) return genericOk();

    const now = Date.now();
    const existing = db.prepare('SELECT window_start, send_count FROM otp WHERE email = ?').get(email);
    if (existing && now - existing.window_start < 15 * 60 * 1000 && existing.send_count >= 3) {
      return genericOk(); // quota atteint, silencieux
    }

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const windowStart =
      existing && now - existing.window_start < 15 * 60 * 1000 ? existing.window_start : now;
    const sendCount =
      existing && now - existing.window_start < 15 * 60 * 1000 ? existing.send_count + 1 : 1;

    db.prepare(
      `INSERT INTO otp (email, code_hash, expires_at, attempts, window_start, send_count)
       VALUES (?, ?, ?, 0, ?, ?)
       ON CONFLICT(email) DO UPDATE SET
         code_hash = excluded.code_hash, expires_at = excluded.expires_at,
         attempts = 0, window_start = excluded.window_start, send_count = excluded.send_count`
    ).run(email, hash(code), now + config.otpTtlMs, windowStart, sendCount);

    try {
      await sendOtp(email, code);
    } catch (err) {
      console.error('[mail] Échec envoi OTP :', err.message);
      db.prepare('DELETE FROM otp WHERE email = ?').run(email);
      return res.status(502).json({ error: "Impossible d'envoyer l'email. Contactez l'administrateur." });
    }
    genericOk();
  }
);

// Vérification du code : 10 essais par 15 min par IP, 5 par code
authRouter.post(
  '/verify',
  rateLimit({ windowMs: 15 * 60 * 1000, max: 10, keyPrefix: 'verify-ip' }),
  (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
    const fail = () => res.status(401).json({ error: 'Code invalide ou expiré.' });

    if (!email || !/^\d{6}$/.test(code)) return fail();

    const row = db
      .prepare('SELECT code_hash, expires_at, attempts FROM otp WHERE email = ?')
      .get(email);
    if (!row || row.expires_at < Date.now()) return fail();
    if (row.attempts >= 5) {
      db.prepare('DELETE FROM otp WHERE email = ?').run(email);
      return fail();
    }
    db.prepare('UPDATE otp SET attempts = attempts + 1 WHERE email = ?').run(email);

    if (!timingSafeEqualHex(row.code_hash, hash(code))) return fail();

    // Succès : OTP consommé, session créée
    db.prepare('DELETE FROM otp WHERE email = ?').run(email);
    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    db.prepare(
      'INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)'
    ).run(hash(token), email, now, now + config.sessionTtlMs);

    res.cookie(COOKIE, token, cookieOptions());
    res.json({ ok: true, email });
  }
);

authRouter.post('/logout', (req, res) => {
  if (req.sessionTokenHash) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(req.sessionTokenHash);
  }
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

authRouter.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Non connecté' });
  res.json({ email: req.user.email });
});

// Configuration centrale — tout vient de l'environnement (.env), jamais du code.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Chargement minimal du .env (pas de dépendance externe)
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

const DATA_DIR = path.join(ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// Secret de session : .env en priorité, sinon généré et persisté (dev)
function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET est obligatoire en production (voir .env.example)');
  }
  const file = path.join(DATA_DIR, '.secret');
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  return fs.readFileSync(file, 'utf8').trim();
}

export const config = {
  root: ROOT,
  dataDir: DATA_DIR,
  dbFile: path.join(DATA_DIR, 'app.db'),
  publicDir: path.join(ROOT, 'public'),
  scenesDir: path.join(ROOT, 'scenes'),
  libraryDir: path.join(ROOT, 'assets'),
  layoutsDir: path.join(DATA_DIR, 'layouts'),
  thumbsDir: path.join(DATA_DIR, 'thumbs'),
  blenderOutDir: path.join(DATA_DIR, 'blender'),

  port: Number(process.env.PORT) || 3000,
  isProduction: process.env.NODE_ENV === 'production',
  trustProxy: process.env.TRUST_PROXY === '1',
  sessionSecret: sessionSecret(),

  authDomain: (process.env.AUTH_ALLOWED_DOMAIN || 'frenchflair.pro').toLowerCase(),
  // AUTH_OTP=0 : connexion directe avec l'email, sans code envoyé par mail
  requireOtp: process.env.AUTH_OTP !== '0',
  otpTtlMs: (Number(process.env.OTP_TTL_MINUTES) || 10) * 60 * 1000,
  sessionTtlMs: (Number(process.env.SESSION_TTL_DAYS) || 7) * 24 * 3600 * 1000,

  smtp: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === '1',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'French Flair Moda <no-reply@frenchflair.pro>',
  },

  anthropicKey: process.env.ANTHROPIC_API_KEY || '',
  claudeModel: process.env.CLAUDE_MODEL || 'claude-opus-5-5',
  // Un modèle par étape : le code Blender (qualité critique) reste sur le
  // modèle principal, l'enrichissement et la vérification utilisent un
  // modèle plus rapide sans perte mesurable.
  claudeModels: {
    code: process.env.CLAUDE_MODEL_CODE || process.env.CLAUDE_MODEL || 'claude-opus-5-5',
    spec: process.env.CLAUDE_MODEL_SPEC || 'claude-sonnet-5-5',
    verify: process.env.CLAUDE_MODEL_VERIFY || 'claude-sonnet-5-5',
  },
  // Plafond de sortie par appel : réglé sur le maximum du modèle
  claudeMaxTokens: Number(process.env.CLAUDE_MAX_TOKENS) || 32000,
  // Modèles proposés dans le générateur (outil 1). Fable 5.2 raisonne
  // longuement et son raisonnement est facturé en tokens de sortie : son
  // plafond est relevé au maximum du modèle (128K) pour que les demandes
  // complexes aillent au bout. estimateEur : prix indicatif par objet tant
  // qu'aucune génération réelle ne fournit de moyenne.
  genModels: {
    opus: {
      id: 'claude-opus-5-5',
      label: 'Opus 5.5',
      hint: 'équilibré, ~2× moins cher',
      maxTokens: Number(process.env.CLAUDE_MAX_TOKENS) || 64000,
      estimateEur: 0.6,
    },
    fable: {
      id: 'claude-fable-5-2',
      label: 'Fable 5.2',
      hint: 'qualité maximale, raisonnement long',
      maxTokens: 128000,
      estimateEur: 1.3,
    },
  },
  // Choix présélectionné dans l'interface : suit CLAUDE_MODEL_CODE (.env)
  defaultGenModel: (process.env.CLAUDE_MODEL_CODE || '').includes('fable') ? 'fable' : 'opus',
  maxFixIterations: Number(process.env.MAX_FIX_ITERATIONS) || 3,
  // Taux de conversion USD -> EUR pour l'affichage des coûts
  usdEurRate: Number(process.env.USD_EUR_RATE) || 0.86,

  blender: {
    host: process.env.BLENDER_MCP_HOST || '127.0.0.1',
    port: Number(process.env.BLENDER_MCP_PORT) || 9876,
  },
};

for (const dir of [config.scenesDir, config.libraryDir, config.layoutsDir, config.blenderOutDir, config.thumbsDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

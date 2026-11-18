// Durcissement HTTP : en-têtes de sécurité, rate limiting, contrôle d'origine.
import { config } from './config.js';

// --- En-têtes de sécurité (équivalent helmet, sans dépendance) ---
export function securityHeaders(req, res, next) {
  res.set({
    'Content-Security-Policy': [
      "default-src 'self'",
      // Le hash autorise uniquement l'importmap three.js inline des pages
      "script-src 'self' 'wasm-unsafe-eval' https://unpkg.com 'sha256-2ft/QrsUx9wZtGuUh3f5GY9flBIGgXs/te/W6a0n+tQ='",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' blob: data:",
      // blob:/data: nécessaires aux textures embarquées des GLB (three.js les
      // charge via fetch sur des URLs blob)
      "connect-src 'self' blob: data: https://unpkg.com",
      "worker-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  if (config.isProduction) {
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

// --- Anti-CSRF : les mutations doivent venir de notre propre origine ---
export function checkOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('Origin') || req.get('Referer') || '';
  if (!origin) return next(); // requêtes same-origin sans header (curl local, anciens navigateurs)
  try {
    const host = new URL(origin).host;
    if (host === req.get('Host')) return next();
  } catch { /* URL invalide -> refus */ }
  return res.status(403).json({ error: 'Origine non autorisée' });
}

// --- Rate limiting en mémoire (fenêtre glissante) ---
const buckets = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of buckets) {
    if (entry.reset < now) buckets.delete(key);
  }
}, 60 * 1000).unref();

export function rateLimit({ windowMs, max, keyPrefix }) {
  return (req, res, next) => {
    const key = `${keyPrefix}:${req.ip}`;
    const now = Date.now();
    let entry = buckets.get(key);
    if (!entry || entry.reset < now) {
      entry = { count: 0, reset: now + windowMs };
      buckets.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.reset - now) / 1000)));
      return res.status(429).json({ error: 'Trop de requêtes, réessayez plus tard.' });
    }
    next();
  };
}

// Nom de fichier sûr (anti-traversée de chemin)
export function safeFilename(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 120) return null;
  if (!/^[\w][\w .\-éèêàùûôîïç()]*\.(glb|gltf|obj|stl)$/i.test(name)) return null;
  if (name.includes('..') || name.includes('/') || name.includes('\\')) return null;
  return name;
}

// Vérifie l'en-tête magique d'un fichier GLB ("glTF")
export function isGlb(buffer) {
  return buffer.length > 12 && buffer.toString('ascii', 0, 4) === 'glTF';
}

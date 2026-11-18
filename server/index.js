// French Flair — Moda : serveur principal.
// Pages et API protégées par authentification (email @frenchflair.pro + code OTP).
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import { securityHeaders, checkOrigin, rateLimit, safeFilename } from './security.js';
import { cookieParser, sessionMiddleware, requireAuth, requireAuthPage, authRouter } from './auth.js';
import { apiRouter } from './routes.js';
import { isClaudeConfigured } from './claude.js';
import { isSmtpConfigured } from './mailer.js';

const app = express();
app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', 1);

app.use(securityHeaders);
app.use(checkOrigin);
app.use(rateLimit({ windowMs: 60 * 1000, max: 300, keyPrefix: 'global' }));
app.use(cookieParser);
app.use(sessionMiddleware);

// --- Pages ---
const page = (name) => (req, res) => res.sendFile(path.join(config.publicDir, name));

app.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.sendFile(path.join(config.publicDir, 'login.html'));
});
app.get('/', requireAuthPage, page('hub.html'));
app.get('/generator', requireAuthPage, page('generator.html'));
app.get('/editor', requireAuthPage, page('editor.html'));
app.get('/charte', requireAuthPage, (req, res) => res.sendFile(path.join(config.root, 'index.html')));

// --- API ---
app.use('/api/auth', express.json({ limit: '8kb' }), authRouter);
app.use('/api', requireAuth, apiRouter);

// --- Fichiers 3D (protégés : ce sont les assets du studio) ---
function serveModel(dir) {
  return (req, res) => {
    const name = safeFilename(String(req.params.file || ''));
    if (!name) return res.status(400).end();
    const file = path.join(dir, name);
    if (!file.startsWith(dir) || !fs.existsSync(file)) return res.status(404).end();
    const types = { '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.obj': 'text/plain', '.stl': 'application/octet-stream' };
    res.type(types[path.extname(name).toLowerCase()] || 'application/octet-stream');
    res.sendFile(file);
  };
}
app.get('/library/:file', requireAuth, serveModel(config.libraryDir));
app.get('/scenes/:file', requireAuth, serveModel(config.scenesDir));

// Vignettes de la bibliothèque (photo de l'asset)
app.get('/thumbs/:file', requireAuth, (req, res) => {
  const name = safeFilename(String(req.params.file || ''));
  if (!name) return res.status(400).end();
  const file = path.join(config.thumbsDir, name + '.png');
  if (!file.startsWith(config.thumbsDir) || !fs.existsSync(file)) return res.status(404).end();
  res.type('image/png').sendFile(file);
});

// --- Statiques (css, js, fonts — pas de contenu sensible) ---
app.use(express.static(config.publicDir, { index: false, dotfiles: 'deny' }));

app.use((req, res) => res.status(404).send('Page introuvable'));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[server]', err.message);
  res.status(err.status || 500).json({ error: config.isProduction ? 'Erreur serveur' : String(err.message) });
});

app.listen(config.port, () => {
  console.log(`\n  French Flair — Moda`);
  console.log(`  http://localhost:${config.port}`);
  console.log(`  Auth    : @${config.authDomain} ${isSmtpConfigured() ? '(SMTP configuré)' : '(mode dev : code OTP affiché ici)'}`);
  console.log(`  Claude  : ${isClaudeConfigured() ? `OK (code: ${config.claudeModels.code} | spec/vérif: ${config.claudeModels.spec})` : 'non configuré → générateur en mode démo'}`);
  console.log(`  Blender : ${config.blender.host}:${config.blender.port} (docker compose up -d blender)\n`);
});

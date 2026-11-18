// Routes API (toutes derrière requireAuth) : bibliothèque d'assets, scènes,
// layouts de l'éditeur, jobs du générateur.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { config } from './config.js';
import { db } from './db.js';
import { safeFilename, isGlb, rateLimit } from './security.js';
import { isClaudeConfigured } from './claude.js';
import { blender } from './blender.js';
import { isSmtpConfigured } from './mailer.js';
import {
  createJob, getJob, listJobs, jobDir, approveJob, rejectJob, cancelJob, deleteJob,
  runOnBlenderQueue,
} from './pipeline.js';

export const apiRouter = express.Router();

const MODEL_EXTS = ['.glb', '.gltf', '.obj', '.stl'];

// Les fichiers déposés à la main dans assets/ apparaissent aussi en bibliothèque
function syncLibrary() {
  const files = fs.readdirSync(config.libraryDir)
    .filter((f) => MODEL_EXTS.includes(path.extname(f).toLowerCase()));
  const insert = db.prepare(
    `INSERT OR IGNORE INTO assets (filename, display_name, created_at, source)
     VALUES (?, ?, ?, 'imported')`
  );
  for (const f of files) {
    insert.run(f, f.replace(/\.(glb|gltf|obj|stl)$/i, ''), Date.now());
  }
  return files;
}

// --- Vignettes : rendu Blender des assets qui n'ont pas encore de photo ---
const pendingThumbs = new Set();

function thumbPath(filename) {
  return path.join(config.thumbsDir, filename + '.png');
}

function ensureThumb(filename) {
  if (fs.existsSync(thumbPath(filename)) || pendingThumbs.has(filename)) return;
  const src = path.join(config.libraryDir, filename);
  if (!fs.existsSync(src)) return;
  pendingThumbs.add(filename);

  const ext = path.extname(filename).toLowerCase();
  const importer = {
    '.glb': 'bpy.ops.import_scene.gltf',
    '.gltf': 'bpy.ops.import_scene.gltf',
    '.obj': 'bpy.ops.wm.obj_import',
    '.stl': 'bpy.ops.wm.stl_import',
  }[ext];
  if (!importer) {
    pendingThumbs.delete(filename);
    return;
  }

  runOnBlenderQueue(async () => {
    if (fs.existsSync(thumbPath(filename))) return;
    const work = path.join(config.blenderOutDir, 'thumbsrc');
    fs.mkdirSync(work, { recursive: true });
    const workFile = path.join(work, filename);
    fs.copyFileSync(src, workFile);
    try {
      await blender.resetScene();
      await blender.executeCode(
        `import bpy\n${importer}(filepath='/output/thumbsrc/${filename}')\nprint('DONE')`
      );
      await blender.renderViews('thumbsrc/out', { resolution: 512, samples: 16 });
      const render = path.join(config.blenderOutDir, 'thumbsrc/out/render_trois_quarts.png');
      if (fs.existsSync(render)) fs.copyFileSync(render, thumbPath(filename));
    } finally {
      fs.rmSync(workFile, { force: true });
    }
  })
    .catch((err) => console.error('[thumb]', filename, ':', err.message))
    .finally(() => pendingThumbs.delete(filename));
}

// --- État des services (pour les bandeaux de l'interface) ---
apiRouter.get('/status', async (req, res) => {
  res.json({
    claude: isClaudeConfigured(),
    blender: await blender.isUp(),
    smtp: isSmtpConfigured(),
  });
});

// --- Bibliothèque d'assets (le "drive" local, synchro Google Drive à venir) ---
apiRouter.get('/assets', (req, res) => {
  const onDisk = new Set(syncLibrary());
  const rows = db
    .prepare('SELECT id, filename, display_name, prompt, created_by, created_at, source, placement FROM assets ORDER BY created_at DESC')
    .all()
    .filter((r) => onDisk.has(r.filename))
    .map((r) => {
      const hasThumb = fs.existsSync(thumbPath(r.filename));
      if (!hasThumb) ensureThumb(r.filename); // rendu en arrière-plan
      return { ...r, has_thumb: hasThumb };
    });
  res.json(rows);
});

// Import direct d'un asset 3D dans la bibliothèque (.glb/.gltf/.obj/.stl)
apiRouter.post(
  '/assets/upload',
  rateLimit({ windowMs: 10 * 60 * 1000, max: 30, keyPrefix: 'asset-upload' }),
  express.raw({ type: '*/*', limit: '100mb' }),
  (req, res) => {
    const name = safeFilename(String(req.query.name || ''));
    const placement = String(req.query.placement) === 'mur' ? 'mur' : 'sol';
    const displayName = String(req.query.display || '').trim().slice(0, 80);
    if (!name) {
      return res.status(400).json({ error: 'Nom de fichier invalide (.glb, .gltf, .obj ou .stl)' });
    }
    if (!Buffer.isBuffer(req.body) || req.body.length < 50) {
      return res.status(400).json({ error: 'Fichier vide ou illisible' });
    }
    if (name.toLowerCase().endsWith('.glb') && !isGlb(req.body)) {
      return res.status(400).json({ error: 'Le fichier n\'est pas un GLB valide' });
    }
    // Pas d'écrasement silencieux d'un asset existant
    let filename = name;
    const ext = path.extname(name);
    const base = path.basename(name, ext);
    let i = 2;
    while (fs.existsSync(path.join(config.libraryDir, filename))) {
      filename = `${base}-${i++}${ext}`;
    }
    fs.writeFileSync(path.join(config.libraryDir, filename), req.body);
    db.prepare(
      `INSERT INTO assets (filename, display_name, created_by, created_at, source, placement)
       VALUES (?, ?, ?, ?, 'imported', ?)`
    ).run(filename, displayName || base, req.user.email, Date.now(), placement);
    ensureThumb(filename); // photo rendue en arrière-plan par Blender
    res.json({ ok: true, filename, placement });
  }
);

// Changement du type de placement (sol <-> mur) d'un asset
apiRouter.patch('/assets/:id', express.json({ limit: '4kb' }), (req, res) => {
  const placement = req.body?.placement === 'mur' ? 'mur' : 'sol';
  const result = db
    .prepare('UPDATE assets SET placement = ? WHERE id = ?')
    .run(placement, Number(req.params.id));
  if (result.changes === 0) return res.status(404).json({ error: 'Asset introuvable' });
  res.json({ ok: true, placement });
});

apiRouter.delete('/assets/:id', (req, res) => {
  const row = db.prepare('SELECT filename FROM assets WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Asset introuvable' });
  const file = path.join(config.libraryDir, row.filename);
  db.prepare('DELETE FROM assets WHERE id = ?').run(Number(req.params.id));
  if (fs.existsSync(file)) fs.unlinkSync(file);
  fs.rmSync(thumbPath(row.filename), { force: true });
  res.json({ ok: true });
});

// --- Affiches murales : image (PNG converti côté client) -> poster 3D encadré ---
function slugify(s, fallback) {
  const base = String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base || fallback;
}

apiRouter.post(
  '/posters',
  rateLimit({ windowMs: 10 * 60 * 1000, max: 20, keyPrefix: 'poster' }),
  express.raw({ type: '*/*', limit: '25mb' }),
  async (req, res) => {
    const displayName = String(req.query.name || '').trim().slice(0, 60) || 'affiche';
    const heightM = Math.min(Math.max(Number(req.query.height_cm) || 80, 10), 500) / 100;
    const body = req.body;
    // L'image arrive toujours en PNG (convertie par le navigateur)
    if (!Buffer.isBuffer(body) || body.length < 100 || body.readUInt32BE(0) !== 0x89504e47) {
      return res.status(400).json({ error: 'Image invalide (PNG attendu)' });
    }

    const id = crypto.randomBytes(8).toString('hex');
    const postersDir = path.join(config.blenderOutDir, 'posters');
    fs.mkdirSync(postersDir, { recursive: true });
    fs.writeFileSync(path.join(postersDir, `${id}.png`), body);

    const script = `
import bpy, math
img = bpy.data.images.load('/output/posters/${id}.png')
w_px, h_px = img.size
ratio = w_px / max(1, h_px)
H = ${heightM}
W = H * ratio
FRAME = max(0.015, H * 0.03)
DEPTH = 0.02

def mat(name, color, rough=0.5):
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*color, 1.0)
    b.inputs['Roughness'].default_value = rough
    return m

# Cadre : dos plaque en Y=0, epaisseur vers -Y (convention des assets muraux)
bpy.ops.mesh.primitive_cube_add(location=(0, -DEPTH / 2, 0))
cadre = bpy.context.object; cadre.name = 'cadre'
cadre.scale = ((W + 2 * FRAME) / 2, DEPTH / 2, (H + 2 * FRAME) / 2)
cadre.data.materials.append(mat('cadre', (0.05, 0.04, 0.08)))

# Image sur la face avant
bpy.ops.mesh.primitive_plane_add(size=1, location=(0, -DEPTH - 0.001, 0), rotation=(math.radians(90), 0, 0))
pl = bpy.context.object; pl.name = 'affiche'
pl.scale = (W, H, 1)
m = bpy.data.materials.new('image'); m.use_nodes = True
b = m.node_tree.nodes['Principled BSDF']
tex = m.node_tree.nodes.new('ShaderNodeTexImage'); tex.image = img
m.node_tree.links.new(tex.outputs['Color'], b.inputs['Base Color'])
b.inputs['Roughness'].default_value = 0.7
pl.data.materials.append(m)

for o in (cadre, pl):
    o.select_set(True)
bpy.context.view_layer.objects.active = cadre
bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
print('DONE')
`;

    try {
      await runOnBlenderQueue(async () => {
        await blender.resetScene();
        await blender.executeCode(script);
        await blender.exportGlb(`posters/${id}.glb`);
      });
    } catch (err) {
      return res.status(502).json({ error: `Blender : ${String(err.message || err)}` });
    }

    const base = slugify(displayName, 'affiche');
    let filename = `${base}.glb`;
    let i = 2;
    while (fs.existsSync(path.join(config.libraryDir, filename))) {
      filename = `${base}-${i++}.glb`;
    }
    fs.copyFileSync(path.join(postersDir, `${id}.glb`), path.join(config.libraryDir, filename));
    // Vignette de l'affiche : l'image elle-même
    fs.copyFileSync(path.join(postersDir, `${id}.png`), path.join(config.thumbsDir, filename + '.png'));
    db.prepare(
      `INSERT INTO assets (filename, display_name, created_by, created_at, source, placement)
       VALUES (?, ?, ?, ?, 'affiche', 'mur')`
    ).run(filename, displayName, req.user.email, Date.now());
    res.json({ ok: true, filename });
  }
);

// --- Scènes (maps SketchUp -> GLB) ---
apiRouter.get('/scenes', (req, res) => {
  const files = fs.readdirSync(config.scenesDir)
    .filter((f) => MODEL_EXTS.includes(path.extname(f).toLowerCase()));
  res.json(files);
});

// Upload d'une map (.glb uniquement, 150 Mo max, en-tête magique vérifié)
apiRouter.post(
  '/scenes/upload',
  rateLimit({ windowMs: 10 * 60 * 1000, max: 20, keyPrefix: 'upload' }),
  express.raw({ type: 'application/octet-stream', limit: '150mb' }),
  (req, res) => {
    const name = safeFilename(String(req.query.name || ''));
    if (!name || !name.toLowerCase().endsWith('.glb')) {
      return res.status(400).json({ error: 'Nom de fichier invalide (attendu : .glb)' });
    }
    if (!Buffer.isBuffer(req.body) || !isGlb(req.body)) {
      return res.status(400).json({ error: 'Le fichier n\'est pas un GLB valide' });
    }
    fs.writeFileSync(path.join(config.scenesDir, name), req.body);
    res.json({ ok: true, name });
  }
);

// --- Layouts de l'éditeur de map ---
function layoutFile(scene) {
  return path.join(config.layoutsDir, scene + '.layout.json');
}

apiRouter.get('/layout', (req, res) => {
  const scene = safeFilename(String(req.query.scene || ''));
  if (!scene) return res.status(400).json({ error: 'Nom de scène invalide' });
  const file = layoutFile(scene);
  if (!fs.existsSync(file)) return res.json([]);
  res.type('application/json').send(fs.readFileSync(file));
});

apiRouter.post('/layout', express.json({ limit: '2mb' }), (req, res) => {
  const scene = safeFilename(String(req.query.scene || ''));
  if (!scene) return res.status(400).json({ error: 'Nom de scène invalide' });
  if (!Array.isArray(req.body)) return res.status(400).json({ error: 'Layout invalide' });
  // id / parent : objet posé sur un autre (souris sur un bureau)
  const layoutId = (v) => (typeof v === 'string' && /^[\w-]{1,40}$/.test(v) ? v : undefined);
  const clean = req.body.slice(0, 5000).map((o) => ({
    id: layoutId(o.id),
    parent: layoutId(o.parent) || null,
    asset: safeFilename(String(o.asset || '')) || null,
    x: Number(o.x) || 0,
    y: Number(o.y) || 0,
    z: Number(o.z) || 0,
    rotY: Number(o.rotY) || 0,
    qx: Number(o.qx) || 0,
    qy: Number(o.qy) || 0,
    qz: Number(o.qz) || 0,
    qw: typeof o.qw === 'number' ? Number(o.qw) : undefined,
    scale: Math.min(Math.max(Number(o.scale) || 1, 0.01), 100),
  })).filter((o) => o.asset);
  fs.writeFileSync(layoutFile(scene), JSON.stringify(clean));
  res.json({ ok: true, count: clean.length });
});

// --- Générateur d'assets (outil 1) ---

// Modèles disponibles + prix moyen par objet (moyenne des générations réelles
// terminées ; estimation indicative tant qu'il n'y a pas de données).
apiRouter.get('/generate/options', (req, res) => {
  const stats = db
    .prepare(
      `SELECT model, COUNT(*) AS n, AVG(cost_usd) AS avg_usd FROM jobs
       WHERE demo = 0 AND cost_usd > 0 AND status IN ('review', 'approved', 'rejected')
       GROUP BY model`
    )
    .all();
  const byModel = Object.fromEntries(stats.map((s) => [s.model, s]));
  res.json({
    default: config.defaultGenModel,
    models: Object.entries(config.genModels).map(([key, m]) => {
      const s = byModel[key];
      return {
        key,
        label: m.label,
        hint: m.hint,
        maxTokens: m.maxTokens,
        avgCostEur: s ? s.avg_usd * config.usdEurRate : m.estimateEur,
        jobCount: s ? s.n : 0,
        estimated: !s,
      };
    }),
  });
});

apiRouter.post(
  '/generate',
  rateLimit({ windowMs: 10 * 60 * 1000, max: 10, keyPrefix: 'gen' }),
  express.json({ limit: '32kb' }),
  (req, res) => {
    const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
    const demo = Boolean(req.body?.demo) || !isClaudeConfigured();
    if (!demo && (prompt.length < 3 || prompt.length > 2000)) {
      return res.status(400).json({ error: 'Décrivez l\'asset en 3 à 2000 caractères.' });
    }
    const model = typeof req.body?.model === 'string' ? req.body.model : undefined;
    const id = createJob(req.user.email, prompt || '(asset de démonstration)', demo, model);
    res.json({ id, demo });
  }
);

apiRouter.get('/jobs', (req, res) => {
  res.json(
    listJobs(req.user.email).map((j) => ({
      ...j,
      cost_eur: (j.cost_usd || 0) * config.usdEurRate,
    }))
  );
});

// Efface l'historique des générations de l'utilisateur (les générations en
// cours et les assets déjà validés en bibliothèque ne sont pas touchés)
apiRouter.delete('/jobs', (req, res) => {
  const rows = db
    .prepare("SELECT id FROM jobs WHERE email = ? AND status NOT IN ('queued', 'running')")
    .all(req.user.email);
  const del = db.prepare('DELETE FROM jobs WHERE id = ?');
  for (const r of rows) {
    del.run(r.id);
    fs.rmSync(jobDir(r.id), { recursive: true, force: true });
  }
  res.json({ ok: true, deleted: rows.length });
});

// Annulation d'une génération en attente ou en cours
apiRouter.post('/jobs/:id/cancel', (req, res) => {
  try {
    cancelJob(String(req.params.id), req.user.email);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

// Suppression d'une génération terminée de l'historique
apiRouter.delete('/jobs/:id', (req, res) => {
  try {
    deleteJob(String(req.params.id), req.user.email);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

apiRouter.get('/jobs/:id', (req, res) => {
  const job = getJob(String(req.params.id));
  if (!job || job.email !== req.user.email) return res.status(404).json({ error: 'Job introuvable' });
  res.json({
    ...job,
    spec: job.spec ? JSON.parse(job.spec) : null,
    problems: job.problems ? JSON.parse(job.problems) : [],
  });
});

function jobFile(req, res, filename, type) {
  const job = getJob(String(req.params.id));
  if (!job || job.email !== req.user.email) return res.status(404).end();
  const file = path.join(jobDir(job.id), filename);
  if (!fs.existsSync(file)) return res.status(404).end();
  res.type(type).send(fs.readFileSync(file));
}

apiRouter.get('/jobs/:id/preview.glb', (req, res) =>
  jobFile(req, res, 'asset.glb', 'model/gltf-binary'));

apiRouter.get('/jobs/:id/render/:view.png', (req, res) => {
  const view = String(req.params.view);
  if (!['face', 'trois_quarts', 'arriere', 'dessus'].includes(view)) return res.status(400).end();
  jobFile(req, res, `render_${view}.png`, 'image/png');
});

apiRouter.post('/jobs/:id/approve', express.json({ limit: '8kb' }), (req, res) => {
  const job = getJob(String(req.params.id));
  if (!job || job.email !== req.user.email) return res.status(404).json({ error: 'Job introuvable' });
  try {
    const filename = approveJob(
      job.id,
      typeof req.body?.name === 'string' ? req.body.name.trim() : '',
      req.body?.placement
    );
    res.json({ ok: true, filename });
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

apiRouter.post('/jobs/:id/reject', express.json({ limit: '8kb' }), (req, res) => {
  const job = getJob(String(req.params.id));
  if (!job || job.email !== req.user.email) return res.status(404).json({ error: 'Job introuvable' });
  try {
    const result = rejectJob(job.id, typeof req.body?.comment === 'string' ? req.body.comment.trim().slice(0, 2000) : '');
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

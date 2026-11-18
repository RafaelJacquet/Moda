// Pipeline de génération d'un asset 3D (outil 1) :
// demande -> spec (Claude) -> script bpy (Claude) -> exécution (Blender MCP)
// -> rendus -> vérification visuelle (Claude) -> corrections -> revue humaine.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { db } from './db.js';
import { blender } from './blender.js';
import {
  enrichSpec, generateScript, fixScript, verifyAsset, isClaudeConfigured, trackUsage,
} from './claude.js';

const JOBS_SUBDIR = 'jobs'; // relatif à data/blender (volume partagé avec le conteneur)

// Les jobs interrompus par un redémarrage du serveur sont marqués en échec
db.prepare(
  `UPDATE jobs SET status = 'failed', error = 'Serveur redémarré pendant la génération'
   WHERE status IN ('queued', 'running')`
).run();

// Script de démonstration (aucune clé API nécessaire) : plante stylisée en pot.
const DEMO_SPEC = {
  name: 'plante-demo',
  description: 'Plante stylisée low-poly en pot (asset de démonstration, sans IA)',
  dimensions_m: { x: 0.4, y: 0.4, z: 0.9 },
  style: 'low-poly',
  realism_notes: 'Mode démo : configurez ANTHROPIC_API_KEY pour la génération réelle.',
  parts: ['pot', 'terre', 'tronc', 'feuillage'],
  materials: [],
  polycount_target: 2000,
  placement: 'sol',
};

const DEMO_SCRIPT = `
import bpy, math

def mat(name, color, rough=0.8, metal=0.0):
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*color, 1.0)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    return m

# Pot (cône tronqué)
bpy.ops.mesh.primitive_cone_add(vertices=16, radius1=0.14, radius2=0.18, depth=0.3, location=(0,0,0.15))
pot = bpy.context.object; pot.name = "pot"
pot.data.materials.append(mat("terracotta", (0.72, 0.32, 0.18)))

# Terre
bpy.ops.mesh.primitive_cylinder_add(vertices=16, radius=0.16, depth=0.03, location=(0,0,0.295))
terre = bpy.context.object; terre.name = "terre"
terre.data.materials.append(mat("terre", (0.18, 0.11, 0.07), rough=1.0))

# Tronc
bpy.ops.mesh.primitive_cylinder_add(vertices=10, radius=0.025, depth=0.35, location=(0,0,0.47))
tronc = bpy.context.object; tronc.name = "tronc"
tronc.data.materials.append(mat("bois", (0.35, 0.22, 0.12)))

# Feuillage (3 icosphères)
feuille = mat("feuilles", (0.18, 0.52, 0.25), rough=0.9)
for i, (dx, dy, dz, r) in enumerate([(0,0,0.76,0.16), (0.1,0.04,0.66,0.11), (-0.09,-0.05,0.68,0.10)]):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=r, location=(dx,dy,dz))
    f = bpy.context.object; f.name = f"feuillage_{i}"
    f.data.materials.append(feuille)

for o in bpy.data.objects:
    o.select_set(True)
bpy.context.view_layer.objects.active = pot
bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
print("DONE")
`;

// --- File d'attente : un seul job Blender à la fois ---
let queue = Promise.resolve();

// Exécute une tâche Blender ponctuelle (ex. création d'affiche) dans la même
// file que les générations : jamais deux usages simultanés de la scène Blender.
export function runOnBlenderQueue(fn) {
  const run = queue.then(fn);
  queue = run.then(() => {}, () => {});
  return run;
}

// Jobs dont l'annulation a été demandée (vérifié entre chaque étape)
const cancelRequested = new Set();

class CancelledError extends Error {
  constructor() {
    super('Génération annulée par l\'utilisateur');
    this.cancelled = true;
  }
}

function enqueue(id) {
  queue = queue
    .then(() => runPipeline(id))
    .catch((err) => {
      if (err?.cancelled) {
        updateJob(id, { status: 'cancelled', step: "Annulée par l'utilisateur" });
      } else {
        console.error(`[pipeline] job ${id} :`, err);
        updateJob(id, { status: 'failed', error: String(err.message || err) });
      }
    })
    .finally(() => {
      cancelRequested.delete(id);
      trackUsage(null);
    });
}

function updateJob(id, fields) {
  const keys = Object.keys(fields);
  const sql = `UPDATE jobs SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`;
  db.prepare(sql).run(...keys.map((k) => fields[k]), Date.now(), id);
}

export function getJob(id) {
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
}

export function listJobs(email, limit = 20) {
  return db
    .prepare('SELECT id, prompt, status, step, iteration, problems, error, demo, model, created_at, updated_at, tokens_in, tokens_out, cost_usd FROM jobs WHERE email = ? ORDER BY created_at DESC LIMIT ?')
    .all(email, limit);
}

export function jobDir(id) {
  return path.join(config.blenderOutDir, JOBS_SUBDIR, id);
}

export function createJob(email, prompt, demo, model) {
  const id = crypto.randomBytes(8).toString('hex');
  const now = Date.now();
  const modelKey = config.genModels[model] ? model : config.defaultGenModel;
  db.prepare(
    `INSERT INTO jobs (id, email, prompt, status, step, demo, model, created_at, updated_at)
     VALUES (?, ?, ?, 'queued', 'file d''attente', ?, ?, ?, ?)`
  ).run(id, email, prompt, demo ? 1 : 0, modelKey, now, now);

  enqueue(id);
  return id;
}

// --- Annulation / suppression ---

export function cancelJob(id, email) {
  const job = getJob(id);
  if (!job || job.email !== email) throw new Error('Génération introuvable');
  if (!['queued', 'running'].includes(job.status)) throw new Error('Cette génération est déjà terminée');
  cancelRequested.add(id);
  if (job.status === 'queued') {
    // Pas encore démarrée : annulée immédiatement (runPipeline la sautera)
    updateJob(id, { status: 'cancelled', step: "Annulée par l'utilisateur" });
  } else {
    updateJob(id, { step: "Annulation (fin de l'étape en cours)…" });
  }
}

export function deleteJob(id, email) {
  const job = getJob(id);
  if (!job || job.email !== email) throw new Error('Génération introuvable');
  if (['queued', 'running'].includes(job.status)) {
    throw new Error('Annulez la génération avant de la supprimer');
  }
  db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
  fs.rmSync(jobDir(id), { recursive: true, force: true });
}

async function runPipeline(id) {
  const job = getJob(id);
  if (!job || job.status !== 'queued') return;
  const assertActive = () => {
    if (cancelRequested.has(id)) throw new CancelledError();
  };
  const demo = Boolean(job.demo);
  // Modèle de modélisation choisi à la création du job (plafond de tokens inclus)
  const gen = config.genModels[job.model] || config.genModels[config.defaultGenModel] || {};
  const dir = jobDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const relDir = path.posix.join(JOBS_SUBDIR, id);

  // Consommation : cumulée et persistée après chaque appel Claude
  // (la file est séquentielle, un seul job utilise Claude à la fois)
  let tokensIn = 0;
  let tokensOut = 0;
  let costUsd = 0;
  trackUsage((u) => {
    tokensIn += u.tokensIn;
    tokensOut += u.tokensOut;
    costUsd += u.costUsd;
    updateJob(id, { tokens_in: tokensIn, tokens_out: tokensOut, cost_usd: costUsd });
  });

  if (!(await blender.isUp())) {
    throw new Error("Le conteneur Blender n'est pas joignable. Lancez : npm run blender");
  }

  // 1. Spécification
  updateJob(id, { status: 'running', step: 'Enrichissement de la demande (Claude)' });
  let spec;
  let script;
  if (demo) {
    spec = DEMO_SPEC;
    script = DEMO_SCRIPT;
  } else {
    spec = await enrichSpec(job.prompt);
  }
  updateJob(id, { spec: JSON.stringify(spec), placement: spec.placement === 'mur' ? 'mur' : 'sol' });
  assertActive();

  let problems = [];
  let execError = null;
  let lastVerdict = null;

  for (let iteration = 0; iteration <= config.maxFixIterations; iteration++) {
    assertActive();
    updateJob(id, { iteration });

    // 2. Script bpy
    if (!demo) {
      if (iteration === 0) {
        updateJob(id, { step: `Génération du code Blender (${gen.label || 'Claude'})` });
        script = await generateScript(spec, job.prompt, gen);
      } else {
        updateJob(id, { step: `Correction du modèle (itération ${iteration})` });
        script = await fixScript(spec, job.prompt, script, problems, execError, gen);
      }
    }
    fs.writeFileSync(path.join(dir, `script_${iteration}.py`), script);
    assertActive();

    // 3. Exécution dans Blender
    updateJob(id, { step: 'Modélisation dans Blender' });
    execError = null;
    try {
      await blender.resetScene();
      const result = await blender.executeCode(script);
      fs.writeFileSync(path.join(dir, `output_${iteration}.log`), result.output || '');
    } catch (err) {
      execError = String(err.message || err);
      if (demo) throw err; // le script démo ne doit jamais planter
      if (iteration >= config.maxFixIterations) {
        throw new Error(`Échec de modélisation après ${iteration + 1} tentatives : ${execError}`);
      }
      problems = [];
      continue; // nouvelle itération avec l'erreur
    }

    const summary = await blender.sceneSummary();
    if (!summary.bbox) {
      execError = 'La scène est vide après exécution du script (aucun mesh créé).';
      if (demo || iteration >= config.maxFixIterations) throw new Error(execError);
      problems = [];
      continue;
    }

    // 4. Rendus de contrôle
    assertActive();
    updateJob(id, { step: 'Rendus de contrôle' });
    await blender.renderViews(relDir, { resolution: 384, samples: 14 });
    assertActive();

    // 5. Vérification par Claude (sautée en mode démo)
    if (demo || !isClaudeConfigured()) {
      lastVerdict = { valid: true, score: 7, problems: [], placement: spec.placement === 'mur' ? 'mur' : 'sol' };
    } else {
      updateJob(id, { step: "Vérification de l'asset (Claude)" });
      const images = ['face', 'trois_quarts', 'arriere', 'dessus'].map((v) =>
        path.join(dir, `render_${v}.png`)
      ).filter((p) => fs.existsSync(p));
      lastVerdict = await verifyAsset(job.prompt, spec, images, summary);
    }
    updateJob(id, { problems: JSON.stringify(lastVerdict.problems) });

    if (lastVerdict.valid || iteration >= config.maxFixIterations) break;
    problems = lastVerdict.problems;
  }

  // 6. Export GLB + revue humaine
  assertActive();
  updateJob(id, { step: 'Export GLB' });
  await blender.exportGlb(path.posix.join(relDir, 'asset.glb'));

  updateJob(id, {
    status: 'review',
    step: lastVerdict.valid
      ? 'Validé par l\'IA — en attente de validation humaine'
      : 'Problèmes restants — à vérifier par un humain',
    problems: JSON.stringify(lastVerdict.problems),
    placement: lastVerdict.placement === 'mur' ? 'mur' : 'sol',
  });
}

// --- Validation humaine ---

export function approveJob(id, displayName, placementOverride) {
  const job = getJob(id);
  if (!job || job.status !== 'review') throw new Error('Job non prêt pour validation');

  const glb = path.join(jobDir(id), 'asset.glb');
  if (!fs.existsSync(glb)) throw new Error('Fichier GLB introuvable');

  const spec = job.spec ? JSON.parse(job.spec) : {};
  const base = (displayName || spec.name || 'asset')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'asset';

  let filename = `${base}.glb`;
  let i = 2;
  while (fs.existsSync(path.join(config.libraryDir, filename))) {
    filename = `${base}-${i++}.glb`;
  }
  fs.copyFileSync(glb, path.join(config.libraryDir, filename));

  // Photo de la bibliothèque : le rendu "vue d'ensemble" fait à la génération
  const render = path.join(jobDir(id), 'render_trois_quarts.png');
  if (fs.existsSync(render)) {
    fs.copyFileSync(render, path.join(config.thumbsDir, filename + '.png'));
  }

  const placement =
    placementOverride === 'mur' || placementOverride === 'sol'
      ? placementOverride
      : job.placement === 'mur' ? 'mur' : 'sol';
  db.prepare(
    `INSERT INTO assets (filename, display_name, prompt, created_by, created_at, source, placement)
     VALUES (?, ?, ?, ?, ?, 'generated', ?)`
  ).run(filename, displayName || spec.name || base, job.prompt, job.email, Date.now(), placement);

  updateJob(id, { status: 'approved', step: `Ajouté à la bibliothèque : ${filename}` });
  return filename;
}

export function rejectJob(id, comment) {
  const job = getJob(id);
  if (!job || job.status !== 'review') throw new Error('Job non prêt');
  if (comment && !job.demo && isClaudeConfigured()) {
    // Le commentaire humain relance une itération de correction
    const now = Date.now();
    const newId = crypto.randomBytes(8).toString('hex');
    db.prepare(
      `INSERT INTO jobs (id, email, prompt, status, step, demo, model, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', 'file d''attente', 0, ?, ?, ?)`
    ).run(newId, job.email, `${job.prompt}\n\nCorrections demandées par l'humain : ${comment}`, job.model, now, now);
    updateJob(id, { status: 'rejected', step: `Rejeté — relancé en job ${newId}` });
    enqueue(newId);
    return { relaunched: newId };
  }
  updateJob(id, { status: 'rejected', step: 'Rejeté par l\'humain' });
  return { relaunched: null };
}

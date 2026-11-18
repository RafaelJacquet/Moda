// Outil 1 — Générateur d'assets 3D : demande -> pipeline IA -> revue humaine.
// + création d'affiches murales à partir d'une image (poster 3D construit par Blender).
import { initTopbar, fetchStatus } from '/topbar.js';
import { createViewer } from '/viewer3d.js';

initTopbar('/generator');

const form = document.getElementById('gen-form');
const promptInput = document.getElementById('prompt');
const genBtn = document.getElementById('gen-btn');
const stepsEl = document.getElementById('steps');
const problemsEl = document.getElementById('problems');
const jobErrorEl = document.getElementById('job-error');
const pipelineSection = document.getElementById('pipeline-section');
const jobListEl = document.getElementById('job-list');
const reviewBar = document.getElementById('review-bar');
const assetNameInput = document.getElementById('asset-name');
const statusEl = document.getElementById('status');

const viewer = createViewer(document.getElementById('viewer'));

let demoMode = false;
let currentJobId = null;
let pollTimer = null;
let genModel = 'opus'; // clé du modèle de modélisation sélectionné
const MODEL_LABELS = {}; // clé -> libellé, rempli par loadModelOptions()

// --- Choix du modèle (Opus / Fable) avec prix moyen par objet ---
const pickerEl = document.getElementById('model-picker');

async function loadModelOptions() {
  try {
    const res = await fetch('/api/generate/options');
    if (!res.ok) return;
    const data = await res.json();
    genModel = data.default;
    pickerEl.innerHTML = data.models.map((m) => {
      MODEL_LABELS[m.key] = m.label;
      const price = (m.avgCostEur ?? 0).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const source = m.estimated ? 'estimation' : `moy. sur ${m.jobCount} objet${m.jobCount > 1 ? 's' : ''}`;
      return `
      <label class="model-opt">
        <input type="radio" name="gen-model" value="${m.key}" ${m.key === data.default ? 'checked' : ''} />
        <span class="mo-body">
          <strong>${escapeHtml(m.label)}</strong>
          <small>${escapeHtml(m.hint || '')}</small>
          <em class="mo-price">≈ ${price} € / objet <small>(${source})</small></em>
        </span>
      </label>`;
    }).join('');
    pickerEl.querySelectorAll('input[name="gen-model"]').forEach((input) =>
      input.addEventListener('change', () => { genModel = input.value; })
    );
    refreshJobList(); // ré-affiche l'historique avec les badges de modèle
  } catch { /* le sélecteur est optionnel : le serveur a un modèle par défaut */ }
}
loadModelOptions();

function showStatus(msg, autoHide = true) {
  statusEl.textContent = msg;
  statusEl.classList.add('visible');
  if (autoHide) setTimeout(() => statusEl.classList.remove('visible'), 3000);
}

// --- Bandeaux d'état des services ---
fetchStatus().then((s) => {
  demoMode = !s.claude;
  if (!s.claude) {
    const b = document.getElementById('mode-banner');
    b.textContent = '⚠ Claude API non configurée (.env → ANTHROPIC_API_KEY) : mode démo, un asset de démonstration sera généré.';
    b.classList.remove('hidden');
    genBtn.textContent = 'Générer un asset de démo';
    promptInput.placeholder = 'Mode démo : la description sera ignorée tant que la clé API n\'est pas configurée.';
  }
  if (!s.blender) {
    document.getElementById('blender-banner').classList.remove('hidden');
    genBtn.disabled = true;
    document.getElementById('poster-btn').disabled = true;
  }
});

// --- Pipeline : affichage des étapes ---
const STEP_LABELS = [
  ['queued', 'File d\'attente'],
  ['enrich', 'Enrichissement de la demande (Claude)'],
  ['model', 'Modélisation dans Blender'],
  ['render', 'Rendus de contrôle'],
  ['verify', 'Vérification par l\'IA'],
  ['review', 'Validation humaine'],
];

function stepIndexFor(job) {
  if (job.status === 'queued') return 0;
  const s = (job.step || '').toLowerCase();
  if (s.includes('enrichissement') || s.includes('génération du code')) return 1;
  if (s.includes('modélisation') || s.includes('correction')) return 2;
  if (s.includes('rendus')) return 3;
  if (s.includes('vérification') || s.includes('export')) return 4;
  if (job.status === 'review' || job.status === 'approved' || job.status === 'rejected') return 5;
  return 2;
}

function renderSteps(job) {
  pipelineSection.classList.remove('hidden');
  const idx = stepIndexFor(job);
  const failed = job.status === 'failed';
  stepsEl.innerHTML = STEP_LABELS.map(([, label], i) => {
    let cls = '';
    if (failed && i === idx) cls = 'failed';
    else if (i < idx || job.status === 'approved') cls = 'done';
    else if (i === idx && !['rejected', 'cancelled'].includes(job.status)) cls = 'active';
    const extra = i === 2 && job.iteration > 0 ? ` (itération ${job.iteration})` : '';
    const clickable = i === 1 && job.spec;
    return `<div class="step ${cls}${clickable ? ' clickable' : ''}" data-i="${i}"` +
      `${clickable ? ' title="Voir la demande enrichie par Claude"' : ''}>` +
      `<span class="dot"></span>${label}${extra}${clickable ? '<span class="step-eye">👁</span>' : ''}</div>`;
  }).join('');

  const enrichStep = stepsEl.querySelector('.step.clickable');
  if (enrichStep) {
    enrichStep.addEventListener('click', () =>
      openModal('Demande enrichie par Claude', formatSpec(job.spec))
    );
  }

  problemsEl.innerHTML = (job.problems || [])
    .map((p) => `<div class="problem">⚠ ${escapeHtml(p)}</div>`)
    .join('');

  jobErrorEl.classList.toggle('hidden', !job.error);
  if (job.error) {
    jobErrorEl.innerHTML =
      '✗ La génération a échoué — <button class="link-btn" id="show-error-btn">voir le détail</button>';
    document.getElementById('show-error-btn').addEventListener('click', () =>
      openModal("Détail de l'erreur", job.error)
    );
  }
}

// --- Fenêtre modale ---
const modal = document.getElementById('modal');
const modalTitle = document.getElementById('modal-title');
const modalBody = document.getElementById('modal-body');

function openModal(title, text) {
  modalTitle.textContent = title;
  modalBody.textContent = text;
  modal.classList.remove('hidden');
}
function closeModal() {
  modal.classList.add('hidden');
}
document.getElementById('modal-close').addEventListener('click', closeModal);
modal.addEventListener('click', (e) => {
  if (e.target === modal) closeModal();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});

// Présentation lisible de la spécification produite par Claude
function formatSpec(spec) {
  const d = spec.dimensions_m || {};
  const lines = [
    `Nom : ${spec.name || '—'}`,
    `Style : ${spec.style || '—'}`,
    `Dimensions : ${d.x ?? '?'} × ${d.y ?? '?'} × ${d.z ?? '?'} m (largeur × profondeur × hauteur)`,
    `Polygones max : ${spec.polycount_target ?? '—'}`,
    '',
    'Description :',
    spec.description || '—',
    '',
    'Réalisme / échelle :',
    spec.realism_notes || '—',
  ];
  if (Array.isArray(spec.parts) && spec.parts.length) {
    lines.push('', 'Parties :');
    spec.parts.forEach((p) => lines.push(`  • ${p}`));
  }
  if (Array.isArray(spec.materials) && spec.materials.length) {
    lines.push('', 'Matériaux :');
    spec.materials.forEach((m) =>
      lines.push(`  • ${m.part || '?'} : ${m.color_hex || '—'} (métal ${m.metallic ?? 0}, rugosité ${m.roughness ?? 1})`)
    );
  }
  return lines.join('\n');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// --- Suivi d'un job ---
async function pollJob(id) {
  clearInterval(pollTimer);
  currentJobId = id;
  reviewBar.classList.add('hidden');

  const tick = async () => {
    const res = await fetch(`/api/jobs/${id}`);
    if (!res.ok) return;
    const job = await res.json();
    renderSteps(job);

    if (job.status === 'review') {
      clearInterval(pollTimer);
      showStatus('Asset prêt — inspectez-le puis validez ou rejetez.', false);
      try {
        await viewer.loadGlb(`/api/jobs/${id}/preview.glb`);
      } catch { showStatus('Impossible de charger l\'aperçu 3D'); }
      assetNameInput.value = job.spec?.name || '';
      document.getElementById('asset-placement').value = job.placement === 'mur' ? 'mur' : 'sol';
      reviewBar.classList.remove('hidden');
      refreshJobList();
    } else if (['approved', 'rejected', 'failed', 'cancelled'].includes(job.status)) {
      clearInterval(pollTimer);
      refreshJobList();
      if (job.status === 'approved') showStatus('✓ ' + job.step);
      if (job.status === 'failed') showStatus('✗ Génération échouée', false);
    }
  };
  await tick();
  pollTimer = setInterval(tick, 2000);
}

// --- Lancement ---
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  genBtn.disabled = true;
  try {
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: promptInput.value.trim(), demo: demoMode, model: genModel }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur');
    showStatus(data.demo ? 'Génération démo lancée…' : 'Génération lancée…');
    pollJob(data.id);
    refreshJobList();
  } catch (err) {
    showStatus('✗ ' + err.message, false);
  } finally {
    genBtn.disabled = false;
  }
});

// --- Revue humaine ---
document.getElementById('approve-btn').addEventListener('click', async () => {
  if (!currentJobId) return;
  const res = await fetch(`/api/jobs/${currentJobId}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: assetNameInput.value.trim(),
      placement: document.getElementById('asset-placement').value,
    }),
  });
  const data = await res.json();
  if (!res.ok) return showStatus('✗ ' + (data.error || 'Erreur'));
  reviewBar.classList.add('hidden');
  showStatus(`✓ Ajouté à la bibliothèque : ${data.filename} — disponible dans l'éditeur de maps`);
  refreshJobList();
});

document.getElementById('reject-btn').addEventListener('click', async () => {
  if (!currentJobId) return;
  const comment = prompt(
    'Pourquoi rejetez-vous cet asset ?\n(Avec Claude configuré, votre commentaire relance automatiquement une correction. Laissez vide pour rejeter définitivement.)'
  );
  if (comment === null) return;
  const res = await fetch(`/api/jobs/${currentJobId}/reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ comment: comment.trim() }),
  });
  const data = await res.json();
  if (!res.ok) return showStatus('✗ ' + (data.error || 'Erreur'));
  reviewBar.classList.add('hidden');
  viewer.clear();
  if (data.relaunched) {
    showStatus('Correction relancée…');
    pollJob(data.relaunched);
  } else {
    showStatus('Asset rejeté.');
  }
  refreshJobList();
});

// --- Historique ---
const STATUS_FR = {
  queued: 'en attente', running: 'en cours', review: 'à valider',
  approved: 'validé ✓', rejected: 'rejeté', failed: 'échec ✗', cancelled: 'annulé',
};

async function refreshJobList() {
  const res = await fetch('/api/jobs');
  if (!res.ok) return;
  const jobs = await res.json();
  jobListEl.innerHTML = jobs.length
    ? jobs.map((j) => {
        const action = ['queued', 'running'].includes(j.status)
          ? `<button class="job-act cancel" data-id="${j.id}" title="Annuler cette génération">⏹</button>`
          : `<button class="job-act del" data-id="${j.id}" title="Supprimer de l'historique">🗑</button>`;
        const tokens = (j.tokens_in || 0) + (j.tokens_out || 0);
        const usage = tokens > 0
          ? ` — ${tokens.toLocaleString('fr-FR')} tokens · ${(j.cost_eur || 0).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`
          : '';
        const badge = !j.demo && j.model && MODEL_LABELS[j.model]
          ? `<span class="job-model-badge">${escapeHtml(MODEL_LABELS[j.model])}</span>`
          : '';
        return `
        <div class="job-item ${j.id === currentJobId ? 'active' : ''}" data-id="${j.id}">
          <div class="job-info">
            <span class="prompt">${j.demo ? '🧪 ' : ''}${escapeHtml(j.prompt.slice(0, 80))}</span>
            <span class="meta">${badge}${STATUS_FR[j.status] || j.status} — ${new Date(j.created_at).toLocaleString('fr-FR')}${usage}</span>
          </div>
          ${action}</div>`;
      }).join('')
    : '<div class="empty-msg">Aucune génération pour l\'instant.</div>';

  jobListEl.querySelectorAll('.job-item').forEach((el) =>
    el.addEventListener('click', () => pollJob(el.dataset.id))
  );

  jobListEl.querySelectorAll('.job-act.cancel').forEach((btn) =>
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const res = await fetch(`/api/jobs/${btn.dataset.id}/cancel`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) return showStatus('✗ ' + (data.error || 'Erreur'));
      showStatus("⏹ Annulation demandée (effective à la fin de l'étape en cours)");
      refreshJobList();
    })
  );

  jobListEl.querySelectorAll('.job-act.del').forEach((btn) =>
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('Supprimer cette génération de l\'historique ?')) return;
      const res = await fetch(`/api/jobs/${btn.dataset.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) return showStatus('✗ ' + (data.error || 'Erreur'));
      if (btn.dataset.id === currentJobId) {
        clearInterval(pollTimer);
        currentJobId = null;
        pipelineSection.classList.add('hidden');
        reviewBar.classList.add('hidden');
        viewer.clear();
      }
      showStatus('🗑 Génération supprimée');
      refreshJobList();
    })
  );
}
refreshJobList();

// --- Affiche murale : image -> PNG (canvas) -> poster 3D encadré ---
const posterFileInput = document.getElementById('poster-file');
const posterForm = document.getElementById('poster-form');
const posterPreview = document.getElementById('poster-preview');
const posterNameInput = document.getElementById('poster-name');
const posterHeightInput = document.getElementById('poster-height');
const posterBtn = document.getElementById('poster-btn');
let posterCanvas = null;

document.getElementById('poster-pick-btn').addEventListener('click', () => posterFileInput.click());

// Charge n'importe quel format d'image affichable par le navigateur
// (JPG, PNG, WebP, GIF, BMP, SVG, AVIF...) et le normalise en PNG via canvas.
function loadImageFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('format d\'image non supporté'));
    };
    img.src = url;
  });
}

posterFileInput.addEventListener('change', async () => {
  const file = posterFileInput.files[0];
  posterFileInput.value = '';
  if (!file) return;
  try {
    const { img, url } = await loadImageFile(file);
    const w = img.naturalWidth || 1024;
    const h = img.naturalHeight || 1024;
    const scale = Math.min(1, 2048 / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff'; // fond pour les images transparentes
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(url);

    posterCanvas = canvas;
    posterPreview.src = canvas.toDataURL('image/png');
    posterNameInput.value = file.name.replace(/\.[^.]+$/, '').slice(0, 60);
    posterForm.classList.remove('hidden');
    const orientation = canvas.width >= canvas.height ? 'paysage' : 'portrait';
    showStatus(`Image chargée (${orientation}, ${canvas.width}×${canvas.height}px)`);
  } catch (err) {
    showStatus('✗ ' + err.message, false);
  }
});

posterForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!posterCanvas) return;
  posterBtn.disabled = true;
  showStatus('Création de l\'affiche 3D…', false);
  try {
    const blob = await new Promise((resolve) => posterCanvas.toBlob(resolve, 'image/png'));
    const name = encodeURIComponent(posterNameInput.value.trim() || 'affiche');
    const height = encodeURIComponent(posterHeightInput.value || '80');
    const res = await fetch(`/api/posters?name=${name}&height_cm=${height}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: blob,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur');
    posterForm.classList.add('hidden');
    posterCanvas = null;
    showStatus(`✓ Affiche créée : ${data.filename} — type mur, disponible dans l'éditeur`);
    try {
      await viewer.loadGlb(`/library/${encodeURIComponent(data.filename)}`);
    } catch { /* l'aperçu est optionnel */ }
  } catch (err) {
    showStatus('✗ ' + err.message, false);
  } finally {
    posterBtn.disabled = false;
  }
});

// --- Effacement de l'historique ---
document.getElementById('clear-history-btn').addEventListener('click', async () => {
  const ok = confirm(
    "Effacer tout l'historique de vos générations ?\n\n" +
      'Les assets déjà validés restent dans la bibliothèque. ' +
      "Une génération en cours n'est pas supprimée."
  );
  if (!ok) return;
  const res = await fetch('/api/jobs', { method: 'DELETE' });
  const data = await res.json();
  if (!res.ok) return showStatus('✗ ' + (data.error || 'Erreur'));
  clearInterval(pollTimer);
  currentJobId = null;
  pipelineSection.classList.add('hidden');
  reviewBar.classList.add('hidden');
  viewer.clear();
  showStatus(`🗑 Historique effacé (${data.deleted} génération${data.deleted > 1 ? 's' : ''})`);
  refreshJobList();
});

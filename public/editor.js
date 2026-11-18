// Outil 2 — Éditeur de maps : map SketchUp→GLB + drag & drop des assets de la
// bibliothèque, sauvegarde du layout, export GLB unique (Unity / Unreal).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
// Raycasting accéléré (BVH) : la pose sur les surfaces lance une dizaine de
// rayons par mouvement de souris, sur des maps de plusieurs centaines de
// milliers de triangles.
import {
  computeBoundsTree, disposeBoundsTree, acceleratedRaycast,
} from 'https://unpkg.com/three-mesh-bvh@0.9.16/build/index.module.js';
import { initTopbar } from '/topbar.js';
import { Placer, placedOwner, isDescendantOf, wallSpin } from '/placement.js';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

initTopbar('/editor');

const viewer = document.getElementById('viewer');
const sceneListEl = document.getElementById('scene-list');
const assetListEl = document.getElementById('asset-list');
const statusEl = document.getElementById('status');
const toolbarEl = document.getElementById('toolbar');

let cell = 0.25; // précision du magnétisme (0 = libre)

// --- Scène three.js ---
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a0033);

const camera = new THREE.PerspectiveCamera(50, viewer.clientWidth / viewer.clientHeight, 0.05, 2000);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(viewer.clientWidth, viewer.clientHeight);
viewer.prepend(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI / 2 - 0.02;

scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const keyLight = new THREE.DirectionalLight(0xffffff, 1.4);
keyLight.position.set(8, 14, 8);
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0xbeacdf, 0.5);
fillLight.position.set(-8, 5, -8);
scene.add(fillLight);

const sceneGroup = new THREE.Group();  // décor (la map, non éditable)
const placedGroup = new THREE.Group(); // objets déposés
scene.add(sceneGroup, placedGroup);

let grids = [];
let floorY = 0;
let gridSize = 24;
let currentScene = null;

const dracoLoader = new DRACOLoader().setDecoderPath('https://unpkg.com/three@0.169.0/examples/jsm/libs/draco/gltf/');
const gltfLoader = new GLTFLoader();
gltfLoader.setDRACOLoader(dracoLoader); // maps/assets compressés (KHR_draco_mesh_compression)
const objLoader = new OBJLoader();
const stlLoader = new STLLoader();
const templateCache = new Map();
const localBoxes = new Map();     // filename -> Box3 de l'asset seul, repère local
const assetPlacement = new Map(); // filename -> 'sol' | 'mur'
const assetNames = new Map();     // filename -> nom affiché

// Pose sur les surfaces (sol, meubles de la map, objets placés)
const placer = new Placer({
  mapRoot: sceneGroup,
  placedRoot: placedGroup,
  isBackdrop,
  localBoxOf: (obj) => localBoxes.get(obj.userData.asset) || null,
});
placer.cell = cell;

let statusTimer = null;
function showStatus(msg, autoHide = false) {
  statusEl.textContent = msg;
  statusEl.classList.add('visible');
  clearTimeout(statusTimer);
  if (autoHide) statusTimer = setTimeout(() => statusEl.classList.remove('visible'), 2400);
}

function hideStatus() {
  clearTimeout(statusTimer);
  statusEl.classList.remove('visible');
}

// Index BVH des maillages (géométries partagées entre clones : calculé une fois)
function buildBoundsTrees(root) {
  root.traverse((o) => {
    if (!o.isMesh || o.isSkinnedMesh || o.isInstancedMesh) return;
    const g = o.geometry;
    if (!g?.attributes?.position || g.boundsTree) return;
    try {
      g.computeBoundsTree();
    } catch (err) {
      console.warn('BVH impossible pour', o.name, err); // repli : raycast standard
    }
  });
}

function assetLabel(obj) {
  const file = obj?.userData?.asset || '';
  return assetNames.get(file) || file.replace(/\.(glb|gltf|obj|stl)$/i, '');
}

const ID_RE = /^[\w-]{1,40}$/;
function newId() {
  return 'o' + Math.random().toString(36).slice(2, 10);
}

function disposeObject(root) {
  root.traverse((child) => {
    if (child.geometry) child.geometry.dispose();
    if (child.material) {
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      mats.forEach((m) => {
        for (const key in m) if (m[key] && m[key].isTexture) m[key].dispose();
        m.dispose();
      });
    }
  });
}

// ====================== Chargement des assets ======================

function loadRawModel(url, ext) {
  return new Promise((resolve, reject) => {
    if (ext === 'glb' || ext === 'gltf') {
      gltfLoader.load(url, (gltf) => resolve(gltf.scene), undefined, reject);
    } else if (ext === 'obj') {
      objLoader.load(url, (obj) => {
        obj.traverse((c) => {
          if (c.isMesh && !c.material.map) {
            c.material = new THREE.MeshStandardMaterial({ color: 0xb0b8c4, metalness: 0.1, roughness: 0.7 });
          }
        });
        resolve(obj);
      }, undefined, reject);
    } else if (ext === 'stl') {
      stlLoader.load(url, (geometry) => {
        resolve(new THREE.Mesh(
          geometry,
          new THREE.MeshStandardMaterial({ color: 0xb0b8c4, metalness: 0.1, roughness: 0.7 })
        ));
      }, undefined, reject);
    } else {
      reject(new Error('Format non supporté : ' + ext));
    }
  });
}

// Prépare un asset. Sol : origine au centre-bas (se pose sur le sol).
// Mur : centré en X/Y, dos à Z=0, face vers +Z (se plaque contre un mur).
async function getTemplate(filename) {
  if (templateCache.has(filename)) return templateCache.get(filename);

  const placement = assetPlacement.get(filename) || 'sol';
  const ext = filename.split('.').pop().toLowerCase();
  const model = await loadRawModel(`/library/${encodeURIComponent(filename)}`, ext);

  let box = new THREE.Box3().setFromObject(model);
  let size = box.getSize(new THREE.Vector3());
  // Les assets sont à l'échelle réelle (mètres) : une souris fait ~12 cm et doit
  // rester à cette taille pour se poser sur un bureau. Seuls les modèles géants
  // (unité erronée) sont ramenés à une taille raisonnable.
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  if (maxDim > 8) model.scale.multiplyScalar(4 / maxDim);

  box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  model.position.x -= center.x;
  if (placement === 'mur') {
    model.position.y -= center.y;
    model.position.z -= box.min.z;
  } else {
    model.position.z -= center.z;
    model.position.y -= box.min.y;
  }

  const group = new THREE.Group();
  group.add(model);
  group.userData.asset = filename;
  group.userData.placement = placement;
  group.updateMatrixWorld(true);
  buildBoundsTrees(group);
  // Boîte précise de l'asset seul : sert à mesurer son emprise sur une surface
  localBoxes.set(filename, new THREE.Box3().setFromObject(group, true));
  templateCache.set(filename, group);
  return group;
}

function cloneTemplate(template, id) {
  const clone = template.clone(true);
  clone.userData = {
    asset: template.userData.asset,
    placement: template.userData.placement,
    placed: true,
    id: id || newId(),
  };
  return clone;
}

// ====================== Construction des scènes ======================

function clearScene() {
  deselect();
  hideSupport();
  placer.mapMeshes = [];
  for (const g of [sceneGroup, placedGroup]) {
    while (g.children.length) {
      const child = g.children.pop();
      disposeObject(child);
      g.remove(child);
    }
  }
  removeGrids();
}

function removeGrids() {
  for (const g of grids) {
    scene.remove(g);
    g.geometry.dispose();
    g.material.dispose();
  }
  grids = [];
}

function buildGrid() {
  removeGrids();
  const addGrid = (step, opacity) => {
    const g = new THREE.GridHelper(gridSize, Math.max(1, Math.round(gridSize / step)), 0xebef73, 0xbeacdf);
    g.material.transparent = true;
    g.material.opacity = opacity;
    g.material.depthWrite = false;
    g.position.y = floorY + 0.02;
    scene.add(g);
    grids.push(g);
  };
  if (cell > 0 && cell < 1) addGrid(cell, 0.13);
  addGrid(1, cell === 0 ? 0.15 : 0.3);
}

function fitCamera() {
  const d = gridSize * 0.75;
  camera.position.set(d, d * 0.75, d);
  controls.target.set(0, floorY, 0);
  controls.minDistance = 2;
  controls.maxDistance = gridSize * 4;
  controls.update();
}

// Hauteur du sol : rayons vers le bas, plus basse surface orientée vers le haut
function detectFloorY(model, box) {
  model.updateMatrixWorld(true);
  const ray = new THREE.Raycaster();
  const down = new THREE.Vector3(0, -1, 0);
  let floor = Infinity;
  const steps = 6;
  for (let i = 0; i <= steps; i++) {
    for (let j = 0; j <= steps; j++) {
      const x = THREE.MathUtils.lerp(box.min.x + 0.01, box.max.x - 0.01, i / steps);
      const z = THREE.MathUtils.lerp(box.min.z + 0.01, box.max.z - 0.01, j / steps);
      ray.set(new THREE.Vector3(x, box.max.y + 1, z), down);
      for (const hit of ray.intersectObject(model, true)) {
        if (!hit.face || isBackdrop(hit.object)) continue;
        const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
        if (n.y > 0.5 && hit.point.y < floor) floor = hit.point.y;
      }
    }
  }
  return floor === Infinity ? box.min.y : floor;
}

// Ciel / décor de fond (sphère de ciel vue de l'intérieur, skybox…) : on l'ignore pour
// mesurer la map, sinon une sphère de 100 m+ fausse le cadrage, la grille et le sol.
const BACKDROP_RE = /(^|[^a-z])(sky|ciel|skybox|skydome|skysphere)/i;
function isBackdrop(obj) {
  if (BACKDROP_RE.test(obj.name || '')) return true;
  return [].concat(obj.material || []).some((m) => BACKDROP_RE.test(m?.name || ''));
}

// Boîte englobante de la map sans le décor de fond (repli : boîte complète)
function mapBounds(model) {
  model.updateMatrixWorld(true);
  const box = new THREE.Box3();
  model.traverse((o) => {
    if (o.isMesh && !isBackdrop(o)) box.expandByObject(o, false);
  });
  return box.isEmpty() ? new THREE.Box3().setFromObject(model) : box;
}

// Une map n'est jamais redimensionnée : elle est importée telle quelle, en mètres.
// On la recentre seulement (X/Z au centre, sol à Y = 0).
async function buildModelScene(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  const model = await loadRawModel(`/scenes/${encodeURIComponent(filename)}`, ext);

  const box = mapBounds(model);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  model.position.x -= center.x;
  model.position.z -= center.z;
  model.position.y -= box.min.y;
  sceneGroup.add(model);
  model.updateMatrixWorld(true);
  buildBoundsTrees(model);

  gridSize = Math.max(4, Math.ceil(Math.max(size.x, size.z) / 2) * 2);
  const localBox = mapBounds(model);
  floorY = detectFloorY(model, localBox);

  placer.floorY = floorY;
  placer.gridSize = gridSize;
  placer.refreshMap();
}

async function loadScene(filename) {
  clearScene();
  currentScene = filename;
  showStatus(`Chargement de la map ${filename}…`);
  try {
    await buildModelScene(filename);
    buildGrid();
    fitCamera();
    await loadLayout();
    showStatus(`✓ Map : ${filename}`, true);
  } catch (err) {
    console.error(err);
    showStatus(`✗ Erreur de chargement : ${filename}`, true);
  }
}

// ====================== Magnétisme & placement ======================
//
// Objets « sol » : ils se posent sur la surface visée (sol, meuble de la map,
// objet déjà placé) si elle est assez grande, sinon ils retombent sur la surface
// en dessous. Sur un objet placé, ils en deviennent l'enfant (ils le suivent).
// Magnétisme de grille au sol uniquement ; Alt maintenu = forcer au sol.
// Objets « mur » : murs de la map ou faces verticales d'un objet placé.

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

function pointerFromEvent(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
}

function rayFromEvent(event) {
  pointerFromEvent(event);
  camera.updateMatrixWorld(); // à jour même si aucune image n'a encore été rendue
  raycaster.setFromCamera(pointer, camera);
  return raycaster;
}

// Calcule la pose de `obj` sous le curseur (coordonnées monde) ou null
function computePlacement(event, obj, spin) {
  const ray = rayFromEvent(event);
  if (obj.userData.placement === 'mur') return placer.wallPlacement(ray, obj, spin);
  return placer.floorPlacement(ray, obj, { forceFloor: !!event.altKey });
}

// Applique une pose à un objet dont le parent est neutre (scène ou placedGroup)
function applyPlacement(obj, placement) {
  obj.position.copy(placement.point);
  if (placement.quaternion) obj.quaternion.copy(placement.quaternion);
}

// Rattache un objet à son support (ou à la racine) sans changer sa position monde
function attachTo(obj, parent) {
  (parent || placedGroup).attach(obj);
}

function placementLabel(placement) {
  switch (placement?.kind) {
    case 'objet':
      return placement.normal ? `contre ${assetLabel(placement.parent)}` : `sur ${assetLabel(placement.parent)}`;
    case 'map':
      return `sur une surface de la map (${placement.point.y.toFixed(2).replace('.', ',')} m)`;
    case 'mur':
      return 'sur un mur';
    case 'force':
      return 'au sol (Alt : supports ignorés)';
    default:
      return 'au sol';
  }
}

// --- Surbrillance du support pendant un glisser ---

const supportHelper = new THREE.Box3Helper(new THREE.Box3(), 0xbeacdf);
supportHelper.visible = false;
supportHelper.renderOrder = 10;
supportHelper.material.depthTest = false;
scene.add(supportHelper);

// Contour de l'emprise de l'objet sur sa surface (sol, meuble de la map…)
const footprintLine = new THREE.LineLoop(
  new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(new Array(12).fill(0), 3)),
  new THREE.LineBasicMaterial({ color: 0xebef73, depthTest: false, transparent: true })
);
footprintLine.visible = false;
footprintLine.renderOrder = 11;
footprintLine.frustumCulled = false;
scene.add(footprintLine);

function showSupport(obj, placement) {
  // Objet support : cadre lavande autour de lui seul
  if (placement.parent) {
    ownBox(placement.parent, supportHelper.box);
    supportHelper.visible = true;
  } else {
    supportHelper.visible = false;
  }

  // Emprise au contact (objets sol)
  const box = localBoxes.get(obj.userData.asset);
  if (obj.userData.placement !== 'mur' && box) {
    obj.updateMatrixWorld(true);
    const pos = footprintLine.geometry.attributes.position;
    const corners = [
      [box.min.x, box.min.z], [box.max.x, box.min.z], [box.max.x, box.max.z], [box.min.x, box.max.z],
    ];
    const v = new THREE.Vector3();
    corners.forEach(([x, z], i) => {
      v.set(x, box.min.y, z).applyMatrix4(obj.matrixWorld);
      pos.setXYZ(i, v.x, placement.point.y + 0.006, v.z);
    });
    pos.needsUpdate = true;
    footprintLine.geometry.computeBoundingSphere();
    footprintLine.material.color.setHex(placement.kind === 'sol' || placement.kind === 'force' ? 0xbeacdf : 0xebef73);
    footprintLine.material.opacity = placement.kind === 'sol' || placement.kind === 'force' ? 0.6 : 1;
    footprintLine.visible = true;
  } else {
    footprintLine.visible = false;
  }

  const hint = placement.kind === 'objet' || placement.kind === 'map' ? ' · Alt : forcer au sol' : '';
  showStatus(`${assetLabel(obj)} → ${placementLabel(placement)}${hint}`);
}

function hideSupport() {
  supportHelper.visible = false;
  footprintLine.visible = false;
}

document.getElementById('grid-size').addEventListener('change', (event) => {
  cell = parseFloat(event.target.value);
  placer.cell = cell;
  if (currentScene) buildGrid();
  showStatus(cell > 0 ? `Grille : ${cell} m (au sol)` : 'Placement libre (sans magnétisme)', true);
});

// ====================== Drag & drop ======================

let ghost = null;
const ghostMat = new THREE.MeshBasicMaterial({
  color: 0xebef73, transparent: true, opacity: 0.45, depthWrite: false,
});

async function makeGhost(assetName) {
  removeGhost();
  const template = await getTemplate(assetName);
  if (draggedAsset !== assetName) return; // glisser déjà terminé
  ghost = template.clone(true);
  ghost.traverse((c) => { if (c.isMesh) c.material = ghostMat; });
  ghost.visible = false;
  scene.add(ghost);
}

function removeGhost() {
  hideSupport();
  if (!ghost) return;
  scene.remove(ghost);
  ghost = null;
}

let draggedAsset = null;

viewer.addEventListener('dragover', (event) => {
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
  viewer.classList.add('drag-over');
  if (!ghost || !currentScene) return;
  const placement = computePlacement(event, ghost, null);
  if (placement) {
    applyPlacement(ghost, placement);
    ghost.visible = true;
    showSupport(ghost, placement);
  } else {
    ghost.visible = false;
    hideSupport();
    if (ghost.userData.placement === 'mur') showStatus('🧱 Visez un mur de la map ou la face d\'un objet placé');
  }
});

viewer.addEventListener('dragleave', (event) => {
  if (viewer.contains(event.relatedTarget)) return; // passage sur un enfant (statut…)
  viewer.classList.remove('drag-over');
  if (ghost) ghost.visible = false;
  hideSupport();
});

viewer.addEventListener('drop', async (event) => {
  event.preventDefault();
  viewer.classList.remove('drag-over');
  const assetName = event.dataTransfer.getData('text/asset') || draggedAsset;
  removeGhost();
  if (!assetName || !currentScene) return;

  try {
    const template = await getTemplate(assetName);
    const obj = cloneTemplate(template);
    const placement = computePlacement(event, obj, null);
    if (!placement) {
      hideStatus();
      if (obj.userData.placement === 'mur') showStatus('🧱 Déposez cet asset sur un mur ou sur la face d\'un objet placé', true);
      return;
    }
    applyPlacement(obj, placement);
    attachTo(obj, placement.parent);
    select(obj);
    showStatus(`✓ ${assetLabel(obj)} placé ${placementLabel(placement)} (R : rotation, +/− : échelle)`, true);
  } catch (err) {
    console.error(err);
    showStatus(`✗ Impossible de charger ${assetName}`, true);
  }
});

// ============ Sélection, déplacement, rotation, échelle ============

let selected = null;
let selectionHelpers = []; // [{ helper, target }]

// Boîte monde de l'objet seul (sans les objets posés dessus)
const _meshBox = new THREE.Box3();
function ownBox(obj, target = new THREE.Box3()) {
  target.makeEmpty();
  obj.updateWorldMatrix(true, true);
  (function visit(node) {
    if (node !== obj && node.userData.placed) return;
    if (node.isMesh && node.geometry) {
      if (!node.geometry.boundingBox) node.geometry.computeBoundingBox();
      _meshBox.copy(node.geometry.boundingBox).applyMatrix4(node.matrixWorld);
      target.union(_meshBox);
    }
    for (const child of node.children) visit(child);
  })(obj);
  return target;
}

function placedDescendants(obj) {
  const list = [];
  obj.traverse((o) => { if (o !== obj && o.userData.placed) list.push(o); });
  return list;
}

function addSelectionHelper(target, color, opacity) {
  const helper = new THREE.Box3Helper(new THREE.Box3(), color);
  helper.material.transparent = opacity < 1;
  helper.material.opacity = opacity;
  scene.add(helper);
  selectionHelpers.push({ helper, target });
}

function select(obj) {
  deselect();
  selected = obj;
  addSelectionHelper(obj, 0xebef73, 1);
  // Objets posés dessus (ils suivent) : cadre plus discret
  for (const child of placedDescendants(obj)) addSelectionHelper(child, 0xbeacdf, 0.55);
  refreshSelectionBox();
  toolbarEl.classList.add('visible');
}

function deselect() {
  for (const { helper } of selectionHelpers) {
    scene.remove(helper);
    helper.geometry.dispose();
    helper.material.dispose();
  }
  selectionHelpers = [];
  selected = null;
  toolbarEl.classList.remove('visible');
}

function refreshSelectionBox() {
  for (const { helper, target } of selectionHelpers) ownBox(target, helper.box);
}

// Rotation autour de l'axe vertical du monde, même si l'objet est posé sur un
// support lui-même tourné
const WORLD_UP = new THREE.Vector3(0, 1, 0);
function rotateAroundWorldUp(obj, angle) {
  const parentQ = obj.parent.getWorldQuaternion(new THREE.Quaternion());
  const axis = WORLD_UP.clone().applyQuaternion(parentQ.invert());
  obj.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(axis, angle)).normalize();
}

function rotateSelected() {
  if (!selected) return;
  if (selected.userData.placement === 'mur') {
    // Rotation dans le plan du mur (ex. affiche portrait <-> paysage)
    selected.rotateZ(Math.PI / 2);
  } else {
    rotateAroundWorldUp(selected, Math.PI / 2);
  }
  refreshSelectionBox();
}

function scaleSelected(factor) {
  if (!selected) return;
  const current = selected.getWorldScale(new THREE.Vector3()).x;
  const next = THREE.MathUtils.clamp(current * factor, 0.05, 50);
  const f = next / current;
  selected.scale.multiplyScalar(f);
  // Les objets posés dessus gardent leur taille et restent sur la surface
  // (leur position locale, donc relative au support, est conservée)
  for (const child of selected.children) {
    if (child.userData.placed) child.scale.multiplyScalar(1 / f);
  }
  refreshSelectionBox();
  showStatus(`Échelle : ×${next.toFixed(2)}`, true);
}

function deleteSelected() {
  if (!selected) return;
  const obj = selected;
  const carried = placedDescendants(obj).length;
  deselect();
  obj.parent.remove(obj);
  showStatus(
    carried > 0
      ? `Objet supprimé (+ ${carried} objet${carried > 1 ? 's' : ''} posé${carried > 1 ? 's' : ''} dessus)`
      : 'Objet supprimé',
    true
  );
}

// --- Déplacement d'un objet placé à la souris ---
// Au premier mouvement, l'objet est détaché (position monde conservée) pour
// être reposé librement ; au relâchement, il est rattaché à son nouveau support.
// Ce qu'il porte reste son enfant et le suit.

const DRAG_THRESHOLD = 4; // px avant de considérer qu'on déplace
let drag = null; // { obj, x, y, active, originalParent, spin, last, lastEvent }

renderer.domElement.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  const hits = rayFromEvent(event).intersectObjects(placedGroup.children, true);
  const owner = hits.length > 0 ? placedOwner(hits[0].object) : null;
  if (owner) {
    select(owner);
    drag = { obj: owner, x: event.clientX, y: event.clientY, active: false };
    controls.enabled = false;
    return;
  }
  deselect();
});

function updateDrag(event) {
  const placement = computePlacement(event, drag.obj, drag.spin);
  if (!placement) return;
  applyPlacement(drag.obj, placement);
  drag.last = placement;
  showSupport(drag.obj, placement);
  refreshSelectionBox();
}

renderer.domElement.addEventListener('pointermove', (event) => {
  if (!drag) return;
  if (!drag.active) {
    if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < DRAG_THRESHOLD) return;
    drag.active = true;
    drag.originalParent = drag.obj.parent;
    drag.spin = wallSpin(drag.obj);
    placedGroup.attach(drag.obj);
  }
  drag.lastEvent = { clientX: event.clientX, clientY: event.clientY, altKey: event.altKey };
  updateDrag(drag.lastEvent);
});

function endDrag() {
  if (drag?.active) {
    const { obj, last, originalParent } = drag;
    if (last) {
      attachTo(obj, last.parent);
      showStatus(`✓ ${assetLabel(obj)} ${placementLabel(last)}`, true);
    } else {
      attachTo(obj, originalParent === placedGroup ? null : originalParent);
      hideStatus();
    }
    hideSupport();
    refreshSelectionBox();
  }
  drag = null;
  controls.enabled = true;
}

window.addEventListener('pointerup', endDrag);
window.addEventListener('pointercancel', endDrag);

// Alt pressé / relâché sans bouger la souris : on recalcule la pose
function onAltChange(event) {
  if (event.key !== 'Alt' || !drag?.active || !drag.lastEvent) return;
  event.preventDefault(); // évite le focus du menu du navigateur
  drag.lastEvent = { ...drag.lastEvent, altKey: event.type === 'keydown' };
  updateDrag(drag.lastEvent);
}
window.addEventListener('keyup', onAltChange);

window.addEventListener('keydown', (event) => {
  onAltChange(event);
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) return;
  if (drag?.active) return; // pas de modification pendant un déplacement
  if (event.key === 'r' || event.key === 'R') rotateSelected();
  else if (event.key === '+' || event.key === '=') scaleSelected(1.1);
  else if (event.key === '-') scaleSelected(1 / 1.1);
  else if (event.key === 'Delete' || event.key === 'Backspace') deleteSelected();
  else if (event.key === 'Escape') deselect();
});

document.getElementById('rotate-btn').addEventListener('click', rotateSelected);
document.getElementById('scale-up-btn').addEventListener('click', () => scaleSelected(1.1));
document.getElementById('scale-down-btn').addEventListener('click', () => scaleSelected(1 / 1.1));
document.getElementById('delete-btn').addEventListener('click', deleteSelected);

// ====================== Layout : sauvegarde / chargement ======================
//
// Chaque objet est enregistré avec sa transformation MONDE (compatible avec les
// anciens layouts) et, s'il est posé sur un autre objet, l'id de ce support.

async function loadLayout() {
  if (!currentScene) return;
  const res = await fetch(`/api/layout?scene=${encodeURIComponent(currentScene)}`);
  if (!res.ok) return;
  const layout = await res.json();
  const byId = new Map();
  const links = [];
  for (const item of layout) {
    try {
      const template = await getTemplate(item.asset);
      const id = typeof item.id === 'string' && ID_RE.test(item.id) && !byId.has(item.id) ? item.id : newId();
      const obj = cloneTemplate(template, id);
      if (typeof item.qw === 'number') {
        // Nouveau format : transformation complète (objets sol et mur)
        obj.position.set(item.x, item.y, item.z);
        obj.quaternion.set(item.qx || 0, item.qy || 0, item.qz || 0, item.qw);
      } else {
        // Ancien format : objets au sol uniquement
        obj.position.set(item.x, floorY, item.z);
        obj.rotation.y = item.rotY || 0;
      }
      obj.scale.setScalar(item.scale || 1);
      placedGroup.add(obj);
      byId.set(id, obj);
      if (item.parent) links.push([obj, item.parent]);
    } catch (err) {
      console.error('Asset du layout introuvable :', item.asset, err);
    }
  }
  // Liens support -> objet posé (support absent : l'objet reste indépendant)
  for (const [obj, parentId] of links) {
    const parent = byId.get(parentId);
    if (parent && parent !== obj && !isDescendantOf(parent, obj)) parent.attach(obj);
  }
}

function serializeLayout() {
  const layout = [];
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  placedGroup.updateMatrixWorld(true);
  (function walk(node, parentId) {
    for (const child of node.children) {
      if (!child.userData.placed) {
        walk(child, parentId);
        continue;
      }
      child.matrixWorld.decompose(p, q, s);
      layout.push({
        id: child.userData.id,
        parent: parentId,
        asset: child.userData.asset,
        x: p.x,
        y: p.y,
        z: p.z,
        qx: q.x,
        qy: q.y,
        qz: q.z,
        qw: q.w,
        scale: s.x,
      });
      walk(child, child.userData.id);
    }
  })(placedGroup, null);
  return layout;
}

document.getElementById('save-btn').addEventListener('click', async () => {
  if (!currentScene) return;
  const layout = serializeLayout();
  try {
    const res = await fetch(`/api/layout?scene=${encodeURIComponent(currentScene)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(layout),
    });
    if (!res.ok) throw new Error(await res.text());
    showStatus(`💾 Map sauvegardée (${layout.length} objet${layout.length > 1 ? 's' : ''})`, true);
  } catch (err) {
    console.error(err);
    showStatus('✗ Erreur de sauvegarde', true);
  }
});

// ====================== Export GLB (Unity / Unreal) ======================

const exporter = new GLTFExporter();

function sanitizeName(s) {
  return s.replace(/\.(glb|gltf|obj|stl)$/i, '').replace(/[^\w-]/g, '_');
}

document.getElementById('export-btn').addEventListener('click', () => {
  if (!currentScene) return;
  const base = sanitizeName(currentScene);
  const root = new THREE.Group();
  root.name = base;

  const decor = sceneGroup.children[0];
  if (decor) {
    const d = decor.clone(true);
    d.name = 'map_' + base;
    root.add(d);
  }

  // Chaque objet placé devient un nœud nommé : banc_1, arbre_2… Un objet posé
  // sur un autre en est l'enfant (bureau_1 > souris_1) : dans Unity / Unreal,
  // déplacer le bureau déplace la souris. Objets posés sur la map : racine.
  const counters = {};
  let count = 0;
  for (const obj of placedGroup.children) {
    const clone = obj.clone(true);
    clone.traverse((node) => {
      if (!node.userData.placed) return;
      const assetBase = sanitizeName(node.userData.asset || 'objet');
      counters[assetBase] = (counters[assetBase] || 0) + 1;
      node.name = `${assetBase}_${counters[assetBase]}`;
      count++;
    });
    root.add(clone);
  }

  showStatus('Export en cours…');
  exporter.parse(
    root,
    (buffer) => {
      const blob = new Blob([buffer], { type: 'model/gltf-binary' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${base}-map.glb`;
      a.click();
      URL.revokeObjectURL(a.href);
      const n = count;
      showStatus(`⬇ ${base}-map.glb exporté (${n} objet${n > 1 ? 's' : ''}) — importable dans Unity / Unreal`, true);
    },
    (err) => {
      console.error(err);
      showStatus("✗ Erreur d'export", true);
    },
    { binary: true }
  );
});

// ====================== Listes : maps & bibliothèque ======================

async function loadSceneList() {
  const res = await fetch('/api/scenes');
  const scenes = await res.json();

  sceneListEl.innerHTML = '';
  if (scenes.length === 0) {
    sceneListEl.innerHTML =
      '<div class="empty-msg">Aucune map. Importez un export SketchUp converti en <code>.glb</code>.</div>';
    return;
  }

  scenes.forEach((name, i) => {
    const btn = document.createElement('button');
    btn.className = 'scene-item';
    btn.textContent = '🗺 ' + name.replace(/\.(glb|gltf|obj|stl)$/i, '');
    btn.title = name;
    btn.addEventListener('click', () => {
      document.querySelectorAll('.scene-item').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      loadScene(name);
    });
    sceneListEl.appendChild(btn);
    if (i === 0) btn.click();
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function buildCard(asset) {
  const placement = asset.placement === 'mur' ? 'mur' : 'sol';
  const card = document.createElement('div');
  card.className = 'asset-card';
  card.draggable = true;
  card.title = asset.prompt || asset.display_name;
  const thumb = asset.has_thumb
    ? `<img src="/thumbs/${encodeURIComponent(asset.filename)}" alt="" loading="lazy" draggable="false" />`
    : '<div class="thumb-placeholder">📦<small>photo en préparation…</small></div>';
  card.innerHTML =
    `<div class="thumb">${thumb}` +
    `<button class="card-btn card-type" title="Basculer sol/mur">${placement === 'mur' ? '🧱' : '🟫'}</button>` +
    `<button class="card-btn card-del" title="Supprimer de la bibliothèque">✕</button>` +
    `</div>` +
    `<div class="card-name">${escapeHtml(asset.display_name)}</div>`;

  // Bascule sol <-> mur
  card.querySelector('.card-type').addEventListener('click', async (event) => {
    event.stopPropagation();
    const next = assetPlacement.get(asset.filename) === 'mur' ? 'sol' : 'mur';
    const r = await fetch(`/api/assets/${asset.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ placement: next }),
    });
    if (!r.ok) return showStatus('✗ Impossible de changer le type', true);
    templateCache.delete(asset.filename); // l'origine de l'objet dépend du type
    showStatus(`${asset.display_name} → ${next === 'mur' ? '🧱 mur' : '🟫 sol'}`, true);
    loadAssetList();
  });

  // Suppression de la bibliothèque
  card.querySelector('.card-del').addEventListener('click', async (event) => {
    event.stopPropagation();
    if (!confirm(`Supprimer « ${asset.display_name} » de la bibliothèque ?\nLe fichier 3D sera définitivement effacé.`)) return;
    const r = await fetch(`/api/assets/${asset.id}`, { method: 'DELETE' });
    if (!r.ok) return showStatus('✗ Suppression impossible', true);
    templateCache.delete(asset.filename);
    showStatus(`🗑 ${asset.display_name} supprimé`, true);
    loadAssetList();
  });

  card.addEventListener('dragstart', (event) => {
    draggedAsset = asset.filename;
    event.dataTransfer.setData('text/asset', asset.filename);
    event.dataTransfer.effectAllowed = 'all'; // Alt (forcer au sol) ne doit pas bloquer le dépôt
    makeGhost(asset.filename);
  });
  card.addEventListener('dragend', () => {
    draggedAsset = null;
    removeGhost();
  });
  return card;
}

async function loadAssetList() {
  const res = await fetch('/api/assets');
  const assets = await res.json();

  assetPlacement.clear();
  assets.forEach((a) => {
    assetPlacement.set(a.filename, a.placement === 'mur' ? 'mur' : 'sol');
    assetNames.set(a.filename, a.display_name || a.filename);
  });

  assetListEl.innerHTML = '';
  if (assets.length === 0) {
    assetListEl.innerHTML =
      '<div class="empty-msg">Bibliothèque vide. Générez des assets avec l\'outil 1, créez une affiche, ou importez vos fichiers 3D.</div>';
    return;
  }

  const categories = [
    { title: '🟫 Objets sol', items: assets.filter((a) => a.placement !== 'mur') },
    { title: '🧱 Objets mur', items: assets.filter((a) => a.placement === 'mur' && a.source !== 'affiche') },
    { title: '🖼 Affiches', items: assets.filter((a) => a.placement === 'mur' && a.source === 'affiche') },
  ];

  for (const cat of categories) {
    if (cat.items.length === 0) continue;
    const details = document.createElement('details');
    details.className = 'cat';
    details.open = true;
    details.innerHTML = `<summary>${cat.title} <span class="count">${cat.items.length}</span></summary>`;
    const grid = document.createElement('div');
    grid.className = 'card-grid';
    cat.items.forEach((asset) => grid.appendChild(buildCard(asset)));
    details.appendChild(grid);
    assetListEl.appendChild(details);
  }

  // Des photos encore en préparation ? On rafraîchit quand elles sont prêtes.
  if (assets.some((a) => !a.has_thumb)) {
    clearTimeout(loadAssetList._retry);
    loadAssetList._retry = setTimeout(loadAssetList, 8000);
  }
}

// ====================== Import d'un asset 3D ======================

const assetFileInput = document.getElementById('asset-file');
const importForm = document.getElementById('import-form');
const importName = document.getElementById('import-name');
let importFile = null;

document.getElementById('import-asset-btn').addEventListener('click', () => assetFileInput.click());

assetFileInput.addEventListener('change', () => {
  const file = assetFileInput.files[0];
  assetFileInput.value = '';
  if (!file) return;
  if (!/\.(glb|gltf|obj|stl)$/i.test(file.name)) {
    return showStatus('✗ Formats acceptés : .glb, .gltf, .obj, .stl', true);
  }
  if (file.size > 100 * 1024 * 1024) return showStatus('✗ Fichier trop volumineux (max 100 Mo)', true);
  importFile = file;
  importName.value = file.name.replace(/\.[^.]+$/, '').slice(0, 60);
  importForm.classList.remove('hidden');
});

importForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!importFile) return;
  const ext = importFile.name.match(/\.(glb|gltf|obj|stl)$/i)[0].toLowerCase();
  const safeName =
    (importName.value.trim() || 'asset')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^\w .-]+/g, '-').replace(/^[^\w]+/, 'a').slice(0, 60) + ext;
  const placement = document.getElementById('import-placement').value;
  showStatus(`Import de ${importFile.name}…`);
  try {
    const res = await fetch(
      `/api/assets/upload?name=${encodeURIComponent(safeName)}&placement=${placement}&display=${encodeURIComponent(importName.value.trim())}`,
      { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: importFile }
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur');
    importForm.classList.add('hidden');
    importFile = null;
    showStatus(`✓ ${data.filename} ajouté (${data.placement === 'mur' ? '🧱 mur' : '🟫 sol'})`, true);
    await loadAssetList();
  } catch (err) {
    showStatus('✗ ' + err.message, true);
  }
});

// ====================== Import d'une map ======================

const mapFileInput = document.getElementById('map-file');
document.getElementById('upload-map-btn').addEventListener('click', () => mapFileInput.click());
mapFileInput.addEventListener('change', async () => {
  const file = mapFileInput.files[0];
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.glb')) return showStatus('✗ Format attendu : .glb', true);
  if (file.size > 150 * 1024 * 1024) return showStatus('✗ Fichier trop volumineux (max 150 Mo)', true);
  showStatus(`Import de ${file.name}…`);
  try {
    const res = await fetch(`/api/scenes/upload?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur');
    showStatus(`✓ Map importée : ${data.name}`, true);
    await loadSceneList();
  } catch (err) {
    showStatus('✗ ' + err.message, true);
  } finally {
    mapFileInput.value = '';
  }
});

// ====================== Boucle de rendu ======================

window.addEventListener('resize', () => {
  camera.aspect = viewer.clientWidth / viewer.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(viewer.clientWidth, viewer.clientHeight);
});

(function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
})();

loadSceneList();
loadAssetList();

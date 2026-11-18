// Pose d'objets sur des surfaces : sol principal, meubles de la map (table,
// étagère, estrade…) et objets déjà placés (souris sur un bureau, livre sur un
// carton…). Module sans DOM : il ne fait que des calculs three.js.
//
// Principe (objets « sol ») :
//  1. On vise une surface : premier point touché sous le curseur, s'il est
//     orienté vers le haut. Les maps étant fusionnées par matériau (une table
//     de la map n'est pas un objet séparé), on raisonne en SURFACES.
//  2. On vérifie que l'objet y tient : son emprise est sondée par des rayons
//     verticaux. Le centre doit porter, ainsi que la majorité de l'emprise
//     (un léger débordement est permis), et la hauteur libre au-dessus doit
//     suffire (étagère trop basse).
//  3. Sinon l'objet retombe sur la surface valide en dessous, et en dernier
//     recours sur le sol principal (toujours valide, avec la grille).
//  Face verticale visée (paroi, écran, mur) : l'objet se pose au pied de cette
//  face, côté caméra.
//
// Objets « mur » : murs de la map (comportement historique) ou faces
// verticales d'un objet placé, avec le même contrôle d'emprise.
import * as THREE from 'three';

export const UP_MIN = 0.7;        // normale « vers le haut » : pente < ~45°
export const WALL_MAX_NY = 0.45;  // normale quasi horizontale : mur
export const SURFACE_TOL = 0.04;  // écart de hauteur toléré sur une même surface (m)
export const FLOOR_TOL = 0.05;    // surface assimilée au sol principal (tapis…)
const PROBE_OFFSET = 0.12;        // départ des rayons de sondage devant la surface
const MIN_SUPPORT_RATIO = 0.5;    // part de l'emprise qui doit porter
const MAX_FALLBACKS = 8;          // surfaces essayées en dessous avant le sol
const SAMPLES = [0.1, 0.5, 0.9];  // grille 3×3 sur l'emprise (bords légèrement rentrés)

const FORWARD = new THREE.Vector3(0, 0, 1);
const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
const _normalMatrix = new THREE.Matrix3();

/** Nœud « objet placé » le plus proche en remontant la hiérarchie (ou null). */
export function placedOwner(object) {
  for (let n = object; n; n = n.parent) if (n.userData?.placed) return n;
  return null;
}

export function isDescendantOf(object, root) {
  for (let n = object; n; n = n.parent) if (n === root) return true;
  return false;
}

/**
 * Normale monde de la face touchée, orientée vers l'origine du rayon.
 * Indispensable avec des matériaux double face : three.js renvoie la normale
 * géométrique, quel que soit le côté réellement vu.
 */
export function worldNormal(hit, rayDir) {
  if (!hit.face) return null;
  const n = hit.face.normal.clone()
    .applyMatrix3(_normalMatrix.getNormalMatrix(hit.object.matrixWorld))
    .normalize();
  if (rayDir && n.dot(rayDir) > 0) n.negate();
  return n;
}

/** Orientation d'un objet mural : dos au mur (normale), + rotation dans le plan. */
export function wallQuaternion(normal, spin) {
  const q = new THREE.Quaternion().setFromUnitVectors(FORWARD, normal);
  return spin ? q.multiply(spin) : q;
}

/** Rotation propre d'un objet mural dans le plan du mur (portrait/paysage…). */
export function wallSpin(obj) {
  const qWorld = obj.getWorldQuaternion(new THREE.Quaternion());
  const fwd = FORWARD.clone().applyQuaternion(qWorld);
  fwd.y = 0;
  if (fwd.lengthSq() < 1e-6) return new THREE.Quaternion();
  const base = new THREE.Quaternion().setFromUnitVectors(FORWARD, fwd.normalize());
  return base.invert().multiply(qWorld);
}

export class Placer {
  /**
   * @param {object} opts
   * @param {THREE.Object3D} opts.mapRoot     décor (map importée)
   * @param {THREE.Object3D} opts.placedRoot  racine des objets placés
   * @param {(o: THREE.Object3D) => boolean} opts.isBackdrop  ciel / fond à ignorer
   * @param {(o: THREE.Object3D) => THREE.Box3|null} opts.localBoxOf
   *        boîte de l'objet seul, dans son repère local (sans les objets posés dessus)
   */
  constructor({ mapRoot, placedRoot, isBackdrop, localBoxOf }) {
    this.mapRoot = mapRoot;
    this.placedRoot = placedRoot;
    this.isBackdrop = isBackdrop || (() => false);
    this.localBoxOf = localBoxOf;
    this.floorY = 0;
    this.cell = 0;
    this.gridSize = 24;
    this.mapMeshes = [];
    this.probe = new THREE.Raycaster();
    this.floorPlane = new THREE.Plane(UP.clone(), 0);
  }

  /** À appeler après chaque chargement de map. */
  refreshMap() {
    this.mapRoot.updateMatrixWorld(true);
    this.mapMeshes = [];
    this.mapRoot.traverseVisible((o) => {
      if (o.isMesh && !this.isBackdrop(o)) this.mapMeshes.push(o);
    });
  }

  /** Maillages candidats : map + objets placés, sauf l'objet manipulé et ce qu'il porte. */
  targets(exclude) {
    this.placedRoot.updateMatrixWorld(true); // objets déplacés depuis la dernière image
    const list = this.mapMeshes.slice();
    this.placedRoot.traverseVisible((o) => {
      if (o.isMesh && !(exclude && isDescendantOf(o, exclude))) list.push(o);
    });
    return list;
  }

  cast(raycaster, exclude, list) {
    return raycaster.intersectObjects(list || this.targets(exclude), false);
  }

  /** Objet placé qui porte cette surface (null si c'est la map). */
  supportOf(object) {
    const owner = placedOwner(object);
    return owner && isDescendantOf(owner, this.placedRoot) ? owner : null;
  }

  // ------------------------------------------------------------------
  // Objets « sol »
  // ------------------------------------------------------------------

  /**
   * Où poser `obj` (rotation/échelle monde actuelles conservées) pour un rayon
   * caméra donné. Renvoie { point, parent, support, kind } ou null :
   *  - kind 'sol'   : sol principal (grille), parent null
   *  - kind 'map'   : surface surélevée de la map (table, étagère…), parent null
   *  - kind 'objet' : sur un objet placé, parent = cet objet
   */
  floorPlacement(camRay, obj, { forceFloor = false } = {}) {
    const list = this.targets(obj);
    if (!forceFloor) {
      const first = this.cast(camRay, obj, list)[0];
      if (first) {
        const n = worldNormal(first, camRay.ray.direction);
        if (n && n.y >= UP_MIN) {
          return this.resolveColumn(first.point.x, first.point.z, first.point.y, first, obj, list);
        }
        if (n && Math.abs(n.y) < WALL_MAX_NY) {
          // Face verticale visée (paroi d'un carton ouvert, écran, mur…) : on pose
          // au pied de cette face, côté caméra, décalé de la demi-emprise de l'objet
          const flat = new THREE.Vector3(n.x, 0, n.z).normalize();
          const r = this.footprintRadius(obj, flat) + 0.01;
          const x = first.point.x + flat.x * r;
          const z = first.point.z + flat.z * r;
          return this.resolveColumn(x, z, first.point.y, null, obj, list);
        }
      }
    }
    // Repli historique : intersection avec le plan du sol principal
    this.floorPlane.constant = -this.floorY;
    const p = new THREE.Vector3();
    if (!camRay.ray.intersectPlane(this.floorPlane, p)) return null;
    return this.floorResult(p.x, p.z, obj, list, forceFloor);
  }

  /** Demi-emprise de l'objet dans la direction horizontale `dir` (m). */
  footprintRadius(obj, dir) {
    const box = this.localBoxOf(obj);
    if (!box || box.isEmpty()) return 0;
    const q = obj.getWorldQuaternion(new THREE.Quaternion());
    const s = obj.getWorldScale(new THREE.Vector3());
    const ax = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const az = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    const hx = ((box.max.x - box.min.x) / 2) * s.x;
    const hz = ((box.max.z - box.min.z) / 2) * s.z;
    const cx = ((box.max.x + box.min.x) / 2) * s.x;
    const cz = ((box.max.z + box.min.z) / 2) * s.z;
    // origine pas forcément au centre : on ajoute le décalage du centre
    return Math.abs(ax.dot(dir)) * hx + Math.abs(az.dot(dir)) * hz
      - (ax.dot(dir) * cx + az.dot(dir) * cz);
  }

  /**
   * Essaie la surface visée (firstHit, si fournie) puis celles en dessous du
   * point (x, z), à partir de la hauteur topY.
   */
  resolveColumn(x, z, topY, firstHit, obj, list) {
    const candidates = firstHit ? [firstHit] : [];

    // Surfaces orientées vers le haut sous le point visé, de haut en bas
    this.probe.set(new THREE.Vector3(x, topY - 0.01, z), DOWN);
    this.probe.far = Infinity;
    let lastY = firstHit ? firstHit.point.y : Infinity;
    for (const hit of this.cast(this.probe, obj, list)) {
      if (candidates.length > MAX_FALLBACKS) break;
      if (hit.point.y > lastY - 0.02) continue; // même surface (double face, épaisseur nulle)
      const n = worldNormal(hit, DOWN);
      if (!n || n.y < UP_MIN) continue;
      candidates.push(hit);
      lastY = hit.point.y;
    }

    for (const hit of candidates) {
      const y = hit.point.y;
      const parent = this.supportOf(hit.object);
      // Sol de la map (ou tapis de la map) : sol principal, avec la grille.
      // Un objet placé au sol (fond d'un carton ouvert…) reste un support.
      if (!parent && Math.abs(y - this.floorY) <= FLOOR_TOL) break;
      if (this.fitsOnSurface(x, y, z, obj, list)) {
        return {
          point: new THREE.Vector3(x, y, z),
          parent,
          support: parent || hit.object,
          kind: parent ? 'objet' : 'map',
        };
      }
    }
    return this.floorResult(x, z, obj, list, false);
  }

  /** Sol principal : magnétisme de grille, toujours accepté. */
  floorResult(x, z, obj, list, forced) {
    const half = this.gridSize / 2 - (this.cell || 0) / 2;
    const clamp = (v) => Math.min(half, Math.max(-half, v));
    const snap = this.cell > 0
      ? (v) => clamp(Math.floor(v / this.cell) * this.cell + this.cell / 2)
      : clamp;
    const sx = snap(x);
    const sz = snap(z);

    // Hauteur réelle au niveau du sol (tapis, dalle légèrement surélevée…)
    let y = this.floorY;
    this.probe.set(new THREE.Vector3(sx, this.floorY + FLOOR_TOL + 0.02, sz), DOWN);
    this.probe.far = 2 * FLOOR_TOL + 0.02;
    const hit = this.cast(this.probe, obj, list)[0];
    if (hit && worldNormal(hit, DOWN).y >= UP_MIN) y = hit.point.y;

    return { point: new THREE.Vector3(sx, y, sz), parent: null, support: null, kind: forced ? 'force' : 'sol' };
  }

  /** L'emprise de `obj`, posé en (x, y, z), repose-t-elle sur la surface ? */
  fitsOnSurface(x, y, z, obj, list) {
    const box = this.localBoxOf(obj);
    if (!box || box.isEmpty()) return true;
    const q = obj.getWorldQuaternion(new THREE.Quaternion());
    const s = obj.getWorldScale(new THREE.Vector3());
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), q, s);

    let supported = 0;
    let total = 0;
    const p = new THREE.Vector3();
    for (const u of SAMPLES) {
      for (const v of SAMPLES) {
        p.set(
          THREE.MathUtils.lerp(box.min.x, box.max.x, u),
          box.min.y,
          THREE.MathUtils.lerp(box.min.z, box.max.z, v)
        ).applyMatrix4(m);
        const ok = this.probeSurface(p.x, y, p.z, obj, list);
        if (u === 0.5 && v === 0.5 && !ok) return false; // le centre doit porter
        total++;
        if (ok) supported++;
      }
    }
    if (supported / total < MIN_SUPPORT_RATIO) return false;

    // Hauteur libre au-dessus (étagère trop basse, plateau du dessus…)
    const height = (box.max.y - box.min.y) * s.y;
    this.probe.set(new THREE.Vector3(x, y + 0.02, z), UP);
    this.probe.far = Math.max(0, height * 0.9 - 0.02);
    return this.probe.far === 0 || this.cast(this.probe, obj, list).length === 0;
  }

  /** Une surface d'appui existe-t-elle à la hauteur y (± tolérance) en (x, z) ? */
  probeSurface(x, y, z, obj, list) {
    this.probe.set(new THREE.Vector3(x, y + PROBE_OFFSET, z), DOWN);
    this.probe.far = PROBE_OFFSET + SURFACE_TOL;
    const hit = this.cast(this.probe, obj, list)[0];
    // Un obstacle plus haut que la tolérance (livre, clavier épais…) compte comme vide
    if (!hit || Math.abs(hit.point.y - y) > SURFACE_TOL) return false;
    return worldNormal(hit, DOWN).y >= UP_MIN;
  }

  // ------------------------------------------------------------------
  // Objets « mur »
  // ------------------------------------------------------------------

  /**
   * Renvoie { point, normal, quaternion, parent, support, kind } ou null.
   * Murs de la map : premier mur derrière le curseur (comportement historique).
   * Objets placés : seulement la face vue en premier, si l'objet y tient.
   */
  wallPlacement(camRay, obj, spin) {
    const list = this.targets(obj);
    const hits = this.cast(camRay, obj, list);
    for (let i = 0; i < hits.length; i++) {
      const hit = hits[i];
      const owner = this.supportOf(hit.object);
      if (owner && i !== 0) continue; // face cachée d'un objet : ignorée
      const n = worldNormal(hit, camRay.ray.direction);
      if (!n || Math.abs(n.y) >= WALL_MAX_NY) continue;
      const normal = new THREE.Vector3(n.x, 0, n.z).normalize();
      const quaternion = wallQuaternion(normal, spin);
      if (owner && !this.fitsOnWall(hit.point, normal, quaternion, obj, list)) continue;
      return {
        point: hit.point.clone().addScaledVector(normal, 0.01),
        normal,
        quaternion,
        parent: owner,
        support: owner || hit.object,
        kind: owner ? 'objet' : 'mur',
      };
    }
    return null;
  }

  fitsOnWall(point, normal, quaternion, obj, list) {
    const box = this.localBoxOf(obj);
    if (!box || box.isEmpty()) return true;
    const s = obj.getWorldScale(new THREE.Vector3());
    const m = new THREE.Matrix4().compose(point, quaternion, s);
    const back = normal.clone().negate();
    let supported = 0;
    let total = 0;
    const p = new THREE.Vector3();
    for (const u of SAMPLES) {
      for (const v of SAMPLES) {
        p.set(
          THREE.MathUtils.lerp(box.min.x, box.max.x, u),
          THREE.MathUtils.lerp(box.min.y, box.max.y, v),
          box.min.z
        ).applyMatrix4(m);
        this.probe.set(p.clone().addScaledVector(normal, PROBE_OFFSET), back);
        this.probe.far = PROBE_OFFSET + SURFACE_TOL;
        const hit = this.cast(this.probe, obj, list)[0];
        const ok = !!hit
          && Math.abs(hit.distance - PROBE_OFFSET) <= SURFACE_TOL
          && Math.abs(worldNormal(hit, back).y) < WALL_MAX_NY;
        if (u === 0.5 && v === 0.5 && !ok) return false;
        total++;
        if (ok) supported++;
      }
    }
    return supported / total >= MIN_SUPPORT_RATIO;
  }
}

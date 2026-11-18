// Lecteur three.js réutilisable : affiche un GLB avec orbite + éclairage studio.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

export function createViewer(container) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a0033);

  const camera = new THREE.PerspectiveCamera(
    45, container.clientWidth / container.clientHeight, 0.01, 1000
  );
  camera.position.set(2, 1.5, 2.5);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.prepend(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  scene.add(new THREE.AmbientLight(0xffffff, 0.7));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(4, 6, 4);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xbeacdf, 0.6);
  fill.position.set(-4, 2, -3);
  scene.add(fill);

  const grid = new THREE.GridHelper(10, 20, 0xbeacdf, 0x4b0090);
  grid.material.transparent = true;
  grid.material.opacity = 0.35;
  scene.add(grid);

  const modelGroup = new THREE.Group();
  scene.add(modelGroup);

  const loader = new GLTFLoader();
  loader.setDRACOLoader(new DRACOLoader().setDecoderPath('https://unpkg.com/three@0.169.0/examples/jsm/libs/draco/gltf/'));

  function clear() {
    while (modelGroup.children.length) {
      const child = modelGroup.children.pop();
      child.traverse((c) => {
        c.geometry?.dispose();
        const mats = Array.isArray(c.material) ? c.material : c.material ? [c.material] : [];
        mats.forEach((m) => m.dispose());
      });
      modelGroup.remove(child);
    }
  }

  async function loadGlb(url) {
    clear();
    const gltf = await new Promise((resolve, reject) => loader.load(url, resolve, undefined, reject));
    const model = gltf.scene;
    modelGroup.add(model);

    // Cadrage automatique
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z, 0.1);
    controls.target.copy(center);
    camera.position.set(center.x + radius * 1.4, center.y + radius * 0.9, center.z + radius * 1.6);
    camera.near = radius / 100;
    camera.far = radius * 100;
    camera.updateProjectionMatrix();
    controls.update();
    return model;
  }

  function resize() {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
  }
  window.addEventListener('resize', resize);

  (function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  })();

  return { loadGlb, clear, scene, camera, renderer };
}

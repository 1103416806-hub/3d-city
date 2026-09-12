import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

const COLORS = {
  background: '#e9eeec', ground: '#dedfd6', base: '#f5f5ed', road: '#b9beba',
  sidewalk: '#edede5', water: '#80bcb5', grass: '#a7b9a0', tree: '#79937c',
  trunk: '#8c8170', low: '#dddcd0', tower: '#c7917d', slab: '#d8dfdc',
  edge: '#8f9691', selected: '#ef9658', window: '#f0eee6', marking: '#f2f1e7',
};

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const finite = (n, fallback) => Number.isFinite(Number(n)) ? Number(n) : fallback;
const pointPair = (p) => Array.isArray(p) ? [Number(p[0]), Number(p[1])] : [Number(p?.x), Number(p?.z ?? p?.y)];
const validPoints = (points) => (Array.isArray(points) ? points : []).map(pointPair).filter(([x, z]) => Number.isFinite(x) && Number.isFinite(z));
const isPoint = (p) => Array.isArray(p) && p.length >= 2 && typeof p[0] === 'number';
const featureList = (value) => {
  if (!value) return [];
  if (value.points) return [value];
  if (!Array.isArray(value)) return [];
  if (isPoint(value[0])) return [{ points: value }];
  return value.map((v) => Array.isArray(v) ? { points: v } : v).filter(Boolean);
};

function pointInPolygon(x, z, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function distanceToSegment(x, z, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const t = clamp(((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz || 1), 0, 1);
  return Math.hypot(x - a[0] - t * dx, z - a[1] - t * dz);
}

function segmentIntersection(a, b, c, d) {
  const r = [b[0] - a[0], b[1] - a[1]], s = [d[0] - c[0], d[1] - c[1]];
  const cross = (u, v) => u[0] * v[1] - u[1] * v[0];
  const denominator = cross(r, s);
  if (Math.abs(denominator) < 1e-7) return null;
  const ca = [c[0] - a[0], c[1] - a[1]];
  const t = cross(ca, s) / denominator, u = cross(ca, r) / denominator;
  if (t < -1e-5 || t > 1.00001 || u < -1e-5 || u > 1.00001) return null;
  return [a[0] + r[0] * t, a[1] + r[1] * t];
}

function shapeFor(points, holes = []) {
  const shape = new THREE.Shape();
  points.forEach(([x, z], index) => index ? shape.lineTo(x, -z) : shape.moveTo(x, -z));
  shape.closePath();
  holes.filter((hole) => hole.length >= 3).forEach((hole) => {
    const path = new THREE.Path();
    hole.forEach(([x, z], index) => index ? path.lineTo(x, -z) : path.moveTo(x, -z));
    path.closePath();
    shape.holes.push(path);
  });
  return shape;
}

function seededRandom(seed) {
  let state = (Number(seed) || 1) >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let t = state;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function signedArea(points) {
  return points.reduce((area, point, i) => {
    const next = points[(i + 1) % points.length];
    return area + point[0] * next[1] - next[0] * point[1];
  }, 0) / 2;
}

function disposeTree(root) {
  const geometries = new Set(), materials = new Set();
  root.traverse((item) => {
    if (item.isInstancedMesh) item.dispose();
    if (item.geometry) geometries.add(item.geometry);
    for (const material of Array.isArray(item.material) ? item.material : item.material ? [item.material] : []) materials.add(material);
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => { material.map?.dispose(); material.dispose(); });
  root.clear();
}

/** A metre-based, locally rendered city model. All footprint inputs use [0…1, 0…1]. */
export class CityScene {
  constructor(container, { onSelect, onReady, onError, onMeasure } = {}) {
    this.container = container;
    this.callbacks = { onSelect, onReady, onError, onMeasure };
    this.width = 480;
    this.depth = 330;
    this.mode = 'orbit';
    this.buildingMeshes = [];
    this.buildingPolygons = [];
    this.buildingHoles = [];
    this.waterPolygons = [];
    this.roadPaths = [];
    this.selectedId = null;
    this.measurePoints = [];
    this.keys = new Set();
    this.disposed = false;
    this.dirty = true;
    this.modelLoaded = false;
    this.listeners = [];
    try {
      this.scene = new THREE.Scene();
      this.scene.background = new THREE.Color(COLORS.background);
      this.scene.fog = new THREE.Fog(COLORS.background, 1300, 2700);
      this.camera = new THREE.PerspectiveCamera(40, 1, 3, 5000);
      this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.32;
      this.renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;outline:none;';
      this.renderer.domElement.tabIndex = 0;
      this.renderer.domElement.setAttribute('aria-label', '城市三维模型，拖动旋转，滚轮缩放；漫游时使用方向键或 WASD 移动');
      container.appendChild(this.renderer.domElement);
      this.controls = new OrbitControls(this.camera, this.renderer.domElement);
      this.controls.enableDamping = true;
      this.controls.dampingFactor = 0.075;
      this.controls.minDistance = 15;
      this.controls.maxDistance = 1800;
      this.controls.maxPolarAngle = Math.PI / 2 - 0.025;
      this.controls.screenSpacePanning = true;
      this.controls.addEventListener('change', () => { this.dirty = true; });
      this.city = new THREE.Group();
      this.city.name = '3D城市_单位米';
      this.scene.add(this.city);
      this.measureGroup = new THREE.Group();
      this.measureGroup.name = '测量辅助';
      this.scene.add(this.measureGroup);
      this.skyLight = new THREE.HemisphereLight('#f4fbff', '#afb6a0', 2.6);
      this.scene.add(this.skyLight);
      this.sun = new THREE.DirectionalLight('#fff5df', 3.3);
      this.sun.position.set(-250, 420, 230);
      this.sun.castShadow = true;
      this.sun.shadow.mapSize.set(2048, 2048);
      this.sun.shadow.camera.near = 1;
      this.sun.shadow.camera.far = 1600;
      this.sun.shadow.bias = -0.00025;
      this.sun.shadow.normalBias = 0.7;
      this.sun.shadow.radius = 3;
      this.scene.add(this.sun, this.sun.target);
      this.raycaster = new THREE.Raycaster();
      this.pointer = new THREE.Vector2();
      this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.3);
      this.installEvents();
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(container);
      this.resize();
      this.resetView();
      this.lastFrame = performance.now();
      this.animate = this.animate.bind(this);
      this.raf = requestAnimationFrame(this.animate);
    } catch (error) {
      this.reportError(error);
    }
  }

  reportError(error) {
    this.lastError = error;
    if (this.callbacks.onError) this.callbacks.onError(error);
    else console.error('3D city:', error);
  }

  listen(target, event, fn, options) {
    target.addEventListener(event, fn, options);
    this.listeners.push(() => target.removeEventListener(event, fn, options));
  }

  installEvents() {
    const canvas = this.renderer.domElement;
    this.listen(canvas, 'contextmenu', (event) => event.preventDefault());
    this.listen(canvas, 'webglcontextlost', (event) => {
      event.preventDefault();
      this.contextLost = true;
      this.reportError(new Error('三维显示暂时中断，请刷新页面重试。'));
    });
    this.listen(canvas, 'webglcontextrestored', () => { this.contextLost = false; this.dirty = true; });
    this.listen(canvas, 'pointerdown', (event) => {
      if (event.button !== 0) return;
      canvas.focus({ preventScroll: true });
      this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, moved: false };
      if (this.mode === 'walk') canvas.setPointerCapture(event.pointerId);
    });
    this.listen(canvas, 'pointermove', (event) => {
      if (!this.drag || this.drag.id !== event.pointerId) return;
      if (Math.hypot(event.clientX - this.drag.startX, event.clientY - this.drag.startY) > 5) this.drag.moved = true;
      if (this.mode === 'walk' && !this.measureEnabled) {
        this.yaw -= (event.clientX - this.drag.x) * 0.004;
        this.pitch = clamp(this.pitch - (event.clientY - this.drag.y) * 0.004, -1.15, 1.15);
        this.updateWalkLook();
      }
      this.drag.x = event.clientX;
      this.drag.y = event.clientY;
    });
    this.listen(canvas, 'pointerup', (event) => {
      if (!this.drag || this.drag.id !== event.pointerId) return;
      const click = !this.drag.moved;
      this.drag = null;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      if (click) this.pick(event);
    });
    this.listen(canvas, 'pointercancel', () => { this.drag = null; });
    this.listen(window, 'keydown', (event) => {
      if (this.mode !== 'walk' || this.measureEnabled || document.activeElement?.matches('input,textarea,select,[contenteditable="true"]')) return;
      // Keyboard motion is scoped to the scene so form fields and page scrolling keep working.
      if (document.activeElement !== canvas && !this.container.contains(document.activeElement)) return;
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight'].includes(event.code)) {
        event.preventDefault();
        this.keys.add(event.code);
      }
    });
    this.listen(window, 'keyup', (event) => this.keys.delete(event.code));
    this.listen(window, 'blur', () => this.keys.clear());
    this.listen(document, 'visibilitychange', () => { if (document.hidden) this.keys.clear(); });
  }

  toWorld(points) {
    return validPoints(points).map(([x, z]) => [(x - 0.5) * this.width, (z - 0.5) * this.depth]);
  }

  material(color, options = {}) {
    return new THREE.MeshStandardMaterial({ color, roughness: 0.89, metalness: 0, ...options });
  }

  floorLabel(text, confirmed = false) {
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 128;
    const ctx = canvas.getContext('2d');
    const background = confirmed ? '#244d39' : '#725b37';
    ctx.fillStyle = background;
    ctx.beginPath();
    ctx.roundRect(18, 22, 220, 84, 18);
    ctx.fill();
    ctx.strokeStyle = confirmed ? '#b8d4c3' : '#ead7af';
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 54px "Arial"';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 128, 65);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false });
    const sprite = new THREE.Sprite(material);
    sprite.renderOrder = 40;
    sprite.scale.set(18, 9, 1);
    return sprite;
  }

  mesh(geometry, material, name, group = this.city) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name || '';
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  }

  addPolygon(points, y, material, name) {
    if (points.length < 3) return null;
    const geometry = new THREE.ShapeGeometry(shapeFor(points));
    geometry.rotateX(-Math.PI / 2);
    const mesh = this.mesh(geometry, material, name);
    mesh.position.y = y;
    return mesh;
  }

  junctionsFor(paths) {
    const segments = [];
    paths.forEach((path, pathIndex) => path.points.forEach((a, index) => {
      const b = path.points[index + 1];
      if (b) segments.push({ a, b, pathIndex, width: path.width, elevation: path.elevation || 0 });
    }));
    const junctions = new Map();
    for (let i = 0; i < segments.length; i++) for (let j = i + 1; j < segments.length; j++) {
      if (segments[i].pathIndex === segments[j].pathIndex) continue;
      const point = segmentIntersection(segments[i].a, segments[i].b, segments[j].a, segments[j].b);
      if (!point) continue;
      const key = `${Math.round(point[0] * 5)}:${Math.round(point[1] * 5)}`;
      const radius = Math.max(5, Math.min(16, Math.max(segments[i].width, segments[j].width) * 0.56));
      const previous = junctions.get(key);
      junctions.set(key, { point, radius: Math.max(radius, previous?.radius || 0), elevation: Math.max(segments[i].elevation, segments[j].elevation, previous?.elevation || 0) });
    }
    return [...junctions.values()];
  }

  addJunctionPads(paths, asphalt, sidewalk, parent = this.city, roadY = 0.145, sidewalkY = 0.08) {
    this.junctionsFor(paths).forEach(({ point: [x, z], radius, elevation }, index) => {
      const walk = this.mesh(new THREE.CylinderGeometry(radius + 2.4, radius + 2.4, 0.055, 32), sidewalk, `圆角路口_人行道_${index + 1}`, parent);
      walk.position.set(x, sidewalkY + elevation, z);
      const road = this.mesh(new THREE.CylinderGeometry(radius, radius, 0.065, 32), asphalt, `圆角路口_车行道_${index + 1}`, parent);
      road.position.set(x, roadY + elevation, z);
      road.receiveShadow = true;
    });
  }

  setModel(model = {}) {
    if (!this.renderer || this.disposed) return;
    try {
      const firstModel = !this.modelLoaded;
      this.width = clamp(finite(model.siteWidth, 480), 20, 5000);
      this.depth = clamp(finite(model.siteDepth, 330), 20, 5000);
      this.heightFactor = clamp(finite(model.heightFactor, 1), 0.1, 10);
      this.roadWidth = clamp(finite(model.roadWidth, 18), 3, 100);
      this.whiteMode = Boolean(model.whiteMode);
      this.renderStyle = model.renderStyle === 'model' ? 'model' : 'render';
      this.showContext = model.showContext !== false;
      this.contextSeed = Math.trunc(finite(model.contextSeed, 1));
      this.model = model;
      disposeTree(this.city);
      disposeTree(this.measureGroup);
      this.measurePoints = [];
      this.callbacks.onMeasure?.({ distance: null });
      this.buildingMeshes = [];
      this.buildingPolygons = [];
      this.buildingHoles = [];
      this.waterPolygons = [];
      this.roadPaths = [];
      this.contextFootprints = [];
      this.floorLabels = new THREE.Group();
      this.floorLabels.name = '图纸层数标注';
      this.floorLabels.visible = this.mode !== 'walk';
      this.city.add(this.floorLabels);
      const base = this.mesh(new THREE.BoxGeometry(this.width + 12, 3, this.depth + 12), this.material(COLORS.base), '模型地台');
      base.position.y = -1.6;
      const ground = this.mesh(new THREE.PlaneGeometry(this.width, this.depth), this.material(this.whiteMode ? '#eeeee8' : this.renderStyle === 'render' ? '#b8bdae' : COLORS.ground), '地面');
      ground.rotation.x = -Math.PI / 2;
      ground.position.y = 0.01;
      const parkMaterial = this.material(this.whiteMode ? '#e2e6df' : this.renderStyle === 'render' ? '#72855e' : COLORS.grass);
      this.parkPolygons = featureList(model.parks).map((park, i) => {
        const points = this.toWorld(park.points ?? park.polygon);
        this.addPolygon(points, 0.06, parkMaterial, park.name || `绿地_${i + 1}`);
        return points;
      }).filter((points) => points.length >= 3);
      const waterMaterial = this.material(this.whiteMode ? '#bfcfce' : this.renderStyle === 'render' ? '#507779' : COLORS.water, { roughness: 0.3, metalness: 0.05 });
      featureList(model.water).forEach((water, i) => {
        const points = this.toWorld(water.points ?? water.polygon);
        if (points.length < 3) return;
        this.waterPolygons.push(points);
        this.addPolygon(points, 0.095, waterMaterial, water.name || `水面_${i + 1}`);
        const shore = points.flatMap(([x, z], j) => [x, 0.11, z, points[(j + 1) % points.length][0], 0.11, points[(j + 1) % points.length][1]]);
        this.addLines(shore, this.whiteMode ? '#a6b1ab' : '#679c95', '水岸线');
      });
      this.addRoads(model.roads);
      this.addBuildings(model.buildings || []);
      if (model.showTrees !== false) this.addTrees();
      if (model.showPeople !== false) this.addScaleReferences();
      this.addSiteBoundary();
      this.context = new THREE.Group();
      this.context.name = `周边环境_随机示意_种子${this.contextSeed}`;
      this.context.userData = { illustrativeContext: true, seed: this.contextSeed, description: '随机生成的周边示意，并非原图外真实环境。' };
      this.city.add(this.context);
      if (this.showContext) this.addContext();
      this.updateGrid();
      const extent = Math.max(this.width, this.depth) * 0.74;
      Object.assign(this.sun.shadow.camera, { left: -extent, right: extent, top: extent, bottom: -extent, far: Math.max(1600, extent * 6) });
      this.sun.position.set(-this.width * 0.65, Math.max(this.width, this.depth) * (this.renderStyle === 'render' ? 0.9 : 1.1), this.depth * 0.75);
      this.sun.shadow.camera.updateProjectionMatrix();
      this.controls.maxDistance = Math.max(this.width, this.depth) * 4;
      const extentMax = Math.max(this.width, this.depth);
      this.scene.background.set(this.renderStyle === 'render' ? '#dde7e5' : COLORS.background);
      this.scene.fog.color.copy(this.scene.background);
      this.scene.fog.near = extentMax * (this.renderStyle === 'render' && this.showContext ? 1.7 : 3);
      this.scene.fog.far = extentMax * (this.renderStyle === 'render' && this.showContext ? 4.5 : 7);
      this.sun.color.set(this.renderStyle === 'render' ? '#fff7ed' : '#fff5df');
      this.sun.intensity = this.renderStyle === 'render' ? 3 : 3.3;
      if (this.skyLight) this.skyLight.intensity = this.renderStyle === 'render' ? 2.3 : 2.6;
      this.renderer.toneMappingExposure = this.renderStyle === 'render' ? 1.06 : 1.32;
      this.camera.far = Math.max(5000, this.width * 12, this.depth * 12);
      this.camera.updateProjectionMatrix();
      this.modelLoaded = true;
      if (firstModel) this.resetView();
      else if (this.mode === 'walk' && !this.isWalkable(this.camera.position.x, this.camera.position.z)) {
        const position = this.findWalkPosition();
        this.camera.position.set(position[0], this.walkEyeHeight(...position), position[1]);
      }
      this.setSelected(this.selectedId);
      this.dirty = true;
      this.renderer.render(this.scene, this.camera);
      if (firstModel) this.callbacks.onReady?.();
    } catch (error) { this.reportError(error); }
  }

  addLines(vertices, color, name, parent = this.city) {
    if (!vertices.length) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color }));
    lines.name = name;
    parent.add(lines);
    return lines;
  }

  addRoads(roads) {
    const sidewalk = this.material(this.whiteMode ? '#f5f5ee' : COLORS.sidewalk);
    const asphalt = this.material(this.whiteMode ? '#d8ddd8' : this.renderStyle === 'render' ? '#596467' : COLORS.road);
    const dashes = [];
    featureList(roads).forEach((road, index) => {
      const points = this.toWorld(road.points ?? road.path);
      // The global control scales the illustrated roads while preserving hierarchy.
      const width = clamp(finite(road.width, 18) * this.roadWidth / 18, 3, 100);
      if (points.length < 2) return;
      const isPolygon = road.isPolygon || road.kind === 'polygon' || road.surface === true;
      if (isPolygon) {
        this.addPolygon(points, 0.16, asphalt, road.name || `道路_${index + 1}`);
        return;
      }
      const path = road.closed ? [...points, points[0]] : points;
      this.roadPaths.push({ points: path, width, role: road.role || 'street', extend: road.extend || null, name: road.name || `道路_${index + 1}` });
      for (let i = 0; i < path.length - 1; i++) {
        const a = path[i], b = path[i + 1];
        const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (length < 0.01) continue;
        const angle = -Math.atan2(b[1] - a[1], b[0] - a[0]);
        for (const [extra, y, mat, name] of [[4, 0.08, sidewalk, '人行道'], [0, 0.145, asphalt, '路面']]) {
          const segment = this.mesh(new THREE.BoxGeometry(length, 0.06, width + extra), mat, `${name}_${index + 1}_${i + 1}`);
          segment.position.set((a[0] + b[0]) / 2, y, (a[1] + b[1]) / 2);
          segment.rotation.y = angle;
        }
        const dx = (b[0] - a[0]) / length, dz = (b[1] - a[1]) / length;
        if (width >= 9) for (let t = width * 0.7; t < length - width * 0.7; t += 11) {
          dashes.push(a[0] + dx * t, 0.19, a[1] + dz * t, a[0] + dx * Math.min(t + 4, length), 0.19, a[1] + dz * Math.min(t + 4, length));
        }
      }
    });
    this.addJunctionPads(this.roadPaths, asphalt, sidewalk, this.city, 0.145, 0.08);
    this.addLines(dashes, COLORS.marking, '道路中心虚线');
  }

  addBuildings(buildings) {
    const materialByType = {
      low: this.material(this.whiteMode ? '#eeeee9' : COLORS.low),
      tower: this.material(this.whiteMode ? '#eeeee9' : COLORS.tower),
      slab: this.material(this.whiteMode ? '#eeeee9' : COLORS.slab),
    };
    const floors = [], roofEdges = [], facade = {};
    for (let index = 0; index < buildings.length; index++) {
      const building = buildings[index];
      const points = this.toWorld(building.points ?? building.footprint);
      if (points.length < 3) continue;
      const holes = (building.holes || []).map((hole) => this.toWorld(hole)).filter((hole) => hole.length >= 3);
      const height = clamp(finite(building.height, 18) * this.heightFactor, 2, 800);
      const kind = building.kind ?? building.type;
      const type = kind === 'tower' || kind === 'high' ? 'tower' : kind === 'slab' ? 'slab' : 'low';
      const material = materialByType[type].clone();
      material.polygonOffset = true;
      material.polygonOffsetFactor = 1;
      material.polygonOffsetUnits = 1;
      if (building.color && !this.whiteMode) material.color.set(building.color);
      if (this.renderStyle === 'render' && !this.whiteMode && !building.color) {
        const palette = type === 'tower' ? ['#d9dedb', '#cbd3d1', '#dad5c9'] : type === 'slab' ? ['#d3dbd8', '#dad9cf', '#c5d0cf'] : ['#d4d8d2', '#d8cfbd', '#c3aa91'];
        material.color.set(palette[index % palette.length]);
        material.roughness = type === 'tower' ? 0.83 : 0.73;
      }
      const pitchedRoof = this.renderStyle === 'render' && building.roofType === 'pitched';
      const roofRoom = this.renderStyle === 'render' && !pitchedRoof && type === 'tower' ? this.roofRoomFootprint(points, holes, building.roofCore) : null;
      const roofReserve = pitchedRoof
        ? clamp(finite(building.roofRise, 2.4), 1.2, 5)
        : this.renderStyle === 'render' ? (roofRoom ? Math.min(finite(building.roofCore?.height, 2.4), height * 0.12) : Math.min(0.65, height * 0.1)) : 0;
      // Occupied storeys use the full floors × floorHeight value. Parapets and roof
      // plant sit above it, otherwise a labelled 21F tower would render only 20 facade bands.
      const bodyHeight = height;
      const fullHeight = height + roofReserve;
      const insetPoints = this.renderStyle === 'render' ? this.validRoofFeature(building.roofInset?.points, points, holes) : null;
      const roofInset = insetPoints ? { points: insetPoints, depth: clamp(finite(building.roofInset.depth, 1.2), 0.1, Math.min(3, bodyHeight * 0.2)) } : null;
      const geometry = new THREE.ExtrudeGeometry(shapeFor(points, holes), { depth: bodyHeight - (roofInset?.depth || 0), bevelEnabled: false, curveSegments: 1, steps: 1 });
      geometry.rotateX(-Math.PI / 2);
      const mesh = this.mesh(geometry, material, building.name || `建筑_${index + 1}`);
      mesh.position.y = 0.2;
      mesh.castShadow = true;
      mesh.userData = { id: building.id ?? `building-${index}`, buildingId: building.id ?? `building-${index}`, height: fullHeight, occupiedHeight: height, bodyHeight, floors: building.floors, type, baseColor: material.color.getHex(), holes: holes.length };
      this.buildingMeshes.push(mesh);
      this.buildingPolygons.push(points);
      this.buildingHoles.push(holes);
      if (this.model.showFloorLabels !== false) {
        const floorCount = Math.max(1, Math.round(finite(building.floors, height / Math.max(2.4, finite(building.floorHeight, 3)))));
        const estimated = building.floorBasis === 'shadow';
        const label = this.floorLabel(`${estimated ? '≈' : ''}${floorCount}F`, !estimated);
        const maxX = Math.max(...points.map((point) => point[0]));
        const maxZ = Math.max(...points.map((point) => point[1]));
        label.position.set(maxX - 2.5, fullHeight + 6.2, maxZ - 2.5);
        label.userData = { buildingId: building.id, floors: floorCount, source: building.floorBasis || 'manual' };
        this.floorLabels.add(label);
      }
      for (const ring of [points, ...holes]) for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        roofEdges.push(a[0], bodyHeight + 0.23, a[1], b[0], bodyHeight + 0.23, b[1]);
        if (this.renderStyle === 'model') roofEdges.push(a[0], 0.23, a[1], a[0], bodyHeight + 0.23, a[1]);
        const floorHeight = Math.max(2.7, finite(building.floorHeight, 3));
        for (let y = floorHeight; y < bodyHeight - 0.6; y += floorHeight) {
          if (this.renderStyle === 'model') floors.push(a[0], y + 0.2, a[1], b[0], y + 0.2, b[1]);
        }
      }
      if (this.renderStyle === 'render') {
        this.buildFacade(points, holes, bodyHeight, 0.2, type, facade, index + 11, false, finite(building.floorHeight, 3));
        if (pitchedRoof) this.addPitchedRoof(mesh, points, bodyHeight, roofReserve, building.roofColor, index);
        else this.addRoofDetails(mesh, points, holes, bodyHeight, fullHeight, roofRoom, facade, roofInset);
      }
      holes.forEach((hole, holeIndex) => {
        this.addPolygon(hole, 0.075, this.material(this.whiteMode ? '#e2e4dc' : '#c4c6ac'), `建筑内院地面_${index + 1}_${holeIndex + 1}`);
      });
    }
    Object.values(materialByType).forEach((material) => material.dispose());
    this.addLines(floors, this.whiteMode ? '#d8dcd5' : '#e7e7dc', '楼层线');
    this.addLines(roofEdges, this.whiteMode ? '#a4ada4' : COLORS.edge, '建筑轮廓线');
    if (this.renderStyle === 'render') this.flushFacade(facade, this.city, false);
  }

  recordBox(batches, key, x, y, z, sx, sy, sz, angle = 0) {
    if (sx <= 0 || sy <= 0 || sz <= 0) return;
    const matrix = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), angle), new THREE.Vector3(sx, sy, sz));
    (batches[key] ||= []).push(matrix);
  }

  flushFacade(batches, parent, muted = false) {
    const colors = {
      frame: this.whiteMode ? '#eeeee7' : muted ? '#d0d7d1' : '#dce2df',
      glass: this.whiteMode ? '#c2cecb' : muted ? '#788d96' : '#4e6878',
      glassLight: this.whiteMode ? '#d4dcda' : muted ? '#a2afb0' : '#8a9fa7',
      retail: this.whiteMode ? '#bcc8c5' : muted ? '#718993' : '#536f7c',
      cornice: this.whiteMode ? '#eeeeea' : muted ? '#d0d6d0' : '#e0e4e1',
      balcony: this.whiteMode ? '#e2e6e1' : '#b6c5c6',
    };
    Object.entries(batches).forEach(([key, matrices]) => {
      if (!matrices.length) return;
      const glazing = ['glass', 'glassLight', 'retail'].includes(key);
      const material = this.material(colors[key] || '#d6d7cf', { roughness: glazing ? 0.31 : 0.8, metalness: glazing ? 0.12 : 0 });
      const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, matrices.length);
      matrices.forEach((matrix, index) => mesh.setMatrixAt(index, matrix));
      mesh.name = `${muted ? '周边' : '主城'}立面_${key}`;
      mesh.receiveShadow = true;
      mesh.castShadow = key === 'cornice' || key === 'balcony';
      parent.add(mesh);
    });
  }

  buildFacade(points, holes, height, baseY, kind, batches, seed, muted = false, floorHeight = 3) {
    const random = seededRandom(seed);
    const rings = [points, ...holes];
    rings.forEach((ring, ringIndex) => {
      const outward = (signedArea(ring) >= 0 ? 1 : -1) * (ringIndex ? -1 : 1);
      for (let edge = 0; edge < ring.length; edge++) {
        const a = ring[edge], b = ring[(edge + 1) % ring.length];
        const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (length < 2) continue;
        const dx = (b[0] - a[0]) / length, dz = (b[1] - a[1]) / length;
        const nx = dz * outward, nz = -dx * outward, angle = -Math.atan2(dz, dx);
        const count = Math.max(1, Math.floor((length - 1) / (muted ? 4.3 : kind === 'tower' ? 3.05 : 3.45)));
        const spacing = (length - 0.9) / count;
        const windowWidth = Math.min(muted ? 1.55 : kind === 'tower' ? 1.55 : 1.85, spacing * 0.68);
        const floorStep = Math.max(2.7, floorHeight);
        for (let floor = 0, y = floorStep + 1.2; y + 0.85 <= height - 0.15; floor++, y += floorStep) {
          for (let column = 0; column < count; column++) {
            const t = 0.45 + spacing * (column + 0.5);
            const x = a[0] + dx * t, z = a[1] + dz * t;
            if (!muted) this.recordBox(batches, 'frame', x + nx * 0.06, baseY + y, z + nz * 0.06, windowWidth + 0.18, 1.88, 0.19, angle);
            this.recordBox(batches, random() > 0.23 ? 'glass' : 'glassLight', x + nx * (muted ? 0.045 : 0.165), baseY + y, z + nz * (muted ? 0.045 : 0.165), windowWidth, 1.7, 0.065, angle);
            if (!muted && kind === 'slab' && floor % 3 === 1 && column % 4 === 1 && length > 16 && !ringIndex) {
              this.recordBox(batches, 'cornice', x + nx * 0.62, baseY + y - 0.97, z + nz * 0.62, windowWidth + 0.55, 0.15, 1.18, angle);
              this.recordBox(batches, 'balcony', x + nx * 1.15, baseY + y - 0.43, z + nz * 1.15, windowWidth + 0.5, 0.84, 0.07, angle);
            }
          }
        }
        if (height > 4 && length > 4) {
          const shopCount = Math.max(1, Math.floor(length / (muted ? 6 : 4.7))), shopSpacing = length / shopCount;
          for (let column = 0; column < shopCount; column++) {
            const t = shopSpacing * (column + 0.5);
            this.recordBox(batches, 'retail', a[0] + dx * t + nx * 0.045, baseY + 1.5, a[1] + dz * t + nz * 0.045, Math.max(0.8, shopSpacing - 0.8), 2.5, 0.075, angle);
          }
          if (!muted) this.recordBox(batches, 'cornice', (a[0] + b[0]) / 2 + nx * 0.12, baseY + 3.04, (a[1] + b[1]) / 2 + nz * 0.12, length, 0.23, 0.5, angle);
        }
      }
    });
  }

  validRoofFeature(input, outer, holes) {
    const points = this.toWorld(input);
    if (points.length < 3) return null;
    if (!points.every(([x, z]) => pointInPolygon(x, z, outer) && !holes.some((hole) => pointInPolygon(x, z, hole)))) return null;
    if (holes.some((hole) => hole.some(([x, z]) => pointInPolygon(x, z, points)))) return null;
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      for (const t of [0.25, 0.5, 0.75]) if (!pointInPolygon(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, outer)) return null;
    }
    return points;
  }

  roofRoomFootprint(points, holes, provided) {
    const explicit = this.validRoofFeature(provided?.points, points, holes);
    if (explicit) {
      const xs = explicit.map((point) => point[0]), zs = explicit.map((point) => point[1]);
      return { points: explicit, cx: (Math.min(...xs) + Math.max(...xs)) / 2, cz: (Math.min(...zs) + Math.max(...zs)) / 2, width: Math.max(...xs) - Math.min(...xs), depth: Math.max(...zs) - Math.min(...zs) };
    }
    if (holes.length) return null;
    const xs = points.map((point) => point[0]), zs = points.map((point) => point[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cz = (Math.min(...zs) + Math.max(...zs)) / 2;
    for (const ratio of [0.38, 0.29, 0.2]) {
      const width = (Math.max(...xs) - Math.min(...xs)) * ratio, depth = (Math.max(...zs) - Math.min(...zs)) * ratio;
      if (width < 2.5 || depth < 2.5) continue;
      const corners = [[cx - width / 2, cz - depth / 2], [cx + width / 2, cz - depth / 2], [cx + width / 2, cz + depth / 2], [cx - width / 2, cz + depth / 2]];
      if (corners.every(([x, z]) => pointInPolygon(x, z, points))) return { points: corners, cx, cz, width, depth };
    }
    return null;
  }

  addPitchedRoof(buildingMesh, points, bodyHeight, rise, color, seed = 0) {
    if (points.length < 3) return;
    const centre = points.reduce((sum, point) => [sum[0] + point[0] / points.length, sum[1] + point[1] / points.length], [0, 0]);
    const vertices = [];
    for (let index = 0; index < points.length; index++) {
      const a = points[index], b = points[(index + 1) % points.length];
      vertices.push(a[0], bodyHeight + 0.025, a[1], b[0], bodyHeight + 0.025, b[1], centre[0], bodyHeight + rise, centre[1]);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geometry.computeVertexNormals();
    const tones = ['#75665f', '#665c58', '#806d62', '#615d5b'];
    const material = this.material(this.whiteMode ? '#dedfd8' : color || tones[seed % tones.length], { roughness: 0.94, side: THREE.DoubleSide });
    const roof = this.mesh(geometry, material, '滨水建筑_坡屋顶', buildingMesh);
    roof.castShadow = true;
    roof.userData = { id: buildingMesh.userData.id, roofType: 'pitched', rise };
    const edges = [];
    points.forEach((point, index) => {
      const next = points[(index + 1) % points.length];
      edges.push(point[0], bodyHeight + 0.04, point[1], next[0], bodyHeight + 0.04, next[1]);
      edges.push(point[0], bodyHeight + 0.04, point[1], centre[0], bodyHeight + rise + 0.02, centre[1]);
    });
    this.addLines(edges, this.whiteMode ? '#9da59e' : '#514943', '坡屋顶_檐口与屋脊', buildingMesh);
  }

  addRoofDetails(buildingMesh, points, holes, bodyHeight, fullHeight, roofRoom, facade, roofInset) {
    const roofHoles = roofInset ? [...holes, roofInset.points] : holes;
    if (roofInset) {
      const upperGeometry = new THREE.ExtrudeGeometry(shapeFor(points, roofHoles), { depth: roofInset.depth, bevelEnabled: false, curveSegments: 1, steps: 1 });
      upperGeometry.rotateX(-Math.PI / 2);
      const upper = this.mesh(upperGeometry, buildingMesh.material, '屋面浅退台_围边', buildingMesh);
      upper.position.y = bodyHeight - roofInset.depth;
      upper.castShadow = true;
      upper.userData = { id: buildingMesh.userData.id, shallowRoofInset: true };
      const floorGeometry = new THREE.ShapeGeometry(shapeFor(roofInset.points));
      floorGeometry.rotateX(-Math.PI / 2);
      const floor = this.mesh(floorGeometry, this.material(this.whiteMode ? '#d8ded4' : '#aaa99c'), '屋面浅退台_底面_非贯通天井', buildingMesh);
      floor.position.y = bodyHeight - roofInset.depth + 0.008;
      floor.userData = { id: buildingMesh.userData.id };
    }
    const roofGeometry = new THREE.ShapeGeometry(shapeFor(points, roofHoles));
    roofGeometry.rotateX(-Math.PI / 2);
    const roof = this.mesh(roofGeometry, this.material(this.whiteMode ? '#e6e7e0' : '#c6ceca'), '屋面_浅色防水层', buildingMesh);
    roof.position.y = bodyHeight + 0.008;
    roof.userData = { id: buildingMesh.userData.id };
    const parapetHeight = Math.min(0.65, fullHeight - bodyHeight);
    [points, ...holes].forEach((ring) => {
      for (let index = 0; index < ring.length; index++) {
        const a = ring[index], b = ring[(index + 1) % ring.length], length = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const angle = -Math.atan2(b[1] - a[1], b[0] - a[0]);
        this.recordBox(facade, 'cornice', (a[0] + b[0]) / 2, 0.2 + bodyHeight + parapetHeight / 2, (a[1] + b[1]) / 2, length + 0.12, parapetHeight, 0.36, angle);
      }
    });
    if (roofRoom) {
      const roomHeight = fullHeight - bodyHeight;
      const lower = roofInset ? roofInset.depth : 0;
      const machineGeometry = new THREE.ExtrudeGeometry(shapeFor(roofRoom.points), { depth: roomHeight + lower, bevelEnabled: false, curveSegments: 1, steps: 1 });
      machineGeometry.rotateX(-Math.PI / 2);
      const machine = this.mesh(machineGeometry, this.material(this.whiteMode ? '#e9e9e3' : '#d3d7cf'), '屋顶机房_高度计入总高', buildingMesh);
      machine.position.y = bodyHeight - lower;
      machine.castShadow = true;
      machine.userData = { id: buildingMesh.userData.id };
      const grille = this.mesh(new THREE.BoxGeometry(roofRoom.width * 0.58, roomHeight * 0.38, 0.05), this.material(this.whiteMode ? '#bcc8c5' : '#71807b'), '屋顶机房_通风百叶', buildingMesh);
      grille.position.set(roofRoom.cx, bodyHeight + roomHeight * 0.48, roofRoom.cz + roofRoom.depth / 2 + 0.026);
      grille.userData = { id: buildingMesh.userData.id };
    }
  }

  isOnRoad(x, z, extra = 0) {
    return this.roadPaths.some(({ points, width }) => points.some((a, i) => i < points.length - 1 && distanceToSegment(x, z, a, points[i + 1]) < width / 2 + extra));
  }

  isFree(x, z, clearance = 0) {
    if (Math.abs(x) > this.width / 2 - clearance || Math.abs(z) > this.depth / 2 - clearance) return false;
    for (let index = 0; index < this.buildingPolygons.length; index++) {
      const polygon = this.buildingPolygons[index], holes = this.buildingHoles[index] || [];
      if (pointInPolygon(x, z, polygon) && !holes.some((hole) => pointInPolygon(x, z, hole))) return false;
      if (clearance && [polygon, ...holes].some((ring) => ring.some((a, i) => distanceToSegment(x, z, a, ring[(i + 1) % ring.length]) < clearance))) return false;
    }
    for (const polygon of this.waterPolygons) {
      if (pointInPolygon(x, z, polygon)) return false;
      if (clearance && polygon.some((a, i) => distanceToSegment(x, z, a, polygon[(i + 1) % polygon.length]) < clearance)) return false;
    }
    return true;
  }

  addTrees() {
    const positions = [], taken = new Set();
    const add = (x, z, seed) => {
      const key = `${Math.round(x / 5)}:${Math.round(z / 5)}`;
      if (taken.has(key) || !this.isFree(x, z, 2.6) || this.isOnRoad(x, z, 0.7)) return;
      taken.add(key);
      positions.push({ x, z, scale: 0.75 + (Math.sin(seed * 14.331) + 1) * 0.16 });
    };
    this.roadPaths.forEach(({ points, width }, roadIndex) => {
      for (let i = 0; i < points.length - 1; i++) {
        const a = points[i], b = points[i + 1], length = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const dx = (b[0] - a[0]) / (length || 1), dz = (b[1] - a[1]) / (length || 1);
        for (let t = 10; t < length - 7; t += 12) for (const side of [-1, 1]) {
          add(a[0] + t * dx - dz * (width / 2 + 3.5) * side, a[1] + t * dz + dx * (width / 2 + 3.5) * side, roadIndex * 51 + t + side);
        }
      }
    });
    this.parkPolygons.forEach((polygon, index) => {
      const xs = polygon.map((p) => p[0]), zs = polygon.map((p) => p[1]);
      const spacing = Math.max(11, Math.max(this.width, this.depth) / 55);
      for (let x = Math.min(...xs) + 4; x < Math.max(...xs); x += spacing) for (let z = Math.min(...zs) + 4; z < Math.max(...zs); z += spacing) {
        const px = x + Math.sin(z * 0.31) * 2, pz = z + Math.cos(x * 0.27) * 2;
        if (pointInPolygon(px, pz, polygon)) add(px, pz, x + z + index);
      }
    });
    this.buildingHoles.forEach((holes, index) => holes.forEach((hole) => {
      const xs = hole.map((point) => point[0]), zs = hole.map((point) => point[1]);
      for (let x = Math.min(...xs) + 3; x < Math.max(...xs) - 2; x += 10) for (let z = Math.min(...zs) + 3; z < Math.max(...zs) - 2; z += 10) {
        if (pointInPolygon(x, z, hole)) add(x, z, x + z + index);
      }
    }));
    this.createVegetation(positions.slice(0, 650), this.city, 171, false);
  }

  createVegetation(trees, parent, seed, muted) {
    if (!trees.length) return;
    const random = seededRandom(seed), detailed = this.renderStyle === 'render';
    const clustersPerTree = detailed ? 7 : 4;
    const crowns = new THREE.InstancedMesh(new THREE.SphereGeometry(1, detailed ? 10 : 8, detailed ? 7 : 6), this.material('#ffffff', { roughness: 0.96 }), trees.length * clustersPerTree);
    const branches = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.8, 1, 1, 6), this.material(this.whiteMode ? '#a3ac9d' : '#7c7764'), trees.length * 4);
    const matrix = new THREE.Matrix4(), quaternion = new THREE.Quaternion(), scale = new THREE.Vector3(), position = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0), color = new THREE.Color();
    const leafPalette = this.whiteMode ? ['#c5cdbf', '#d3d9cc', '#bfc9b9'] : detailed ? (muted ? ['#456346', '#587a50', '#3b6046'] : ['#254d31', '#3b643c', '#497544', '#335c36', '#5b7f49']) : ['#718b64', '#859e70', '#92a479', '#688363', '#a1b080'];
    const leavesPerTree = muted ? 60 : (this.container?.clientWidth || 1000) < 600 ? 90 : 144;
    let leaves = null, leafNumber = 0;
    if (detailed) {
      // Two intersecting almond-shaped blades make each small sprig visible from any direction.
      const blade = [[0, -0.55], [-0.28, -0.15], [-0.23, 0.2], [0, 0.58], [0.23, 0.2], [0.28, -0.15]];
      const vertices = [], indices = [];
      for (let plane = 0; plane < 2; plane++) {
        blade.forEach(([x, y]) => vertices.push(plane ? 0 : x, y, plane ? x : 0));
        for (let triangle = 1; triangle < 5; triangle++) indices.push(plane * 6, plane * 6 + triangle, plane * 6 + triangle + 1);
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
      geometry.setIndex(indices); geometry.computeVertexNormals();
      leaves = new THREE.InstancedMesh(geometry, this.material('#ffffff', { side: THREE.DoubleSide, roughness: 1 }), trees.length * leavesPerTree);
      leaves.name = `${muted ? '周边' : '主城'}树木_参差叶缘与细叶簇`;
      leaves.castShadow = true; leaves.receiveShadow = true;
    }
    let leafIndex = 0, branchIndex = 0;
    const addBranch = (from, to, radius) => {
      const direction = to.clone().sub(from);
      position.copy(from).add(to).multiplyScalar(0.5);
      quaternion.setFromUnitVectors(up, direction.clone().normalize());
      scale.set(radius, direction.length(), radius);
      matrix.compose(position, quaternion, scale);
      branches.setMatrixAt(branchIndex++, matrix);
    };
    trees.forEach((tree, treeIndex) => {
      const treeScale = tree.scale ?? 1, baseY = tree.y ?? 0.07, rotation = random() * Math.PI * 2;
      const heightVariation = 0.93 + random() * 0.23;
      const base = new THREE.Vector3(tree.x, baseY, tree.z);
      const fork = new THREE.Vector3(tree.x + 0.14 * treeScale, baseY + 3.2 * treeScale, tree.z - 0.1 * treeScale);
      addBranch(base, fork, 0.23 * treeScale);
      for (let branch = 0; branch < 3; branch++) {
        const angle = rotation + branch * Math.PI * 2 / 3;
        addBranch(fork, new THREE.Vector3(tree.x + Math.cos(angle) * 1.7 * treeScale, baseY + (5 + random() * 0.8) * treeScale, tree.z + Math.sin(angle) * 1.7 * treeScale), 0.105 * treeScale);
      }
      const clusterSurfaces = [];
      for (let cluster = 0; cluster < clustersPerTree; cluster++) {
        const angle = rotation + cluster * 2.39996;
        const radius = cluster === 0 ? 0.2 : (cluster < 4 ? 1.35 : 1.9) * treeScale;
        const size = (cluster === 0 ? 2.25 : cluster < 4 ? 1.8 : 1.25) * (0.86 + random() * 0.26) * treeScale;
        position.set(tree.x + Math.cos(angle) * radius, baseY + (cluster === 0 ? 5.9 : cluster < 4 ? 5.25 : 6.2) * treeScale * heightVariation + (random() - 0.5) * 0.7, tree.z + Math.sin(angle) * radius);
        scale.set(size * (1 + random() * 0.18), size * (0.87 + random() * 0.24), size * (0.84 + random() * 0.22));
        quaternion.setFromEuler(new THREE.Euler(random() * 0.5, angle, random() * 0.45));
        clusterSurfaces.push({ centre: position.clone(), scale: scale.clone(), rotation: quaternion.clone() });
        if (detailed) scale.multiplyScalar(0.58);
        matrix.compose(position, quaternion, scale);
        crowns.setMatrixAt(leafIndex, matrix);
        color.set(leafPalette[(treeIndex + cluster) % leafPalette.length]).multiplyScalar(detailed ? 0.7 + random() * 0.09 : 0.93 + random() * 0.12);
        crowns.setColorAt(leafIndex++, color);
      }
      if (leaves) for (let leaf = 0; leaf < leavesPerTree; leaf++) {
        const surface = clusterSurfaces[leaf % clusterSurfaces.length];
        const theta = random() * Math.PI * 2, vertical = random() * 2 - 1;
        const horizontal = Math.sqrt(1 - vertical * vertical), radial = 0.74 + random() * 0.4;
        position.set(Math.cos(theta) * horizontal, vertical, Math.sin(theta) * horizontal).multiply(surface.scale).multiplyScalar(radial).applyQuaternion(surface.rotation).add(surface.centre);
        const leafSize = (0.56 + random() * 0.42) * treeScale;
        scale.set(leafSize * (0.8 + random() * 0.45), leafSize, leafSize);
        quaternion.setFromEuler(new THREE.Euler(random() * Math.PI, random() * Math.PI * 2, random() * Math.PI));
        matrix.compose(position, quaternion, scale);
        leaves.setMatrixAt(leafNumber, matrix);
        color.set(leafPalette[(treeIndex + leaf) % leafPalette.length]).multiplyScalar(0.84 + random() * 0.28);
        leaves.setColorAt(leafNumber++, color);
      }
    });
    crowns.name = `${muted ? '周边' : '主城'}树木_多簇分层叶冠`;
    branches.name = `${muted ? '周边' : '主城'}树木_树干与分叉`;
    crowns.castShadow = true; crowns.receiveShadow = true;
    branches.castShadow = true; branches.receiveShadow = true;
    parent.add(crowns, branches);
    if (leaves) parent.add(leaves);
  }

  addScaleReferences() {
    const personBody = new THREE.CylinderGeometry(0.18, 0.14, 0.82, 6);
    const personHead = new THREE.SphereGeometry(0.14, 7, 5);
    const personLeg = new THREE.CylinderGeometry(0.067, 0.075, 0.62, 5);
    const bodies = [this.material('#b76c4e'), this.material('#687e80'), this.material('#e4d5b7')];
    const skin = this.material('#d9b49a'), legs = this.material('#67716b');
    const carBase = new THREE.BoxGeometry(4.5, 0.8, 1.8), carTop = new THREE.BoxGeometry(2.2, 0.6, 1.5);
    const cars = [this.material('#f2efe2'), this.material('#8a9c9b'), this.material('#b2816b')];
    const glass = this.material('#667f80', { roughness: 0.36 });
    let peopleCount = 0, carCount = 0;
    const matrices = [[], [], []];
    const heads = [], feet = [], carMatrices = [[], [], []], glassMatrices = [];
    const dummy = new THREE.Object3D();
    const record = (target, x, y, z, angle = 0) => {
      dummy.position.set(x, y, z); dummy.rotation.set(0, angle, 0); dummy.scale.set(1, 1, 1); dummy.updateMatrix(); target.push(dummy.matrix.clone());
    };
    for (let r = 0; r < this.roadPaths.length; r++) {
      const { points, width } = this.roadPaths[r];
      for (let i = 0; i < points.length - 1; i++) {
        const a = points[i], b = points[i + 1], length = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const dx = (b[0] - a[0]) / (length || 1), dz = (b[1] - a[1]) / (length || 1);
        for (let t = 16 + (r % 3) * 5; t < length - 8 && peopleCount < 68; t += 32) {
          const side = peopleCount % 2 ? 1 : -1;
          const x = a[0] + t * dx - dz * (width / 2 + 1.1) * side, z = a[1] + t * dz + dx * (width / 2 + 1.1) * side;
          if (!this.isFree(x, z, 0.6)) continue;
          // Ground at 0.15 m; head top at 1.85 m gives a 1.70 m person.
          record(matrices[peopleCount % 3], x, 1.13, z);
          record(heads, x, 1.71, z);
          record(feet, x - 0.085, 0.46, z - 0.025);
          record(feet, x + 0.085, 0.46, z + 0.025);
          peopleCount++;
        }
        if (width >= 8) for (let t = 29 + (r % 4) * 9; t < length - 20 && carCount < 26; t += 76) {
          const side = carCount % 2 ? 1 : -1;
          const x = a[0] + t * dx - dz * width * 0.23 * side, z = a[1] + t * dz + dx * width * 0.23 * side;
          if (!this.isFree(x, z, 2.3)) continue;
          const angle = -Math.atan2(dz, dx);
          record(carMatrices[carCount % 3], x, 0.74, z, angle);
          record(glassMatrices, x - dx * 0.1, 1.33, z - dz * 0.1, angle);
          carCount++;
        }
      }
    }
    const makeInstances = (geometry, material, transforms, name) => {
      if (!transforms.length) return;
      const mesh = new THREE.InstancedMesh(geometry, material, transforms.length);
      transforms.forEach((matrix, i) => mesh.setMatrixAt(i, matrix));
      mesh.name = name; mesh.castShadow = true; mesh.receiveShadow = true; this.city.add(mesh);
    };
    matrices.forEach((transforms, i) => makeInstances(personBody, bodies[i], transforms, '1.7米行人_身体'));
    makeInstances(personHead, skin, heads, '1.7米行人_头部');
    makeInstances(personLeg, legs, feet, '1.7米行人_腿部');
    carMatrices.forEach((transforms, i) => makeInstances(carBase, cars[i], transforms, '4.5米汽车_车身'));
    makeInstances(carTop, glass, glassMatrices, '汽车_车窗');
    // Unused resources are not attached to the model and need immediate disposal.
    if (!peopleCount) { personBody.dispose(); personHead.dispose(); personLeg.dispose(); bodies.forEach((m) => m.dispose()); skin.dispose(); legs.dispose(); }
    else matrices.forEach((transforms, i) => { if (!transforms.length) bodies[i].dispose(); });
    if (!carCount) { carBase.dispose(); carTop.dispose(); cars.forEach((m) => m.dispose()); glass.dispose(); }
    else carMatrices.forEach((transforms, i) => { if (!transforms.length) cars[i].dispose(); });
  }

  addSiteBoundary() {
    const x = this.width / 2, z = this.depth / 2;
    this.addLines([-x, 0.24, -z, x, 0.24, -z, x, 0.24, -z, x, 0.24, z, x, 0.24, z, -x, 0.24, z, -x, 0.24, z, -x, 0.24, -z], '#a0aaa1', '场地边界');
  }

  addContext() {
    const random = seededRandom(this.contextSeed), margin = clamp(Math.min(this.width, this.depth) * 0.6, 155, 245);
    const halfW = this.width / 2, halfD = this.depth / 2;
    const outerW = halfW + margin, outerD = halfD + margin;
    const outer = [[-outerW, -outerD], [outerW, -outerD], [outerW, outerD], [-outerW, outerD]];
    const opening = [[-halfW - 6, -halfD - 6], [halfW + 6, -halfD - 6], [halfW + 6, halfD + 6], [-halfW - 6, halfD + 6]];
    const groundGeometry = new THREE.ShapeGeometry(shapeFor(outer, [opening]));
    groundGeometry.rotateX(-Math.PI / 2);
    const ground = this.mesh(groundGeometry, this.material(this.whiteMode ? '#e4e7dd' : this.renderStyle === 'render' ? '#a7b49c' : '#cfd5c7'), '随机周边_地面环带', this.context);
    ground.position.y = -0.12;
    const batches = {}, facade = {}, foliage = [], markings = [];
    this.contextFootprints = [];
    const roadSegments = [];
    const addRoad = (a, b, width = 14, elevation = 0) => {
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const angle = -Math.atan2(b[1] - a[1], b[0] - a[0]);
      this.recordBox(batches, 'sidewalk', (a[0] + b[0]) / 2, -0.095 + elevation, (a[1] + b[1]) / 2, length + 0.35, 0.04, width + 5, angle);
      this.recordBox(batches, 'road', (a[0] + b[0]) / 2, -0.055 + elevation, (a[1] + b[1]) / 2, length + 0.35, 0.035, width, angle);
      roadSegments.push({ a, b, width, elevation });
      const dx = (b[0] - a[0]) / (length || 1), dz = (b[1] - a[1]) / (length || 1);
      for (let t = 10; t < length - 10; t += 14) markings.push(a[0] + dx * t, -0.032 + elevation, a[1] + dz * t, a[0] + dx * (t + 4.5), -0.032 + elevation, a[1] + dz * (t + 4.5));
    };
    // One secondary context loop provides plausible block access without producing
    // the previous checkerboard of duplicated roads around every site edge.
    const contextOffset = Math.min(92, margin - 32);
    const contextWest = -halfW - contextOffset, contextEast = halfW + contextOffset;
    const contextNorth = -halfD - contextOffset, contextSouth = halfD + contextOffset;
    addRoad([contextWest, contextNorth], [contextEast, contextNorth], 16);
    addRoad([contextEast, contextNorth], [contextEast, contextSouth], 16);
    addRoad([contextEast, contextSouth], [contextWest, contextSouth], 16);
    addRoad([contextWest, contextSouth], [contextWest, contextNorth], 16);

    // Only streets explicitly marked in the plan may continue beyond the site.
    // The perimeter roads remain a coherent loop instead of being extended as
    // unexplained dead-straight lines through the surrounding blocks.
    this.roadPaths.filter((road) => road.extend).forEach(({ points, width, extend }) => {
      const first = points[0], last = points[points.length - 1];
      const vertical = Math.abs(last[1] - first[1]) > Math.abs(last[0] - first[0]);
      if (vertical) {
        const x = (first[0] + last[0]) / 2, minZ = Math.min(first[1], last[1]), maxZ = Math.max(first[1], last[1]);
        if (extend === 'north-south' || extend === 'north') addRoad([x, contextNorth], [x, minZ + 0.1], Math.max(14, width), 0.2);
        if (extend === 'north-south' || extend === 'south') addRoad([x, maxZ - 0.1], [x, contextSouth], Math.max(14, width), 0.2);
      } else {
        const z = (first[1] + last[1]) / 2, minX = Math.min(first[0], last[0]), maxX = Math.max(first[0], last[0]);
        if (extend === 'east-west' || extend === 'west') addRoad([contextWest, z], [minX + 0.1, z], Math.max(14, width), 0.2);
        if (extend === 'east-west' || extend === 'east') addRoad([maxX - 0.1, z], [contextEast, z], Math.max(14, width), 0.2);
      }
    });
    const nearRoad = (x, z, extra = 0) => roadSegments.some(({ a, b, width }) => distanceToSegment(x, z, a, b) < width / 2 + extra);
    const lots = [];
    for (const side of [-1, 1]) for (const offset of [47, 142]) {
      for (let x = -outerW + 30; x < outerW - 23; x += 63) lots.push([x, side * (halfD + offset)]);
      for (let z = -halfD + 23; z < halfD - 16; z += 61) lots.push([side * (halfW + offset), z]);
    }
    let buildings = 0, parks = 0;
    for (const [lotX, lotZ] of lots.slice(0, 100)) {
      const x = lotX + (random() - 0.5) * 7, z = lotZ + (random() - 0.5) * 7;
      if (nearRoad(x, z, 15)) continue;
      const park = random() < 0.25;
      if (park) {
        const parkW = 31 + random() * 7, parkD = 29 + random() * 9;
        this.recordBox(batches, 'park', x, -0.085, z, parkW, 0.035, parkD);
        this.recordBox(batches, 'path', x, -0.057, z, parkW * 0.96, 0.02, 2.2);
        for (let i = 0; i < 7; i++) {
          const tx = x + (random() - 0.5) * (parkW - 7), tz = z + (random() - 0.5) * (parkD - 7);
          if (!nearRoad(tx, tz, 2)) foliage.push({ x: tx, z: tz, y: -0.065, scale: 0.8 + random() * 0.32 });
        }
        parks++;
        continue;
      }
      const glassTower = this.renderStyle === 'render' && random() < 0.38;
      const width = glassTower ? 17 + random() * 12 : 19 + random() * 17;
      const depth = glassTower ? 17 + random() * 12 : 18 + random() * 17;
      const floors = glassTower ? 8 + Math.floor(random() * 11) : 3 + Math.floor(random() * 7);
      const height = (glassTower ? 3.35 : 3) * floors;
      const footprint = [[x - width / 2, z - depth / 2], [x + width / 2, z - depth / 2], [x + width / 2, z + depth / 2], [x - width / 2, z + depth / 2]];
      if (footprint.some(([px, pz]) => (Math.abs(px) < halfW + 9 && Math.abs(pz) < halfD + 9) || nearRoad(px, pz, 1))) continue;
      const tone = Math.floor(random() * 4);
      const buildingKey = glassTower ? `glassBuilding${tone % 2}` : `building${tone}`;
      this.recordBox(batches, buildingKey, x, -0.075 + height / 2, z, width, height, depth);
      this.recordBox(batches, glassTower ? 'glassCrown' : 'roof', x, height - 0.14, z, width - 0.6, glassTower ? 0.34 : 0.16, depth - 0.6);
      if (glassTower && random() > 0.42) {
        const podiumW = Math.min(width + 12, 39), podiumD = Math.min(depth + 10, 38);
        this.recordBox(batches, 'glassPodium', x, 3.7, z, podiumW, 7.5, podiumD);
      }
      if (this.renderStyle === 'render') this.buildFacade(footprint, [], height, -0.075, glassTower ? 'tower' : 'low', facade, this.contextSeed * 91 + buildings, true, glassTower ? 3.35 : 3.3);
      this.contextFootprints.push({ points: footprint, height });
      buildings++;
    }
    for (const side of [-1, 1]) {
      for (let x = -outerW + 9; x < outerW; x += 15) for (const offset of [13, 39]) {
        const z = side * (halfD + offset);
        if (!nearRoad(x, z, 1.2)) foliage.push({ x, z, y: -0.08, scale: 0.73 + random() * 0.18 });
      }
      for (let z = -halfD + 8; z < halfD; z += 15) {
        const x = side * (halfW + 40);
        if (!nearRoad(x, z, 1.2)) foliage.push({ x, z, y: -0.08, scale: 0.74 + random() * 0.16 });
      }
    }
    const colors = this.renderStyle === 'render' && !this.whiteMode ? { sidewalk: '#ced4ca', road: '#768183', park: '#70855d', path: '#d1d6c6', roof: '#c0cbc5', glassCrown: '#b9d5dd', glassPodium: '#7d9da8', glassBuilding0: '#668795', glassBuilding1: '#8aa8b1', building0: '#ccd4cf', building1: '#d4d1c6', building2: '#bac7c5', building3: '#cfcac0' } : { sidewalk: '#dfdfd3', road: '#bdc7c1', park: '#b2c3a6', path: '#dfdfcb', roof: '#c0c4b9', glassCrown: '#c5d2d3', glassPodium: '#b9c7c8', glassBuilding0: '#aebfc1', glassBuilding1: '#c0cbca', building0: '#cdd0c4', building1: '#d4ccbd', building2: '#bdc8c2', building3: '#cdc2b0' };
    Object.entries(batches).forEach(([key, matrices]) => {
      const glass = key.startsWith('glass');
      const material = this.material(this.whiteMode && (key.startsWith('building') || glass) ? '#e0e3d9' : colors[key], glass ? { roughness: 0.24, metalness: 0.18 } : {});
      const instances = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, matrices.length);
      matrices.forEach((matrix, i) => instances.setMatrixAt(i, matrix));
      instances.name = `随机周边_${key}`;
      instances.castShadow = key.startsWith('building') || glass; instances.receiveShadow = true;
      this.context.add(instances);
    });
    this.addJunctionPads(roadSegments.map(({ a, b, width, elevation }) => ({ points: [a, b], width, elevation })), this.material(colors.road), this.material(colors.sidewalk), this.context, -0.055, -0.095);
    this.addLines(markings, '#e9eadd', '随机周边_道路虚线', this.context);
    if (this.renderStyle === 'render') this.flushFacade(facade, this.context, true);
    if (this.model.showTrees !== false) {
      const safeTrees = foliage.filter(({ x, z }) => !this.contextFootprints.some(({ points }) => pointInPolygon(x, z, points) || points.some((a, i) => distanceToSegment(x, z, a, points[(i + 1) % points.length]) < 2.2)));
      this.createVegetation(safeTrees.slice(0, 280), this.context, this.contextSeed * 23 + 3, true);
    }
    Object.assign(this.context.userData, { buildings, parks, outsideOriginalSite: true });
  }

  updateGrid() {
    if (this.grid) { this.scene.remove(this.grid); disposeTree(this.grid); }
    const size = Math.ceil(Math.max(this.width, this.depth) * 2.7 / 20) * 20;
    this.grid = new THREE.GridHelper(size, Math.min(150, Math.round(size / 20)), '#cdd5ce', '#d7ded7');
    this.grid.position.y = -3.16;
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.52;
    this.scene.add(this.grid);
  }

  setSelected(id) {
    this.selectedId = id ?? null;
    this.buildingMeshes.forEach((mesh) => {
      const selected = id != null && String(mesh.userData.id) === String(id);
      mesh.material.color.set(selected ? COLORS.selected : mesh.userData.baseColor);
      mesh.material.emissive.set(selected ? '#74331b' : '#000000');
      mesh.material.emissiveIntensity = selected ? 0.08 : 0;
    });
    this.dirty = true;
  }

  pick(event) {
    const bounds = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set((event.clientX - bounds.left) / bounds.width * 2 - 1, -(event.clientY - bounds.top) / bounds.height * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    if (this.measureEnabled) {
      const point = this.raycaster.ray.intersectPlane(this.groundPlane, new THREE.Vector3());
      if (!point || Math.abs(point.x) > this.width / 2 || Math.abs(point.z) > this.depth / 2) return;
      if (this.measurePoints.length === 2) {
        this.measurePoints = [];
        disposeTree(this.measureGroup);
        this.callbacks.onMeasure?.({ distance: null });
      }
      this.measurePoints.push(point.clone());
      const marker = this.mesh(new THREE.SphereGeometry(1.1, 14, 10), this.material('#df794a', { depthTest: false }), '测量点', this.measureGroup);
      marker.position.copy(point); marker.position.y = 0.9; marker.renderOrder = 30;
      if (this.measurePoints.length === 2) {
        const [a, b] = this.measurePoints;
        const line = this.addLines([a.x, 0.9, a.z, b.x, 0.9, b.z], '#ce6837', '测量线', this.measureGroup);
        line.material.depthTest = false; line.renderOrder = 29;
        this.callbacks.onMeasure?.({ distance: Math.hypot(a.x - b.x, a.z - b.z) });
      }
      this.dirty = true;
      return;
    }
    const hit = this.raycaster.intersectObjects(this.buildingMeshes, true)[0];
    this.setSelected(hit?.object.userData.id ?? null);
    this.callbacks.onSelect?.(hit?.object.userData.id ?? null);
  }

  setMeasureEnabled(enabled) {
    this.measureEnabled = Boolean(enabled);
    this.keys.clear();
    this.measurePoints = [];
    disposeTree(this.measureGroup);
    this.callbacks.onMeasure?.({ distance: null });
    this.controls.enabled = this.mode !== 'walk' && !enabled;
    this.renderer.domElement.style.cursor = enabled ? 'crosshair' : this.mode === 'walk' ? 'grab' : '';
    this.dirty = true;
  }

  setView(mode, viewpoint) {
    if (!this.camera || !this.controls) return;
    const nextMode = ['orbit', 'top', 'walk'].includes(mode) ? mode : 'orbit';
    if (this.mode !== 'walk' && nextMode === 'walk') {
      this.orbitState = { position: this.camera.position.clone(), target: this.controls.target.clone() };
    }
    this.mode = nextMode;
    if (this.floorLabels) this.floorLabels.visible = nextMode !== 'walk';
    this.keys.clear();
    this.controls.enabled = nextMode !== 'walk' && !this.measureEnabled;
    this.controls.enableRotate = nextMode !== 'top';
    this.camera.up.set(0, 1, 0);
    this.camera.fov = nextMode === 'walk' ? 66 : 40;
    // Overview distances need more depth precision for coplanar map surfaces.
    this.camera.near = nextMode === 'walk' ? 0.15 : 3;
    this.applyOverviewOffset();
    this.camera.updateProjectionMatrix();
    if (nextMode === 'walk') {
      const positionInput = viewpoint?.position;
      const normalizedPosition = positionInput ? pointPair(positionInput) : null;
      let position = normalizedPosition && normalizedPosition.every(Number.isFinite) ? this.toWorld([normalizedPosition])[0] : this.findWalkPosition();
      if (!this.isWalkable(...position)) position = this.findWalkPosition(position);
      this.camera.position.set(position[0], this.walkEyeHeight(...position), position[1]);
      const targetInput = viewpoint?.target;
      const target = targetInput ? this.toWorld([pointPair(targetInput)])[0] : [0, 0];
      const dx = (target?.[0] ?? 0) - position[0], dz = (target?.[1] ?? 0) - position[1];
      this.yaw = Math.atan2(-dx, -dz);
      this.pitch = -0.035;
      this.updateWalkLook();
      this.renderer.domElement.focus({ preventScroll: true });
    } else if (nextMode === 'top') {
      this.frameOverview(new THREE.Vector3(0, 1, 0.00001).normalize());
    } else if (this.orbitState) {
      this.frameOverview(this.orbitState.position.clone().sub(this.orbitState.target).normalize());
    } else this.placeOrbitCamera();
    this.renderer.domElement.style.cursor = this.measureEnabled ? 'crosshair' : nextMode === 'walk' ? 'grab' : '';
    this.dirty = true;
  }

  overviewInsets() {
    const width = Math.max(1, this.container?.clientWidth || 998);
    const height = Math.max(1, this.container?.clientHeight || 557);
    return { width, height, top: Math.min(35, height * 0.12), bottom: Math.min(160, height * 0.36), side: Math.min(20, width * 0.05) };
  }

  applyOverviewOffset() {
    if (this.mode === 'walk') { this.camera.clearViewOffset(); return; }
    const { width, height, top, bottom } = this.overviewInsets();
    // Shift the optical centre into the free area above the experience cards.
    const framed = this.frameOffset?.width === width && this.frameOffset?.height === height && this.frameOffset?.mode === this.mode;
    this.camera.setViewOffset(width, height, framed ? this.frameOffset.x : 0, framed ? this.frameOffset.y : (bottom - top) / 2, width, height);
  }

  overviewSupportPoints() {
    const points = [];
    // The slab corners and actual roof vertices define the visible silhouette.
    // Empty high-altitude corners of a world-space box would waste viewport area.
    for (const x of [-this.width / 2 - 6, this.width / 2 + 6]) for (const z of [-this.depth / 2 - 6, this.depth / 2 + 6]) {
      points.push(new THREE.Vector3(x, -3.1, z), new THREE.Vector3(x, -0.1, z));
    }
    this.buildingPolygons.forEach((polygon, index) => {
      const height = this.buildingMeshes[index]?.userData.height ?? 0;
      polygon.forEach(([x, z]) => points.push(new THREE.Vector3(x, height + 0.2, z)));
    });
    return points;
  }

  frameOverview(direction) {
    const { width, height, top, bottom, side } = this.overviewInsets();
    this.applyOverviewOffset();
    const points = this.overviewSupportPoints();
    const target = new THREE.Vector3(0, Math.max(0, ...this.buildingMeshes.map((mesh) => mesh.userData.height)) * 0.3, 0);
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), direction).normalize();
    const up = new THREE.Vector3().crossVectors(direction, right).normalize();
    const verticalTangent = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const tangentX = verticalTangent * width / height * Math.max(0.1, (width - 2 * side) / width);
    const tangentY = verticalTangent * Math.max(0.1, (height - top - bottom) / height);
    const projected = points.map((point) => {
      const relative = point.clone().sub(target);
      return { x: relative.dot(right), y: relative.dot(up), z: relative.dot(direction) };
    });
    const rangeAt = (distance) => {
      const range = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
      projected.forEach((point) => {
        const depth = Math.max(0.001, distance - point.z);
        const x = point.x / depth, y = point.y / depth;
        range.minX = Math.min(range.minX, x); range.maxX = Math.max(range.maxX, x);
        range.minY = Math.min(range.minY, y); range.maxY = Math.max(range.maxY, y);
      });
      return range;
    };
    const fits = (distance) => {
      const range = rangeAt(distance);
      return range.maxX - range.minX <= tangentX * 2 && range.maxY - range.minY <= tangentY * 2;
    };
    let near = Math.max(1, ...projected.map((point) => point.z + 1));
    let far = Math.max(near * 2, this.width, this.depth);
    while (!fits(far)) far *= 1.5;
    for (let i = 0; i < 42; i++) {
      const middle = (near + far) / 2;
      if (fits(middle)) far = middle; else near = middle;
    }
    const distance = far * 1.025;
    const range = rangeAt(distance);
    // Centre the real perspective silhouette, which is asymmetric around the aim point.
    const centreX = (range.minX + range.maxX) / (2 * verticalTangent * width / height);
    const centreY = (range.minY + range.maxY) / (2 * verticalTangent);
    this.frameOffset = { width, height, mode: this.mode, x: centreX * width / 2, y: (bottom - top) / 2 - centreY * height / 2 };
    this.applyOverviewOffset();
    this.camera.position.copy(target).addScaledVector(direction, distance);
    this.controls.target.copy(target);
    this.camera.lookAt(target);
    this.controls.update();
  }

  placeOrbitCamera() {
    this.frameOverview(new THREE.Vector3(0.64, 0.60, 0.84).normalize());
  }

  resetView() {
    if (!this.camera || !this.controls) return;
    this.orbitState = null;
    this.keys.clear();
    this.setView('orbit');
  }

  isWalkable(x, z) {
    return this.isFree(x, z, 0.75);
  }

  walkEyeHeight(x, z) {
    // Maintain a 1.70 m eye height above each walkable surface.
    if (this.isOnRoad(x, z)) return 1.875;
    if (this.isOnRoad(x, z, 2)) return 1.81;
    if (this.buildingHoles.some((holes) => holes.some((hole) => pointInPolygon(x, z, hole)))) return 1.775;
    return this.parkPolygons.some((polygon) => pointInPolygon(x, z, polygon)) ? 1.76 : 1.71;
  }

  findWalkPosition(preferred = [0, this.depth * 0.29]) {
    if (this.isWalkable(...preferred)) return preferred;
    const candidates = [];
    this.roadPaths.forEach(({ points }) => {
      for (let i = 0; i < points.length - 1; i++) {
        const a = points[i], b = points[i + 1];
        for (let t = 0.1; t <= 0.9; t += 0.2) candidates.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    });
    candidates.sort((a, b) => Math.hypot(a[0] - preferred[0], a[1] - preferred[1]) - Math.hypot(b[0] - preferred[0], b[1] - preferred[1]));
    for (const point of candidates) if (this.isWalkable(...point)) return point;
    for (let z = this.depth * 0.45; z > -this.depth * 0.45; z -= this.depth / 30) for (let x = -this.width * 0.45; x < this.width * 0.45; x += this.width / 30) {
      if (this.isWalkable(x, z)) return [x, z];
    }
    return [0, this.depth / 2 - 1];
  }

  updateWalkLook() {
    this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
    this.dirty = true;
  }

  translateWalk(forward, right, distance) {
    if (this.mode !== 'walk') return;
    const magnitude = Math.hypot(forward, right) || 1;
    const dx = (-Math.sin(this.yaw) * forward + Math.cos(this.yaw) * right) / magnitude * distance;
    const dz = (-Math.cos(this.yaw) * forward - Math.sin(this.yaw) * right) / magnitude * distance;
    // Short substeps prevent stepping through thin building edges or a river bank.
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / 0.45));
    for (let step = 0; step < steps; step++) {
      const x = this.camera.position.x, z = this.camera.position.z;
      const nx = x + dx / steps, nz = z + dz / steps;
      if (this.isWalkable(nx, nz)) this.camera.position.set(nx, this.walkEyeHeight(nx, nz), nz);
      else if (this.isWalkable(nx, z)) this.camera.position.x = nx;
      else if (this.isWalkable(x, nz)) this.camera.position.z = nz;
    }
    this.camera.position.y = this.walkEyeHeight(this.camera.position.x, this.camera.position.z);
    this.dirty = true;
  }

  moveWalk(direction) {
    const vectors = { forward: [1, 0], backward: [-1, 0], back: [-1, 0], left: [0, -1], right: [0, 1], up: [1, 0], down: [-1, 0] };
    const vector = vectors[direction];
    if (vector) this.translateWalk(...vector, 3.5);
  }

  resize() {
    if (!this.renderer || !this.camera || this.disposed) return;
    const width = Math.max(1, this.container.clientWidth), height = Math.max(1, this.container.clientHeight);
    this.camera.aspect = width / height;
    this.camera.near = this.mode === 'walk' ? 0.15 : 3;
    this.applyOverviewOffset();
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    if (this.modelLoaded && this.mode !== 'walk') {
      const direction = this.mode === 'top' ? new THREE.Vector3(0, 1, 0.00001).normalize() : this.camera.position.clone().sub(this.controls.target).normalize();
      this.frameOverview(direction);
      this.orbitState = null;
    }
    this.dirty = true;
  }

  animate(now) {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.animate);
    const dt = Math.min((now - this.lastFrame) / 1000, 0.05);
    this.lastFrame = now;
    if (document.hidden || this.contextLost) return;
    if (this.mode === 'walk') {
      const has = (...codes) => codes.some((code) => this.keys.has(code));
      const forward = Number(has('KeyW', 'ArrowUp')) - Number(has('KeyS', 'ArrowDown'));
      const right = Number(has('KeyD', 'ArrowRight')) - Number(has('KeyA', 'ArrowLeft'));
      if (forward || right) this.translateWalk(forward, right, dt * (has('ShiftLeft', 'ShiftRight') ? 16 : 8));
    } else if (this.controls.enabled) this.controls.update();
    if (this.dirty) {
      try { this.renderer.render(this.scene, this.camera); this.dirty = false; }
      catch (error) { this.reportError(error); this.dirty = false; }
    }
  }

  async exportGLB() {
    if (!this.city || !this.modelLoaded) throw new Error('请先载入城市模型。');
    const selected = this.selectedId;
    this.setSelected(null);
    try {
      this.city.updateMatrixWorld(true);
      const result = await new GLTFExporter().parseAsync(this.city, { binary: true, onlyVisible: true, trs: false });
      if (!(result instanceof ArrayBuffer)) throw new Error('模型导出未返回有效文件。');
      return result;
    } catch (error) { this.reportError(error); throw error; }
    finally { this.setSelected(selected); }
  }

  capture() {
    if (!this.renderer) throw new Error('三维视图尚未准备好。');
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver?.disconnect();
    this.listeners.forEach((remove) => remove());
    this.keys.clear();
    this.controls?.dispose();
    if (this.scene) disposeTree(this.scene);
    this.sun?.shadow?.map?.dispose();
    this.renderer?.dispose();
    this.renderer?.domElement.remove();
  }
}

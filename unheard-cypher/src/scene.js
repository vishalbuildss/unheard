import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { hueOf, clamp } from './config.js';

/*
  The underpass. A round concrete floor, a painted wall, hanging bulbs, a podium in the middle.
  Everyone who joins stands in the ring as a figure. The rapper walks to the podium.
  Floor lights count down the 60 seconds, a ring of dots fills as votes arrive, and the bars
  around the podium move with the real voice (or the beat when nobody is speaking).
*/
const TAPE = 0xf3c300, LIVE = 0xff3b57, OK = 0x4fd08a, CHALK = 0xece8dd, NIGHT = 0x0b0e11, TUNGSTEN = 0xffc27a;
const PHASE_COLOR = { idle: TAPE, ready: CHALK, perform: LIVE, vote: TAPE, result: OK };
const RING_A = { r: 8.2, n: 26, off: 0.12 }, RING_B = { r: 10.9, n: 22, off: 0.34 };
const SLOTS = RING_A.n + RING_B.n;
const TILES = 60, DOTS = 32, EQ = 64;
const DIST = { idle: 17, ready: 12, perform: 9.2, vote: 10.5, result: 9.6 };
const lerp = (a, b, t) => a + (b - a) * t;
const damp = (lambda, dt) => 1 - Math.exp(-lambda * dt);

function noiseCanvas(size, base, speck, blotch) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = base; g.fillRect(0, 0, size, size);
  for (let i = 0; i < 26; i++) {
    const x = Math.random() * size, y = Math.random() * size, r = 40 + Math.random() * 140;
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    const a = (Math.random() * 0.1).toFixed(3);
    gr.addColorStop(0, (Math.random() > 0.5 ? 'rgba(255,255,255,' : 'rgba(0,0,0,') + a + ')'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  for (let i = 0; i < size * size / 14; i++) {
    g.fillStyle = Math.random() > 0.5 ? speck : blotch;
    g.globalAlpha = Math.random() * 0.35;
    g.fillRect(Math.random() * size, Math.random() * size, 1 + Math.random() * 2, 1 + Math.random() * 2);
  }
  g.globalAlpha = 1;
  return c;
}

export function createScene(container, { serverNow, reduced, quality: startQuality }) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  } catch (_) { return null; }
  if (!renderer.getContext()) return null;

  let quality = startQuality === 'low' ? 'low' : 'high';
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(NIGHT);
  scene.fog = new THREE.FogExp2(NIGHT, 0.017);
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 140);
  camera.position.set(0, 6.5, 16);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1.7, 0);
  controls.enablePan = false;
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.minDistance = 4.5;
  controls.maxDistance = 26;
  controls.minPolarAngle = 0.35;
  controls.maxPolarAngle = 1.5;
  controls.rotateSpeed = 0.6;
  controls.autoRotate = !reduced;
  controls.autoRotateSpeed = 0.5;
  let lastTouch = -1e9;
  controls.addEventListener('start', () => { lastTouch = performance.now(); });
  controls.addEventListener('change', () => { if (controls.__dragging) lastTouch = performance.now(); });
  renderer.domElement.addEventListener('pointerdown', () => { controls.__dragging = true; lastTouch = performance.now(); });
  window.addEventListener('pointerup', () => { controls.__dragging = false; lastTouch = performance.now(); });
  renderer.domElement.addEventListener('wheel', () => { lastTouch = performance.now(); }, { passive: true });

  /* ---------- post processing ---------- */
  let composer = null, bloom = null;
  function buildComposer(w, h) {
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.62, 0.55, 0.8);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
  }

  /* ---------- textures ---------- */
  const concrete = new THREE.CanvasTexture(noiseCanvas(512, '#4b5359', '#8d969c', '#20262a'));
  concrete.wrapS = concrete.wrapT = THREE.RepeatWrapping; concrete.colorSpace = THREE.SRGBColorSpace;
  concrete.anisotropy = 4;
  const floorTex = concrete.clone(); floorTex.repeat.set(9, 9); floorTex.needsUpdate = true;

  const wallCanvas = document.createElement('canvas'); wallCanvas.width = 4096; wallCanvas.height = 512;
  const wallTex = new THREE.CanvasTexture(wallCanvas);
  wallTex.colorSpace = THREE.SRGBColorSpace; wallTex.wrapS = THREE.RepeatWrapping; wallTex.anisotropy = 4;
  wallTex.repeat.x = -1; wallTex.offset.x = 1; // the wall is seen from inside, so flip it to read the right way round
  function paintWall() {
    const g = wallCanvas.getContext('2d'), W = wallCanvas.width, H = wallCanvas.height;
    g.drawImage(noiseCanvas(512, '#3f464c', '#8d969c', '#1c2226'), 0, 0, W, H);
    g.fillStyle = 'rgba(0,0,0,0.28)';
    for (let x = 0; x < W; x += 512) g.fillRect(x, 0, 3, H);
    g.fillStyle = 'rgba(0,0,0,0.22)'; g.fillRect(0, H - 40, W, 40);
    const word = (txt, x, y, size, color, rot, alpha) => {
      g.save(); g.translate(x, y); g.rotate(rot); g.globalAlpha = alpha;
      g.font = '800 ' + size + 'px Stencil, Impact, sans-serif'; g.fillStyle = color; g.textBaseline = 'alphabetic';
      g.fillText(txt, 0, 0);
      const w = g.measureText(txt).width;
      g.globalAlpha = alpha * 0.8;
      for (let i = 0; i < 9; i++) { // paint drips
        const dx = Math.random() * w, len = 20 + Math.random() * 110;
        const grad = g.createLinearGradient(0, 0, 0, len);
        grad.addColorStop(0, color); grad.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = grad; g.fillRect(dx, 4, 3 + Math.random() * 3, len);
      }
      g.restore();
    };
    word('UNHEARD', 70, 330, 300, '#f3c300', -0.02, 0.92);
    word('ONE MIC', 1160, 300, 230, '#ece8dd', 0.015, 0.85);
    word('60 SECONDS', 2030, 340, 270, '#ff3b57', -0.01, 0.82);
    word('SPIT', 3060, 310, 290, '#ece8dd', 0.02, 0.8);
    word('NO SIGNUP', 3560, 150, 110, '#f3c300', -0.03, 0.7);
    g.globalAlpha = 0.7; g.strokeStyle = '#ece8dd'; g.lineWidth = 7; g.setLineDash([26, 18]);
    for (let i = 0; i < 6; i++) { g.beginPath(); g.moveTo(i * 700, 440); g.lineTo(i * 700 + 420, 436 + (i % 2) * 8); g.stroke(); }
    g.setLineDash([]); g.globalAlpha = 1;
    wallTex.needsUpdate = true;
  }
  paintWall();

  function softDot() {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  }

  /* ---------- the room ---------- */
  const floor = new THREE.Mesh(new THREE.CircleGeometry(42, 72), new THREE.MeshStandardMaterial({ map: floorTex, color: 0xc4ccd2, roughness: 0.82, metalness: 0.05 }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);

  const wallMat = new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.95, side: THREE.BackSide, emissive: 0xffffff, emissiveMap: wallTex, emissiveIntensity: 0.35 });
  const wall = new THREE.Mesh(new THREE.CylinderGeometry(21, 21, 15, 96, 1, true), wallMat);
  wall.position.y = 7.5; scene.add(wall);

  function ringMesh(inner, outer, color, opacity) {
    const m = new THREE.Mesh(new THREE.RingGeometry(inner, outer, 96), new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
    m.rotation.x = -Math.PI / 2; m.position.y = 0.012; scene.add(m); return m;
  }
  ringMesh(5.85, 5.95, CHALK, 0.55);
  ringMesh(7.05, 7.12, CHALK, 0.25);
  ringMesh(3.55, 3.6, CHALK, 0.25);

  const podium = new THREE.Mesh(new THREE.CylinderGeometry(1.45, 1.6, 0.4, 56), new THREE.MeshStandardMaterial({ map: concrete, color: 0xb9c0c5, roughness: 0.7 }));
  podium.position.y = 0.2; podium.castShadow = podium.receiveShadow = true; scene.add(podium);
  const podiumRimMat = new THREE.MeshBasicMaterial({ color: TAPE });
  const podiumRim = new THREE.Mesh(new THREE.TorusGeometry(1.46, 0.035, 8, 72), podiumRimMat);
  podiumRim.rotation.x = Math.PI / 2; podiumRim.position.y = 0.4; scene.add(podiumRim);

  /* mic on a stand, always between the rapper and the camera */
  const mic = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({ color: 0x20262b, roughness: 0.35, metalness: 0.85 });
  const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 1.45, 8), metal); stand.position.y = 0.72;
  const micHead = new THREE.Mesh(new THREE.SphereGeometry(0.075, 14, 10), metal); micHead.position.y = 1.5;
  const micBase = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.18, 0.025, 20), metal); micBase.position.y = 0.012;
  mic.add(stand, micHead, micBase); scene.add(mic);

  /* hanging bulbs */
  const bulbs = [];
  const bulbMat = new THREE.MeshBasicMaterial({ color: TUNGSTEN });
  const cableMat = new THREE.MeshBasicMaterial({ color: 0x0c0f11 });
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.3, x = Math.cos(a) * 13.5, z = Math.sin(a) * 13.5, y = 10.2 + (i % 2) * 0.8;
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.28, 14, 10), bulbMat); bulb.position.set(x, y, z);
    const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 15 - y, 6), cableMat); cable.position.set(x, y + (15 - y) / 2, z);
    const light = new THREE.PointLight(TUNGSTEN, 120, 30, 2); light.position.set(x, y - 0.2, z);
    scene.add(bulb, cable, light); bulbs.push({ light, base: 120, i });
  }
  scene.add(new THREE.HemisphereLight(0x5d7083, 0x1a2024, 1.0));

  /* the spotlight over the podium and its beam */
  const spot = new THREE.SpotLight(0xffe6bd, 520, 40, 0.34, 0.65, 1.6);
  spot.position.set(0, 13, 0.01); spot.target.position.set(0, 0.6, 0);
  spot.castShadow = true; spot.shadow.mapSize.set(1024, 1024); spot.shadow.bias = -0.0004; spot.shadow.camera.near = 6; spot.shadow.camera.far = 22;
  scene.add(spot, spot.target);
  const coneMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { uColor: { value: new THREE.Color(0xffe6bd) }, uAmt: { value: 0.16 } },
    vertexShader: 'varying vec3 vN; varying vec3 vV; varying float vY; void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); vY = clamp(position.y / 12.0 + 0.5, 0.0, 1.0); gl_Position = projectionMatrix * mv; }',
    fragmentShader: 'uniform vec3 uColor; uniform float uAmt; varying vec3 vN; varying vec3 vV; varying float vY; void main(){ float f = pow(abs(dot(normalize(vN), normalize(vV))), 1.7); gl_FragColor = vec4(uColor, f * uAmt * (0.2 + 0.8 * vY)); }'
  });
  const cone = new THREE.Mesh(new THREE.ConeGeometry(3.7, 12.6, 40, 1, true), coneMat);
  cone.position.set(0, 6.5, 0); scene.add(cone);

  /* dust drifting in the light */
  const DUST = 420;
  const dustPos = new Float32Array(DUST * 3), dustSeed = new Float32Array(DUST);
  for (let i = 0; i < DUST; i++) {
    const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * 9;
    dustPos.set([Math.cos(a) * r, Math.random() * 11, Math.sin(a) * r], i * 3); dustSeed[i] = Math.random() * 10;
  }
  const dustGeo = new THREE.BufferGeometry(); dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
  const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({ size: 0.07, map: softDot(), transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending, color: 0xffe9c8 }));
  scene.add(dust);

  /* ---------- instrument rings ---------- */
  const dummy = new THREE.Object3D(), tmpC = new THREE.Color();
  const tiles = new THREE.InstancedMesh(new THREE.BoxGeometry(0.2, 0.05, 0.6), new THREE.MeshBasicMaterial(), TILES);
  for (let i = 0; i < TILES; i++) {
    const a = (i / TILES) * Math.PI * 2;
    dummy.position.set(Math.sin(a) * 4.5, 0.03, Math.cos(a) * 4.5); dummy.rotation.set(0, a, 0); dummy.updateMatrix();
    tiles.setMatrixAt(i, dummy.matrix); tiles.setColorAt(i, tmpC.set(0x1f2428));
  }
  scene.add(tiles);

  const dots = new THREE.InstancedMesh(new THREE.SphereGeometry(0.13, 12, 8), new THREE.MeshBasicMaterial(), DOTS);
  for (let i = 0; i < DOTS; i++) {
    const a = (i / DOTS) * Math.PI * 2 + 0.05;
    dummy.position.set(Math.sin(a) * 5.35, 0.16, Math.cos(a) * 5.35); dummy.rotation.set(0, 0, 0); dummy.scale.setScalar(1); dummy.updateMatrix();
    dots.setMatrixAt(i, dummy.matrix); dots.setColorAt(i, tmpC.set(0x1f2428));
  }
  scene.add(dots);

  const eqMat = new THREE.MeshBasicMaterial({ color: LIVE });
  const eq = new THREE.InstancedMesh(new THREE.BoxGeometry(0.085, 1, 0.085), eqMat, EQ);
  eq.frustumCulled = false; scene.add(eq);
  const eqH = new Float32Array(EQ).fill(0.05);
  const bandBuf = new Float32Array(32);

  /* ---------- figures ---------- */
  const G = {
    body: new THREE.CapsuleGeometry(0.3, 0.6, 4, 12), head: new THREE.SphereGeometry(0.235, 18, 14),
    cap: new THREE.SphereGeometry(0.255, 18, 8, 0, Math.PI * 2, 0, Math.PI / 2), brim: new THREE.BoxGeometry(0.34, 0.03, 0.22),
    leg: new THREE.CapsuleGeometry(0.1, 0.46, 3, 8), arm: new THREE.CapsuleGeometry(0.075, 0.42, 3, 8), marker: new THREE.ConeGeometry(0.11, 0.2, 4)
  };
  const SKINS = [0xe0b48f, 0xc68e63, 0x9a6a46, 0x6f4a31, 0xf0c9a5];
  const matCache = new Map();
  const mat = (color, rough) => { const k = color + ':' + rough; if (!matCache.has(k)) matCache.set(k, new THREE.MeshStandardMaterial({ color, roughness: rough })); return matCache.get(k); };
  const labelCache = new Map();
  function labelTexture(text, color) {
    const k = text + '|' + color;
    if (labelCache.has(k)) return labelCache.get(k);
    const c = document.createElement('canvas'); c.width = 384; c.height = 80;
    const g = c.getContext('2d');
    g.font = '700 38px Barlow, system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    const w = Math.min(372, g.measureText(text).width + 36);
    g.fillStyle = 'rgba(11,14,17,0.72)'; g.fillRect(192 - w / 2, 8, w, 64);
    g.fillStyle = color; g.fillText(text, 192, 42, 340);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    if (labelCache.size > 150) { const first = labelCache.keys().next().value; labelCache.get(first).dispose(); labelCache.delete(first); }
    labelCache.set(k, t); return t;
  }

  function makeFigure(id, name, watcher) {
    const hue = watcher ? 210 : hueOf(name);
    const hood = new THREE.Color().setHSL(hue / 360, watcher ? 0.08 : 0.5, watcher ? 0.2 : 0.34).getHex();
    const dark = new THREE.Color().setHSL(hue / 360, 0.25, 0.12).getHex();
    const skin = SKINS[hueOf(id + name) % SKINS.length];
    const grp = new THREE.Group();
    const add = (geo, m, x, y, z, parent = grp) => { const me = new THREE.Mesh(geo, m); me.position.set(x, y, z); me.castShadow = true; parent.add(me); return me; };
    const body = add(G.body, mat(hood, 0.85), 0, 0.98, 0);
    const head = add(G.head, mat(skin, 0.7), 0, 1.66, 0);
    const cap = add(G.cap, mat(dark, 0.8), 0, 1.7, 0);
    add(G.brim, mat(dark, 0.8), 0, 1.7, 0.2);
    add(G.leg, mat(0x20262b, 0.9), -0.13, 0.36, 0); add(G.leg, mat(0x20262b, 0.9), 0.13, 0.36, 0);
    const mkArm = side => {
      const piv = new THREE.Group(); piv.position.set(side * 0.37, 1.34, 0); grp.add(piv);
      add(G.arm, mat(hood, 0.85), 0, -0.26, 0, piv); return piv;
    };
    const armL = mkArm(-1), armR = mkArm(1);
    const marker = new THREE.Mesh(G.marker, new THREE.MeshBasicMaterial({ color: TAPE })); marker.rotation.x = Math.PI; marker.position.y = 2.28; marker.visible = false; grp.add(marker);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false, fog: false }));
    sprite.scale.set(1.9, 0.4, 1); sprite.position.y = 2.0; grp.add(sprite);
    scene.add(grp);
    return { id, name, watcher, grp, body, head, cap, armL, armR, marker, sprite, labelKey: '', phase: Math.random() * 6.28, hop: 0, spawn: 0, leaving: false, slot: -1,
      pos: new THREE.Vector3(), tgt: new THREE.Vector3(), yaw: 0 };
  }

  const figures = new Map();
  const slots = new Array(SLOTS).fill(null);
  let roster = [], watching = 0, myId = null, st = { phase: 'idle', cur: null, queue: [], votesIn: 0, phaseStart: 0, phaseEnd: 0, round: 0 };
  const hash = s => { let h = 5; for (const c of String(s)) h = (h * 33 + c.charCodeAt(0)) >>> 0; return h; };
  function slotPos(i, out) {
    const ring = i < RING_A.n ? RING_A : RING_B, k = i < RING_A.n ? i : i - RING_A.n;
    const a = (k / ring.n) * Math.PI * 2 + ring.off;
    return out.set(Math.sin(a) * ring.r, 0, Math.cos(a) * ring.r);
  }
  function takeSlot(id) {
    const start = hash(id) % SLOTS;
    for (let k = 0; k < SLOTS; k++) { const i = (start + k) % SLOTS; if (!slots[i]) { slots[i] = id; return i; } }
    return -1;
  }
  const cap = () => (quality === 'high' ? SLOTS : 28);

  function syncFigures() {
    const want = [];
    const seen = new Set();
    const push = (id, name, watcher) => { if (!seen.has(id)) { seen.add(id); want.push({ id, name, watcher }); } };
    const nameOf = id => (roster.find(u => u.id === id) || {}).name;
    if (st.cur) push(st.cur.id, st.cur.name, false);
    for (const q of st.queue) push(q.id, q.name, false);
    if (myId && nameOf(myId)) push(myId, nameOf(myId), false);
    for (const u of roster) push(u.id, u.name, false);
    const namedCount = want.length;
    const room = Math.max(0, Math.min(watching, 14, cap() - namedCount));
    for (let i = 0; i < room; i++) push('w' + i, 'Watching', true);
    const keep = new Set(want.slice(0, cap()).map(w => w.id));
    for (const [id, f] of figures) {
      if (!keep.has(id) && !f.leaving) { f.leaving = true; if (f.slot >= 0) { slots[f.slot] = null; f.slot = -1; } }
    }
    for (const w of want.slice(0, cap())) {
      let f = figures.get(w.id);
      if (!f) { f = makeFigure(w.id, w.name, w.watcher); figures.set(w.id, f); }
      if (f.leaving) { f.leaving = false; }
      if (f.slot < 0) {
        f.slot = takeSlot(w.id);
        if (f.slot >= 0 && f.spawn === 0) slotPos(f.slot, f.pos);
      }
    }
  }

  const nowSec = () => serverNow() / 1000;
  const tmpV = new THREE.Vector3(), tmpV2 = new THREE.Vector3();
  let beatPulse = 0, level = 0, audioBands = null, beatPhaseFn = () => -1;

  function updateFigures(dt, t) {
    const cur = st.cur ? st.cur.id : null;
    const onStage = cur && st.phase !== 'idle';
    for (const [id, f] of figures) {
      const isRapper = onStage && id === cur;
      if (isRapper) tmpV.set(0, 0.4, 0);
      else if (f.slot >= 0) slotPos(f.slot, tmpV);
      else tmpV.copy(f.pos);
      f.tgt.copy(tmpV);
      f.pos.lerp(f.tgt, reduced ? 1 : damp(isRapper ? 1.8 : 2.2, dt));
      f.spawn = f.leaving ? Math.max(0, f.spawn - dt * 3) : Math.min(1, f.spawn + dt * 2.4);
      if (f.leaving && f.spawn <= 0) { scene.remove(f.grp); f.grp.traverse(o => { if (o.isSprite) o.material.dispose(); }); figures.delete(id); continue; }
      const s = f.spawn < 1 ? 1 + Math.sin(f.spawn * Math.PI) * 0.18 - (1 - f.spawn) * 0.2 : 1;
      f.grp.scale.setScalar(Math.max(0.001, f.spawn * s));
      const bob = beatPulse * (isRapper ? 0.1 : 0.05) + (isRapper ? level * 0.06 : 0);
      f.grp.position.set(f.pos.x, f.pos.y + (f.spawn < 1 ? 0 : bob) + (isRapper ? 0 : Math.max(0, Math.sin(t * 2 + f.phase)) * 0.015), f.pos.z);
      let yaw;
      if (isRapper) yaw = Math.atan2(camera.position.x - f.pos.x, camera.position.z - f.pos.z);
      else yaw = Math.atan2(-f.pos.x, -f.pos.z);
      f.yaw += Math.atan2(Math.sin(yaw - f.yaw), Math.cos(yaw - f.yaw)) * damp(5, dt);
      f.grp.rotation.y = f.yaw;
      f.head.rotation.x = Math.sin(t * 6 + f.phase) * 0.05 * beatPulse + (isRapper ? Math.sin(t * 9) * 0.06 * level : 0);
      if (isRapper) {
        f.armR.rotation.set(-2.15 + level * 0.1, 0, -0.25);
        f.armL.rotation.set(-0.7 + Math.sin(t * 5.2) * (0.25 + level * 0.9), 0, 0.35 + beatPulse * 0.35);
      } else if (st.phase === 'vote' && !f.watcher) {
        const up = Math.sin(t * 3 + f.phase * 3) > 0.2;
        f.armL.rotation.set(up ? -2.6 : -0.1, 0, 0.2); f.armR.rotation.set(up ? -2.6 : -0.1, 0, -0.2);
      } else {
        const nod = beatPulse * (st.phase === 'perform' ? 0.5 : 0.1);
        f.armL.rotation.set(-nod, 0, 0.12 + Math.sin(t + f.phase) * 0.04); f.armR.rotation.set(-nod * 0.8, 0, -0.12 - Math.sin(t + f.phase) * 0.04);
      }
      f.marker.visible = id === myId;
      if (f.marker.visible) f.marker.position.y = 2.28 + Math.sin(t * 3) * 0.05;
      let text = f.name, color = '#ece8dd';
      if (f.watcher) { text = ''; }
      else if (id === myId) { text = 'YOU'; color = '#f3c300'; }
      const qi = st.queue.findIndex(q => q.id === id);
      if (qi >= 0) text = '#' + (qi + 1) + ' ' + (id === myId ? 'YOU' : f.name);
      if (f.watcher) f.sprite.visible = false;
      else {
        const key = text + color;
        if (key !== f.labelKey) { f.labelKey = key; f.sprite.material.map = labelTexture(text, color); f.sprite.material.needsUpdate = true; }
        f.sprite.visible = !isRapper;
      }
    }
  }

  /* ---------- reactions and confetti ---------- */
  const REACT = { fire: ['FIRE', '#f3c300'], bars: ['BARS', '#ece8dd'], 100: ['100', '#4fd08a'], wow: ['WOW', '#ff3b57'] };
  const reactTex = {};
  function drawReact() {
    for (const k of Object.keys(REACT)) {
      const c = reactTex[k] ? reactTex[k].image : Object.assign(document.createElement('canvas'), { width: 256, height: 128 });
      const g = c.getContext('2d'); g.clearRect(0, 0, 256, 128);
      g.font = '800 96px Stencil, Impact, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.lineWidth = 12; g.strokeStyle = 'rgba(11,14,17,0.9)'; g.strokeText(REACT[k][0], 128, 68);
      g.fillStyle = REACT[k][1]; g.fillText(REACT[k][0], 128, 68);
      if (!reactTex[k]) { reactTex[k] = new THREE.CanvasTexture(c); reactTex[k].colorSpace = THREE.SRGBColorSpace; } else reactTex[k].needsUpdate = true;
    }
  }
  drawReact();
  const floaters = [];
  function react(kind) {
    if (reduced || !reactTex[kind] || floaters.length > 36) return;
    const a = Math.random() * Math.PI * 2, r = 5.5 + Math.random() * 5;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: reactTex[kind], transparent: true, depthWrite: false, fog: false }));
    sp.scale.set(1.5, 0.75, 1); sp.position.set(Math.sin(a) * r, 1.6, Math.cos(a) * r);
    scene.add(sp);
    floaters.push({ sp, age: 0, life: 2.6 + Math.random() * 0.6, x0: sp.position.x, z0: sp.position.z, w: Math.random() * 6 });
  }
  function updateFloaters(dt) {
    for (let i = floaters.length - 1; i >= 0; i--) {
      const f = floaters[i]; f.age += dt;
      const p = f.age / f.life;
      if (p >= 1) { scene.remove(f.sp); f.sp.material.dispose(); floaters.splice(i, 1); continue; }
      f.sp.position.set(lerp(f.x0, f.x0 * 0.45, p) + Math.sin(f.age * 4 + f.w) * 0.2, 1.6 + p * 3.2, lerp(f.z0, f.z0 * 0.35, p));
      f.sp.material.opacity = p < 0.12 ? p / 0.12 : p > 0.65 ? (1 - p) / 0.35 : 1;
      const s = 0.8 + Math.min(1, p * 5) * 0.7; f.sp.scale.set(1.5 * s, 0.75 * s, 1);
    }
  }
  const CONF = 240;
  const confPos = new Float32Array(CONF * 3), confVel = new Float32Array(CONF * 3), confCol = new Float32Array(CONF * 3);
  const confGeo = new THREE.BufferGeometry();
  confGeo.setAttribute('position', new THREE.BufferAttribute(confPos, 3)); confGeo.setAttribute('color', new THREE.BufferAttribute(confCol, 3));
  const confetti = new THREE.Points(confGeo, new THREE.PointsMaterial({ size: 0.16, vertexColors: true, transparent: true, depthWrite: false, fog: false }));
  confetti.frustumCulled = false; confetti.visible = false; scene.add(confetti);
  let confLife = 0;
  function burst() {
    if (reduced) return;
    const cols = [TAPE, CHALK, LIVE, OK].map(c => new THREE.Color(c));
    for (let i = 0; i < CONF; i++) {
      const a = Math.random() * Math.PI * 2, sp = 2 + Math.random() * 6;
      confPos.set([0, 2.2, 0], i * 3);
      confVel.set([Math.cos(a) * sp, 5 + Math.random() * 7, Math.sin(a) * sp], i * 3);
      const c = cols[i % 4]; confCol.set([c.r, c.g, c.b], i * 3);
    }
    confGeo.attributes.color.needsUpdate = true;
    confLife = 3.2; confetti.visible = true;
  }
  function updateConfetti(dt) {
    if (confLife <= 0) return;
    confLife -= dt;
    for (let i = 0; i < CONF; i++) {
      confVel[i * 3 + 1] -= 14 * dt;
      confVel[i * 3] *= 0.992; confVel[i * 3 + 2] *= 0.992;
      for (let k = 0; k < 3; k++) confPos[i * 3 + k] += confVel[i * 3 + k] * dt;
      if (confPos[i * 3 + 1] < 0.05) { confPos[i * 3 + 1] = 0.05; confVel[i * 3 + 1] = 0; confVel[i * 3] *= 0.8; confVel[i * 3 + 2] *= 0.8; }
    }
    confGeo.attributes.position.needsUpdate = true;
    confetti.material.opacity = clamp(confLife, 0, 1);
    if (confLife <= 0) confetti.visible = false;
  }

  /* ---------- per frame ---------- */
  const clock = new THREE.Clock();
  let flash = 0, curColor = new THREE.Color(TAPE), spotCol = new THREE.Color(0xffe6bd);
  const SPOT = { idle: 0xffe6bd, ready: 0xfff3dc, perform: 0xff8f9d, vote: 0xffe08a, result: 0xa5f0c6 };
  let frames = 0, slowAcc = 0, slowCb = null, autoChecked = false;

  function frame() {
    const dt = Math.min(0.1, clock.getDelta()), t = clock.elapsedTime;
    const ph = st.phase, now = serverNow();
    const bp = beatPhaseFn();
    beatPulse = bp >= 0 ? Math.exp(-bp * 5) : 0;
    audioBands = audioBandsFn ? audioBandsFn(32) : null;
    let lv = 0; if (audioBands) { for (let i = 0; i < 32; i++) lv += audioBands[i]; lv /= 32; }
    level = lerp(level, Math.min(1, lv * 1.8), 0.25);

    /* phase colour */
    curColor.lerp(tmpC.set(PHASE_COLOR[ph] || TAPE), damp(6, dt));
    podiumRimMat.color.copy(curColor); eqMat.color.copy(curColor);
    spotCol.lerp(tmpC.set(SPOT[ph] || SPOT.idle), damp(3, dt));
    spot.color.copy(spotCol); coneMat.uniforms.uColor.value.copy(spotCol);
    flash = Math.max(0, flash - dt * 1.6);
    spot.intensity = (ph === 'idle' ? 360 : 560) * (1 + beatPulse * 0.18 + flash * 0.9);
    coneMat.uniforms.uAmt.value = (ph === 'idle' ? 0.1 : 0.17) + beatPulse * 0.04 + flash * 0.1;
    bulbs.forEach(b => { b.light.intensity = b.base * (b.i === 2 ? (Math.sin(t * 17) > 0.96 ? 0.6 : 1) : 1) * (1 + beatPulse * 0.1); });

    /* countdown tiles */
    let frac = 0;
    if (ph === 'perform' || ph === 'vote') frac = clamp(1 - (now - st.phaseStart) / Math.max(1, st.phaseEnd - st.phaseStart), 0, 1);
    else if (ph === 'ready') frac = 1;
    const lit = Math.ceil(frac * TILES), blink = ph === 'ready' && Math.floor(t * 4) % 2 === 0;
    for (let i = 0; i < TILES; i++) {
      const on = i < lit && !(ph === 'ready' && !blink);
      tiles.setColorAt(i, on ? tmpC.copy(curColor) : tmpC.set(0x1c2125));
    }
    tiles.instanceColor.needsUpdate = true;
    /* vote dots */
    const votes = ph === 'vote' || ph === 'result' ? Math.min(DOTS, st.votesIn) : 0;
    for (let i = 0; i < DOTS; i++) dots.setColorAt(i, i < votes ? tmpC.set(TAPE) : tmpC.set(0x1c2125));
    dots.instanceColor.needsUpdate = true;

    /* equaliser */
    const show = ph === 'perform' || ph === 'ready' || ph === 'vote';
    for (let i = 0; i < EQ; i++) {
      const bi = i < 32 ? i : 63 - i;
      let target = 0.05;
      if (audioBands) target = 0.06 + audioBands[bi] * 1.05;
      else if (show && !reduced) target = 0.06 + 0.1 * Math.abs(Math.sin(t * 1.4 + i * 0.4));
      eqH[i] = lerp(eqH[i], target, target > eqH[i] ? 0.5 : 0.18);
      const a = (i / EQ) * Math.PI * 2;
      dummy.position.set(Math.sin(a) * 2.7, 0.4 + eqH[i] / 2, Math.cos(a) * 2.7);
      dummy.rotation.set(0, a, 0); dummy.scale.set(1, eqH[i], 1); dummy.updateMatrix(); eq.setMatrixAt(i, dummy.matrix);
    }
    eq.instanceMatrix.needsUpdate = true;
    dummy.scale.setScalar(1);

    updateFigures(dt, t);
    updateFloaters(dt); updateConfetti(dt);
    const dp = dustGeo.attributes.position.array;
    for (let i = 0; i < DUST; i++) {
      dp[i * 3 + 1] += dt * 0.12; dp[i * 3] += Math.sin(t * 0.3 + dustSeed[i]) * dt * 0.08;
      if (dp[i * 3 + 1] > 11.5) dp[i * 3 + 1] = 0;
    }
    dustGeo.attributes.position.needsUpdate = true;

    /* the mic stays between the rapper and the camera */
    tmpV2.set(camera.position.x, 0, camera.position.z).normalize();
    mic.position.set(tmpV2.x * 0.62, 0.4, tmpV2.z * 0.62);

    /* camera */
    const userActive = performance.now() - lastTouch < 5000;
    controls.autoRotate = !reduced && !userActive;
    controls.autoRotateSpeed = ph === 'perform' ? 0.3 : 0.5;
    if (!userActive && !reduced) {
      const want = DIST[ph] || 14;
      tmpV.copy(camera.position).sub(controls.target); const d = tmpV.length();
      tmpV.setLength(lerp(d, want, damp(1.1, dt)));
      camera.position.copy(controls.target).add(tmpV);
    }
    camera.fov = 55 + (reduced ? 0 : beatPulse * 0.9 + flash * 2);
    camera.updateProjectionMatrix();
    controls.update();

    if (composer && quality === 'high') composer.render(); else renderer.render(scene, camera);

    /* if the first seconds run too slowly, drop to the light version once */
    if (!autoChecked) {
      frames++; slowAcc += dt;
      if (frames > 20 && slowAcc > 0) {
        if (frames === 150 || slowAcc > 4) {
          autoChecked = true;
          if (frames / slowAcc < 24 && quality === 'high') { setQuality('low'); if (slowCb) slowCb(); }
        }
      }
    }
  }

  let audioBandsFn = null;
  function resize() {
    const w = container.clientWidth || 1, h = container.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.fov = 55; camera.updateProjectionMatrix();
    if (composer) { composer.setSize(w, h); bloom.setSize(w, h); }
  }
  function setQuality(q) {
    quality = q;
    renderer.setPixelRatio(q === 'high' ? Math.min(window.devicePixelRatio || 1, 2) : 1);
    spot.castShadow = q === 'high'; renderer.shadowMap.enabled = q === 'high';
    floor.material.needsUpdate = true; scene.traverse(o => { if (o.material) o.material.needsUpdate = true; });
    if (q === 'high' && !composer) buildComposer(container.clientWidth || 1, container.clientHeight || 1);
    resize(); syncFigures();
  }
  setQuality(quality);

  if (window.ResizeObserver) new ResizeObserver(resize).observe(container); else window.addEventListener('resize', resize);
  renderer.domElement.addEventListener('webglcontextlost', e => { e.preventDefault(); renderer.setAnimationLoop(null); });
  renderer.domElement.addEventListener('webglcontextrestored', () => { renderer.setAnimationLoop(frame); });
  if (document.fonts && document.fonts.load) {
    Promise.all([document.fonts.load('800 100px Stencil'), document.fonts.load('700 38px Barlow')]).then(() => {
      paintWall(); drawReact(); labelCache.forEach(t => t.dispose()); labelCache.clear();
      figures.forEach(f => { f.labelKey = ''; });
    }).catch(() => {});
  }
  renderer.setAnimationLoop(frame);

  return {
    setRoster(list, watchers, id) { roster = list; watching = watchers; myId = id; syncFigures(); },
    setState(s) { st = s; syncFigures(); },
    setAudio(bandsFn, beatFn) { audioBandsFn = bandsFn; beatPhaseFn = beatFn; },
    react,
    celebrate(avg) { flash = 1; if (avg != null && avg >= 8) burst(); },
    setQuality,
    quality: () => quality,
    onAutoLow(cb) { slowCb = cb; },
    webglOk: true
  };
}

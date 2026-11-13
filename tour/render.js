/* ============================================================
   RENDER — the three.js world: sky, terrain, green, water, trees, flag,
   ball, tracer, previews and particles. Holds no game rules.
   ============================================================ */
import * as THREE from 'three';
import { BALL_R, CUP_R } from './config.js';
import { paintRegion, detailCanvas, macroCanvas } from './paint.js';
import { prepareHole, surfacePPY, THEME_GRASS } from './prepare.js';
import { gradAt } from './course.js';
import { mulberry32 } from './noise.js';
import { canopyGeometry, pineGeometry, frondGeometry, rockGeometry, trunkGeometry } from './foliage.js';

/* ---------- shared shader bits ---------- */
function addDetail(mat, detailTex, strength = 0.5, edge = null){
  mat.customProgramCacheKey = () => 'detail' + strength + (edge ? 'e' : '');
  mat.onBeforeCompile = sh => {
    sh.uniforms.detailMap = { value: detailTex };
    if (edge){
      sh.uniforms.uMin = { value: new THREE.Vector2(edge.minX, edge.minZ) };
      sh.uniforms.uMax = { value: new THREE.Vector2(edge.maxX, edge.maxZ) };
      sh.uniforms.uOuter = { value: new THREE.Color(edge.color) };
      sh.uniforms.macroMap = { value: edge.macro };
    }
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nuniform sampler2D detailMap;' +
               (edge ? '\nuniform vec2 uMin; uniform vec2 uMax; uniform vec3 uOuter; uniform sampler2D macroMap;' : ''))
      .replace('#include <map_fragment>', `#include <map_fragment>
        float dd = length(vWPos - cameraPosition);
        float near = 1.0 - smoothstep(6.0, 70.0, dd);
        float d1 = texture2D(detailMap, vWPos.xz * 1.7).r;
        float d2 = texture2D(detailMap, vWPos.xz * 0.21).r;
        float dv = mix(d2, d1, near);
        diffuseColor.rgb *= mix(1.0, dv * 2.0, ${strength.toFixed(2)} * (0.35 + 0.65 * near));
        ${edge ? `
        // past the painted course the texture is only stretched edge pixels: use mottled ground instead
        float ex = max(max(uMin.x - vWPos.x, vWPos.x - uMax.x), max(uMin.y - vWPos.z, vWPos.z - uMax.y));
        float ew = smoothstep(-14.0, 1.0, ex);
        float m1 = texture2D(macroMap, vWPos.xz * 0.0061).r, m2 = texture2D(macroMap, vWPos.xz * 0.0013 + 0.37).r;
        vec3 oc = uOuter * (0.72 + 0.56 * (m1 * 0.5 + m2 * 0.5)) * mix(1.0, dv * 2.0, 0.22);
        diffuseColor.rgb = mix(diffuseColor.rgb, oc, ew);` : ''}`);
  };
}

const POINT_VS = `
  attribute float size; attribute vec4 rgba; varying vec4 vC; uniform float pr;
  void main(){ vC = rgba; vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size * pr; gl_Position = projectionMatrix * mv; }`;
const POINT_FS = `
  varying vec4 vC;
  void main(){ vec2 d = gl_PointCoord - 0.5; float r = length(d);
    float a = smoothstep(0.5, 0.36, r); if (a <= 0.0) discard;
    gl_FragColor = vec4(vC.rgb, vC.a * a); }`;

class Dots {
  constructor(max, opts = {}){
    this.max = max;
    this.geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 4);
    this.size = new Float32Array(max);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('rgba', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.ShaderMaterial({ vertexShader: POINT_VS, fragmentShader: POINT_FS, transparent: true,
      depthWrite: false, depthTest: opts.depthTest !== false, uniforms: { pr: { value: 1 } },
      blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending });
    this.obj = new THREE.Points(this.geo, this.mat);
    this.obj.frustumCulled = false;
    this.obj.renderOrder = opts.order || 5;
    this.n = 0;
    this.geo.setDrawRange(0, 0);
  }
  clear(){ this.n = 0; this.geo.setDrawRange(0, 0); }
  push(x, y, z, r, g, b, a, s){
    if (this.n >= this.max) return;
    const i = this.n++;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.col[i * 4] = r; this.col[i * 4 + 1] = g; this.col[i * 4 + 2] = b; this.col[i * 4 + 3] = a;
    this.size[i] = s;
  }
  commit(){
    this.geo.setDrawRange(0, this.n);
    for (const k of ['position', 'rgba', 'size']) this.geo.attributes[k].needsUpdate = true;
  }
}

// height on a triangulated grid laid out like the terrain mesh (last row/column clamped to the edge)
function gridHeight(g, x, z){
  const { nx, nz, step, heights } = g;
  const fx0 = Math.max(0, Math.min(nx - 1.000001, (x - g.minX) / step));
  const fz0 = Math.max(0, Math.min(nz - 1.000001, (z - g.minZ) / step));
  const c = Math.min(nx - 2, Math.floor(fx0)), r = Math.min(nz - 2, Math.floor(fz0));
  const x0 = g.minX + c * step, z0 = g.minZ + r * step;
  const fx = Math.max(0, Math.min(1, (x - x0) / Math.max(1e-6, Math.min(g.maxX, x0 + step) - x0)));
  const fz = Math.max(0, Math.min(1, (z - z0) / Math.max(1e-6, Math.min(g.maxZ, z0 + step) - z0)));
  const a = heights[r * nx + c], b = heights[r * nx + c + 1], cc = heights[(r + 1) * nx + c], d = heights[(r + 1) * nx + c + 1];
  // the quad is split along the b-c diagonal
  return fx + fz <= 1 ? a + (b - a) * fx + (cc - a) * fz : d + (cc - d) * (1 - fx) + (b - d) * (1 - fz);
}

const SHADOW_R = 70;          // yards either side of the focus
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();

/* horizon ridgelines per course: [radius, height, roughness, colours] */
const THEME_RIDGES = {
  pines: { layers: [
    { salt: 1, r: 5600, h: 760, base: 120, rough: 1, col: '#5f7f96', top: '#7f9bb0', snow: 0.8, haze: 0.4 },
    { salt: 2, r: 4300, h: 360, base: 40, rough: 0.8, col: '#2f5a45', top: '#4b7a5a', snow: 2, haze: 0.2 } ] },
  links: { layers: [
    { salt: 3, r: 5600, h: 300, base: 30, rough: 0.6, col: '#6f8288', top: '#8d9da2', snow: 2, haze: 0.42 },
    { salt: 4, r: 4300, h: 150, base: 15, rough: 0.45, col: '#55683f', top: '#768451', snow: 2, haze: 0.22 } ] },
  mesa: { layers: [
    { salt: 5, r: 5600, h: 560, base: 100, rough: 0.9, col: '#a9705a', top: '#c99a80', snow: 2, haze: 0.38, flat: 0.62 },
    { salt: 6, r: 4300, h: 320, base: 30, rough: 0.7, col: '#94492b', top: '#b8683f', snow: 2, haze: 0.16, flat: 0.55 } ] },
  maple: { layers: [
    { salt: 7, r: 5600, h: 420, base: 60, rough: 0.7, col: '#6b6f8a', top: '#8c8ea6', snow: 2, haze: 0.42 },
    { salt: 8, r: 4300, h: 240, base: 25, rough: 0.6, col: '#8a4a26', top: '#c9772e', snow: 2, haze: 0.18 } ] },
  cay: { layers: [
    { salt: 9, r: 5600, h: 220, base: -10, rough: 0.9, col: '#5d8f8a', top: '#7aa79a', snow: 2, haze: 0.5 },
    { salt: 10, r: 4300, h: 90, base: -20, rough: 0.5, col: '#2f7a46', top: '#4f9a52', snow: 2, haze: 0.25 } ] },
  frost: { layers: [
    { salt: 11, r: 5600, h: 1500, base: 200, rough: 1.25, col: '#5f6e86', top: '#7d8aa0', snow: 0.66, haze: 0.35 },
    { salt: 12, r: 4300, h: 700, base: 60, rough: 1, col: '#34503f', top: '#58665e', snow: 0.8, haze: 0.15 } ] }
};

// a closed band of mountains around the course: vertex-coloured, hazier at the foot
function ridge(seed, cx, cz, L, fogHex, sea){
  const rnd = mulberry32(seed);
  const waves = Array.from({ length: 10 }, (_, i) => ({ f: [2, 3, 5, 7, 11, 17, 29, 47, 83, 131][i], p: rnd() * 6.28,
                                                       a: [1, 0.7, 0.45, 0.3, 0.2, 0.12, 0.07, 0.045, 0.028, 0.016][i] }));
  const N = 900, fog = new THREE.Color(fogHex), col = new THREE.Color(L.col), top = new THREE.Color(L.top), snow = new THREE.Color('#f4f7fa');
  const pos = [], cols = [], idx = [];
  for (let i = 0; i <= N; i++){
    const a = i / N * Math.PI * 2;
    let n = 0;
    for (const w of waves) n += Math.sin(a * w.f + w.p) * w.a * (w.f > 5 ? L.rough : 1);
    let k = Math.max(0, 0.5 + n * 0.32);
    if (L.flat) k = Math.min(k, L.flat) + Math.max(0, k - L.flat) * 0.08;       // mesas: flat tops
    // no mountains over the sea
    if (sea){ const fac = Math.cos(a) * sea.x + Math.sin(a) * sea.z; k *= 1 - Math.max(0, Math.min(1, (fac - 0.1) * 2.2)); }
    const y = L.base + k * L.h;
    const x = cx + Math.cos(a) * L.r, z = cz + Math.sin(a) * L.r;
    // the snow line is one continuous height, and snow fades in over a few columns, so no column steps
    const snowLine = L.base + L.snow * L.h * 0.97;
    const sf = L.snow < 1.5 ? Math.max(0, Math.min(1, (k - L.snow + 0.02) / 0.08)) : 0;
    pos.push(x, -120, z, x, y * 0.45, z, x, Math.min(y - 0.5, Math.max(y * 0.85, snowLine)), z, x, y, z);
    // gullies and buttresses: light and dark streaks running down the faces
    const g = 0.95 + 0.05 * (Math.sin(a * 67 + L.salt) * 0.6 + Math.sin(a * 131 + L.salt * 3) * 0.4);
    const bot = fog.clone();
    const mid = col.clone().multiplyScalar(g).lerp(fog, L.haze * 0.75);
    const sh = col.clone().lerp(top, 0.6 + sf * 0.4).multiplyScalar(g).lerp(fog, L.haze * 0.5);
    const tp = top.clone().multiplyScalar(g).lerp(snow, sf).lerp(fog, L.haze * 0.4);
    cols.push(bot.r, bot.g, bot.b, mid.r, mid.g, mid.b, sh.r, sh.g, sh.b, tp.r, tp.g, tp.b);
    if (i < N){
      const o = i * 4;
      for (let r = 0; r < 3; r++) idx.push(o + r, o + 4 + r, o + r + 1, o + r + 1, o + 4 + r, o + 5 + r);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  g.setIndex(idx);
  const m = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(g, m);
  mesh.renderOrder = -8;
  mesh.frustumCulled = false;
  return mesh;
}

// a mesa: rough-sided, slightly tapered, with banded strata and a pale cap
function mesaGeometry(){
  const g = new THREE.CylinderGeometry(1, 1.18, 1, 14, 7).translate(0, 0.5, 0);
  const p = g.attributes.position, rnd = mulberry32(31);
  const jit = Array.from({ length: 15 }, () => 0.86 + rnd() * 0.26);
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++){
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const r = Math.hypot(x, z);
    if (r > 1e-4){
      const a = Math.atan2(z, x), seg = Math.round((a + Math.PI) / (Math.PI * 2) * 14) % 14;
      const k = jit[seg] * (1 + (y < 0.95 ? Math.sin(y * 23 + seg) * 0.03 : 0));
      p.setX(i, x * k); p.setZ(i, z * k);
    }
    const band = 0.84 + 0.16 * Math.sin(y * 31) + 0.08 * Math.sin(y * 11 + 1);
    const cap = y > 0.995 && r < 1.25 ? 1.22 : 1;
    const red = y < 0.35 ? 1.06 : 1;
    col[i * 3] = band * cap * red; col[i * 3 + 1] = band * cap; col[i * 3 + 2] = band * cap * (y > 0.6 ? 1.02 : 0.96);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

let _grassGeo = null, _grassTex = null;
function grassGeometry(){
  if (_grassGeo) return _grassGeo;
  // three crossed quads, base at y=0, unit height
  const pos = [], uv = [], idx = [];
  for (let q = 0; q < 3; q++){
    const a = q / 3 * Math.PI, cx = Math.cos(a) * 0.5, cz = Math.sin(a) * 0.5, o = q * 4;
    pos.push(-cx, 0, -cz, cx, 0, cz, cx, 1, cz, -cx, 1, -cz);
    uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
  }
  _grassGeo = new THREE.BufferGeometry();
  _grassGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  _grassGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  _grassGeo.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length).fill(0).map((_, i) => i % 3 === 1 ? 1 : 0), 3));
  _grassGeo.setIndex(idx);
  _grassGeo.userData.shared = true;
  return _grassGeo;
}
function grassTexture(){
  if (_grassTex) return _grassTex;
  const S = 128, cv = document.createElement('canvas'); cv.width = cv.height = S;
  const c = cv.getContext('2d'), rnd = mulberry32(5);
  for (let i = 0; i < 26; i++){
    const x = 8 + rnd() * (S - 16), h = S * (0.45 + rnd() * 0.55), lean = (rnd() - 0.5) * 30, w = 2.2 + rnd() * 2.5;
    const g = c.createLinearGradient(0, S, 0, S - h);
    const v = 205 + rnd() * 50, lo = Math.round(v * 0.72);
    g.addColorStop(0, `rgb(${lo},${lo},${lo})`); g.addColorStop(1, `rgb(${Math.round(v)},${Math.round(v)},${Math.round(v)})`);
    c.fillStyle = g;
    c.beginPath(); c.moveTo(x - w, S); c.quadraticCurveTo(x + lean * 0.3, S - h * 0.6, x + lean, S - h); c.lineTo(x + w, S); c.fill();
  }
  _grassTex = new THREE.CanvasTexture(cv);
  _grassTex.colorSpace = THREE.SRGBColorSpace;
  _grassTex.userData.shared = true;
  return _grassTex;
}
function grassMaterial(world){
  const m = new THREE.MeshLambertMaterial({ map: grassTexture(), alphaTest: 0.45, side: THREE.DoubleSide });
  const u = { uTime: { value: 0 }, uWind: { value: 0.5 }, uBall: { value: new THREE.Vector3(1e6, 0, 1e6) }, uFar: { value: 70 } };
  m.userData.u = u;
  m.userData.shared = true;
  m.customProgramCacheKey = () => 'grass';
  m.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime; uniform float uWind; uniform vec3 uBall; uniform float uFar;')
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);\n#ifdef USE_TANGENT\nvec3 objectTangent = vec3(1.0, 0.0, 0.0);\n#endif')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
        float dc = distance(ip, cameraPosition);
        float sc = (1.0 - smoothstep(uFar * 0.65, uFar, dc)) * smoothstep(0.7, 1.6, distance(ip.xz, uBall.xz));
        transformed *= sc;
        float sway = sin(uTime * 1.9 + ip.x * 0.35 + ip.z * 0.27) + 0.5 * sin(uTime * 3.7 + ip.z * 0.9);
        transformed.x += sway * 0.09 * uWind * position.y;
        transformed.z += sway * 0.05 * uWind * position.y;`);
    // light every blade like the turf it grows from, whichever side faces the camera
    sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_begin>',
      'float faceDirection = 1.0;\nvec3 normal = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);\nvec3 nonPerturbedNormal = normal;');
  };
  return m;
}

/* ---------- the world ---------- */
export class World {
  constructor(canvas){
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.04, 9000);
    this.quality = 'high';
    this.t = 0;

    // lights
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x446633, 1);
    this.sun = new THREE.DirectionalLight(0xffffff, 2);
    this.scene.add(this.hemi, this.sun, this.sun.target);
    // real shadows near the action; a wide soft map that follows the camera
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const sc = this.sun.shadow;
    sc.mapSize.set(2048, 2048);
    sc.camera.left = sc.camera.bottom = -SHADOW_R; sc.camera.right = sc.camera.top = SHADOW_R;
    sc.camera.near = 1; sc.camera.far = 900;
    sc.bias = -0.0004; sc.normalBias = 0.04;
    this.shadowFocus = new THREE.Vector3();

    // sky dome
    this.skyU = { top: { value: new THREE.Color() }, bottom: { value: new THREE.Color() },
                  sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunCol: { value: new THREE.Color() } };
    const sky = new THREE.Mesh(new THREE.SphereGeometry(7000, 32, 16), new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false, uniforms: this.skyU,
      vertexShader: `varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `varying vec3 vD; uniform vec3 top; uniform vec3 bottom; uniform vec3 sunDir; uniform vec3 sunCol;
        void main(){ float h = clamp(vD.y, -0.2, 1.0);
          vec3 c = mix(bottom, top, pow(smoothstep(-0.03, 0.55, h), 0.7));
          // a pale band of haze lies along the horizon
          c = mix(c, mix(bottom, vec3(1.0), 0.3), (1.0 - smoothstep(0.0, 0.14, abs(h - 0.012))) * 0.4);
          float s = max(dot(normalize(vD), normalize(sunDir)), 0.0);
          c += sunCol * (pow(s, 900.0) * 1.8 + pow(s, 64.0) * 0.16 + pow(s, 7.0) * 0.1 * (1.0 - h));
          gl_FragColor = vec4(c, 1.0);
          #include <colorspace_fragment>
        }`
    }));
    sky.renderOrder = -10;
    this.sky = sky;
    this.scene.add(sky);
    this.scene.fog = new THREE.Fog(0xcccccc, 140, 2700);       // aerial haze starts early, like real distance

    this.detailTex = new THREE.CanvasTexture(detailCanvas(256));
    this.detailTex.wrapS = this.detailTex.wrapT = THREE.RepeatWrapping;
    this.detailTex.colorSpace = THREE.NoColorSpace;
    this.detailTex.anisotropy = 4;
    this.macroTex = new THREE.CanvasTexture(macroCanvas(128));
    this.macroTex.wrapS = this.macroTex.wrapT = THREE.RepeatWrapping;
    this.macroTex.colorSpace = THREE.NoColorSpace;

    this.holeGroup = new THREE.Group();
    this.scene.add(this.holeGroup);
    this.sceneryGroup = new THREE.Group();
    this.scene.add(this.sceneryGroup);

    this.buildBall();
    this.buildTracer();
    // aiming aids skip the depth test: a raised green's bank or a crest in the fairway
    // would otherwise swallow the end of the arc, and terrain or grass would bury a ground line
    this.dots = new Dots(400, { depthTest: false });                 // shot arcs
    this.groundDots = new Dots(400, { depthTest: false, order: 6 }); // putt read, rollout
    this.flow = new Dots(420);                       // green-reading flow
    this.parts = new Dots(900, { order: 6 });       // particles
    this.scene.add(this.dots.obj, this.groundDots.obj, this.flow.obj, this.parts.obj);
    this.particles = [];
    this.buildTarget();
    this.buildClouds();
    const peg = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.003, 0.05, 8),
      new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.5 }));
    peg.visible = false;
    this.peg = peg;
    this.scene.add(peg);
    this.others = [];
    this.golfers = [];
    this.resize();
  }

  setQuality(q){
    this.quality = q;
    this.sun.castShadow = q === 'high';
    this.resize();
  }
  resize(){
    const w = window.innerWidth, h = window.innerHeight;
    const pr = Math.min(window.devicePixelRatio || 1, this.quality === 'high' ? 2 : 1.25);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    for (const d of [this.dots, this.groundDots, this.flow, this.parts]) if (d) d.mat.uniforms.pr.value = pr;
    this.pr = pr;
  }

  setTheme(T){
    this.T = T;
    this.skyU.top.value.set(T.sky[0]);
    this.skyU.bottom.value.set(T.sky[1]);
    this.skyU.sunCol.value.set(T.sunColor);
    const sd = new THREE.Vector3(...T.sun).normalize();
    this.skyU.sunDir.value.copy(sd);
    this.sunDir = sd;
    this.sun.position.copy(sd).multiplyScalar(400);      // light from the theme's sun, not straight down
    this.sun.color.set(T.sunColor);
    this.sun.intensity = T.sunI;
    this.hemi.color.set(T.hemi[0]);
    this.hemi.groundColor.set(T.hemi[1]);
    this.hemi.intensity = T.hemi[2];
    this.scene.fog.color.set(T.fog);
  }

  buildClouds(){
    const rnd = mulberry32(17);
    // a few cumulus sheets: billowing white tops, greyer flat undersides; and one high wisp
    const tex = [];
    for (let v = 0; v < 4; v++){
      const W = 512, H = 256, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      const c = cv.getContext('2d');
      if (v < 3){
        const base = H * 0.72;
        for (let i = 0; i < 70; i++){
          const x = 70 + rnd() * (W - 140), hump = Math.cos((x / W - 0.5) * Math.PI) * (0.5 + rnd() * 0.5);
          const r = 14 + rnd() * 34 * (0.5 + hump);
          const y = Math.min(base - r * 0.4, base - hump * H * 0.42 * rnd() - r * 0.2);
          const g = c.createRadialGradient(x - r * 0.25, y - r * 0.3, 0, x, y, r);
          g.addColorStop(0, 'rgba(255,255,255,0.95)'); g.addColorStop(0.55, 'rgba(255,255,255,0.55)'); g.addColorStop(1, 'rgba(255,255,255,0)');
          c.fillStyle = g; c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
        }
        c.globalCompositeOperation = 'source-atop';
        const sh = c.createLinearGradient(0, H * 0.25, 0, base);
        sh.addColorStop(0, 'rgba(120,132,150,0)'); sh.addColorStop(1, 'rgba(120,132,150,0.5)');
        c.fillStyle = sh; c.fillRect(0, 0, W, H);
      } else {
        for (let i = 0; i < 40; i++){
          const x = rnd() * W, y = H * 0.3 + rnd() * H * 0.4, w = 60 + rnd() * 160;
          c.save(); c.translate(x, y); c.rotate((rnd() - 0.5) * 0.25); c.scale(1, 0.12);
          const g = c.createRadialGradient(0, 0, 0, 0, 0, w);
          g.addColorStop(0, 'rgba(255,255,255,0.5)'); g.addColorStop(1, 'rgba(255,255,255,0)');
          c.fillStyle = g; c.beginPath(); c.arc(0, 0, w, 0, Math.PI * 2); c.fill(); c.restore();
        }
      }
      const t = new THREE.CanvasTexture(cv);
      t.colorSpace = THREE.SRGBColorSpace;
      tex.push(t);
    }
    this.clouds = new THREE.Group();
    for (let i = 0; i < 26; i++){
      const wisp = i % 6 === 5;
      const m = new THREE.SpriteMaterial({ map: tex[wisp ? 3 : i % 3], transparent: true, depthWrite: false, fog: false,
                                           toneMapped: false, opacity: wisp ? 0.5 : 0.7 + rnd() * 0.25 });
      const sp = new THREE.Sprite(m);
      const a = rnd() * Math.PI * 2, d = 2400 + rnd() * 3000;
      sp.position.set(Math.cos(a) * d, (wisp ? 2200 : 800) + rnd() * 1200, Math.sin(a) * d);
      const sc = (wisp ? 1600 : 700) + rnd() * 1000;
      sp.scale.set(sc, sc * 0.5, 1);
      sp.renderOrder = -9;
      this.clouds.add(sp);
    }
    this.scene.add(this.clouds);
  }

  /* ================= hole ================= */
  disposeHole(){
    const kill = g => {
      g.traverse(o => {
        if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
        if (o.material){
          const ms = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of ms){ if (m.map && !m.map.userData.shared) m.map.dispose(); if (!m.userData.shared) m.dispose(); }
        }
      });
      while (g.children.length) g.remove(g.children[0]);
    };
    kill(this.holeGroup);
    kill(this.sceneryGroup);
    this.flag = null;
  }

  buildHole(h, prep){
    this.disposeHole();
    this.h = h;
    this.seaMesh = null;
    // links and island holes run beside the sea, off one side and square to the line of the hole
    this.seaDir = null;
    if (h.T.sea){
      const dx = h.greenC.x - h.tee.x, dz = h.greenC.z - h.tee.z, L = Math.hypot(dx, dz) || 1;
      const side = mulberry32(h.seed + 4243)() < 0.5 ? -1 : 1;
      this.seaDir = { x: -dz / L * side, z: dx / L * side };
    }
    const T = h.T;
    this.setTheme(T);
    const b = h.bounds;
    if (!prep || prep.quality !== this.quality) prep = prepareHole(h, this.quality);

    /* ---- surface texture ---- */
    const painted = paintRegion(h, b, surfacePPY(this.quality), {}, prep.main);
    this.surfaceCanvas = painted.canvas;
    const tex = new THREE.CanvasTexture(painted.canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = false;
    tex.anisotropy = 8;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;

    /* ---- terrain mesh with a far skirt ---- */
    const { nx, nz, step, heights } = prep.terr;
    this.terr = { nx, nz, step, heights, minX: b.minX, minZ: b.minZ, maxX: b.maxX, maxZ: b.maxZ };
    const cols = nx + 2, rows = nz + 2;
    const pos = new Float32Array(cols * rows * 3);
    const uv = new Float32Array(cols * rows * 2);
    const W = b.maxX - b.minX, D = b.maxZ - b.minZ;
    const SK = 2600;
    let k = 0, u = 0;
    for (let r = 0; r < rows; r++){
      const zi = r === 0 ? b.minZ - SK : r === rows - 1 ? b.maxZ + SK : Math.min(b.maxZ, b.minZ + (r - 1) * step);
      const ri = Math.max(0, Math.min(nz - 1, r - 1));
      for (let c = 0; c < cols; c++){
        const xi = c === 0 ? b.minX - SK : c === cols - 1 ? b.maxX + SK : Math.min(b.maxX, b.minX + (c - 1) * step);
        const skirt = r === 0 || c === 0 || r === rows - 1 || c === cols - 1;
        const ci = Math.max(0, Math.min(nx - 1, c - 1));
        pos[k++] = xi;
        // on the sea side the land falls away to a shoreline instead of running to the horizon
        const toSea = skirt && this.seaDir && ((xi - (b.minX + b.maxX) / 2) * this.seaDir.x + (zi - (b.minZ + b.maxZ) / 2) * this.seaDir.z) > 0;
        pos[k++] = heights[ri * nx + ci] - (skirt ? (toSea ? 60 : 6) : 0);
        pos[k++] = zi;
        uv[u++] = Math.max(0, Math.min(1, (xi - b.minX) / W));
        uv[u++] = Math.max(0, Math.min(1, (zi - b.minZ) / D));
      }
    }
    const idx = new Uint32Array((cols - 1) * (rows - 1) * 6);
    k = 0;
    for (let r = 0; r < rows - 1; r++) for (let c = 0; c < cols - 1; c++){
      const a = r * cols + c, bb = a + 1, cc = a + cols, dd = cc + 1;
      idx[k++] = a; idx[k++] = cc; idx[k++] = bb;
      idx[k++] = bb; idx[k++] = cc; idx[k++] = dd;
    }
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    tg.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    tg.setAttribute('color', new THREE.BufferAttribute(this.terrainShade(h, prep.terr, cols, rows), 3));
    tg.setIndex(new THREE.BufferAttribute(idx, 1));
    tg.computeVertexNormals();
    const tm = new THREE.MeshLambertMaterial({ map: tex, vertexColors: true });
    addDetail(tm, this.detailTex, 0.42, { minX: b.minX, minZ: b.minZ, maxX: b.maxX, maxZ: b.maxZ, color: T.outer, macro: this.macroTex });
    this.terrain = new THREE.Mesh(tg, tm);
    this.terrain.receiveShadow = true;
    this.holeGroup.add(this.terrain);

    /* ---- high-res green patch ---- */
    const gReg = prep.gReg, gr = gReg.r;
    const gp = paintRegion(h, gReg, 14, { edgeFade: 3, salt: 3 }, prep.green);
    const gtex = new THREE.CanvasTexture(gp.canvas);
    gtex.colorSpace = THREE.SRGBColorSpace; gtex.flipY = false; gtex.anisotropy = 8;
    const { gn, gs } = prep.gpatch, gH = prep.gpatch.heights;
    this.gpatch = { nx: gn, nz: gn, step: gs, heights: gH, minX: gReg.minX, minZ: gReg.minZ,
                    maxX: gReg.minX + gr * 2, maxZ: gReg.minZ + gr * 2, lift: 0.008 };
    const gpos = new Float32Array(gn * gn * 3), guv = new Float32Array(gn * gn * 2);
    k = 0; u = 0;
    for (let r = 0; r < gn; r++){
      const z = gReg.minZ + Math.min(gr * 2, r * gs);
      for (let c = 0; c < gn; c++){
        const x = gReg.minX + Math.min(gr * 2, c * gs);
        gpos[k++] = x; gpos[k++] = gH[r * gn + c] + 0.008; gpos[k++] = z;
        guv[u++] = (x - gReg.minX) / (gr * 2); guv[u++] = (z - gReg.minZ) / (gr * 2);
      }
    }
    const gidx = new Uint32Array((gn - 1) * (gn - 1) * 6);
    k = 0;
    for (let r = 0; r < gn - 1; r++) for (let c = 0; c < gn - 1; c++){
      const a = r * gn + c, bb = a + 1, cc = a + gn, dd = cc + 1;
      gidx[k++] = a; gidx[k++] = cc; gidx[k++] = bb; gidx[k++] = bb; gidx[k++] = cc; gidx[k++] = dd;
    }
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.BufferAttribute(gpos, 3));
    gg.setAttribute('uv', new THREE.BufferAttribute(guv, 2));
    gg.setIndex(new THREE.BufferAttribute(gidx, 1));
    gg.computeVertexNormals();
    const gm = new THREE.MeshLambertMaterial({ map: gtex, transparent: true, polygonOffset: true,
                                               polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    addDetail(gm, this.detailTex, 0.3);
    const greenMesh = new THREE.Mesh(gg, gm);
    greenMesh.receiveShadow = true;
    greenMesh.renderOrder = 1;
    this.holeGroup.add(greenMesh);
    this.gReg = gReg;
    this.gridPts = prep.grid;

    /* ---- water ---- */
    this.water = [];
    for (const p of h.ponds){
      // quads covering the pond plus a margin; the banks hide the rough edge
      const R = p.bound.r - 18, cell = 1;
      const verts = [];
      for (let z = -R; z < R; z += cell) for (let x = -R; x < R; x += cell){
        if (h.blobSD(p.circles, p.bound.x + x + cell / 2, p.bound.z + z + cell / 2) > 2.2) continue;
        verts.push(x, 0, z, x, 0, z + cell, x + cell, 0, z, x + cell, 0, z, x, 0, z + cell, x + cell, 0, z + cell);
      }
      const wg = new THREE.BufferGeometry();
      wg.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      const uvs = [];
      for (let i = 0; i < verts.length; i += 3) uvs.push(verts[i] / 40, verts[i + 2] / 40);
      wg.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      // water depth at every vertex, against the ground as drawn
      const dep = new Float32Array(verts.length / 3);
      for (let i = 0; i < dep.length; i++) dep[i] = p.level - this.groundAt(p.bound.x + verts[i * 3], p.bound.z + verts[i * 3 + 2]);
      wg.setAttribute('aDepth', new THREE.BufferAttribute(dep, 1));
      wg.computeVertexNormals();
      const wm = this.waterMaterial(T, this.waterNormal());
      const w = new THREE.Mesh(wg, wm);
      w.position.set(p.bound.x, p.level, p.bound.z);
      w.renderOrder = 2;
      this.holeGroup.add(w);
      this.water.push(w);
    }

    /* ---- flag, cup, tee markers, stakes ---- */
    this.buildFlag(h);
    this.buildMarkers(h);
    this.clouds.position.set((b.minX + b.maxX) / 2, 0, (b.minZ + b.maxZ) / 2);
    this.clouds.children.forEach(c => c.material.color.set(h.T.cloud || '#ffffff'));

    /* ---- trees ---- */
    this.buildTrees(h.trees, this.holeGroup, T, 1, true);
    this.buildGrass(h, prep.grass);
    this.buildScenery(h);

    /* ---- green grid for reading putts ---- */
    this.buildGreenGrid(h);
    this.flowSeed = mulberry32(h.seed + 99);
    this.flowP = [];
  }

  /* Baked ambient light for the terrain grid: hollows, bunker bowls and
     the ground under canopies sit in shade, crests catch a little more
     sky. Returned as vertex colours for the grid plus its skirt ring. */
  terrainShade(h, terr, cols, rows){
    const { nx, nz, step, heights } = terr;
    const out = new Float32Array(cols * rows * 3).fill(1);
    const ao = new Float32Array(nx * nz).fill(1);
    const H = (r, c) => heights[Math.max(0, Math.min(nz - 1, r)) * nx + Math.max(0, Math.min(nx - 1, c))];
    const n1 = Math.max(2, Math.round(4 / step)), n2 = Math.max(4, Math.round(12 / step));
    for (let r = 0; r < nz; r++) for (let c = 0; c < nx; c++){
      const y = heights[r * nx + c];
      const l1 = (H(r - n1, c) + H(r + n1, c) + H(r, c - n1) + H(r, c + n1)) / 4 - y;
      const l2 = (H(r - n2, c - n2) + H(r - n2, c + n2) + H(r + n2, c - n2) + H(r + n2, c + n2) +
                  H(r - n2, c) + H(r + n2, c) + H(r, c - n2) + H(r, c + n2)) / 8 - y;
      ao[r * nx + c] = Math.max(0.7, Math.min(1.06, 1 - l1 * 0.13 - l2 * 0.035));
    }
    // contact shade under trees: darkest at the trunk, fading past the drip line
    const b = h.bounds;
    for (const t of h.trees){
      if (t.kind === 'rock' || t.kind === 'cactus') continue;
      const R = t.r * (t.kind === 'palm' ? 1.1 : t.kind === 'gorse' ? 1.3 : 1.55), dark = t.kind === 'gorse' ? 0.25 : t.kind === 'palm' ? 0.22 : 0.38;
      const c0 = Math.floor((t.x - R - b.minX) / step), c1 = Math.ceil((t.x + R - b.minX) / step);
      const r0 = Math.floor((t.z - R - b.minZ) / step), r1 = Math.ceil((t.z + R - b.minZ) / step);
      for (let r = Math.max(0, r0); r <= Math.min(nz - 1, r1); r++) for (let c = Math.max(0, c0); c <= Math.min(nx - 1, c1); c++){
        const d = Math.hypot(b.minX + c * step - t.x, b.minZ + r * step - t.z) / R;
        if (d < 1) ao[r * nx + c] *= 1 - dark * (1 - d * d) * (1 - d * d);
      }
    }
    for (let r = 1; r < rows - 1; r++) for (let c = 1; c < cols - 1; c++){
      const v = ao[Math.min(nz - 1, r - 1) * nx + Math.min(nx - 1, c - 1)], o = (r * cols + c) * 3;
      out[o] = out[o + 1] = out[o + 2] = v;
    }
    return out;
  }

  /* Height of the terrain as it is drawn (the triangulated grid, not the
     analytic surface), so things resting on it never sink in or float. */
  groundAt(x, z){
    if (!this.terr) return this.h ? this.h.heightAt(x, z) : 0;
    let y = gridHeight(this.terr, x, z);
    const g = this.gpatch;
    if (g && x > g.minX && x < g.maxX && z > g.minZ && z < g.maxZ) y = Math.max(y, gridHeight(g, x, z) + g.lift);
    return y;
  }

  // upload textures and compile shaders now, while the screen is faded out
  warm(){
    const hidden = [];
    this.scene.traverse(o => { if (!o.visible && o !== this.scene){ hidden.push(o); o.visible = true; } });
    try{ this.renderer.compile(this.scene, this.camera); this.render(); }catch(e){}
    for (const o of hidden) o.visible = false;
    this.scene.traverse(o => {
      const m = o.material;
      if (m && m.map && m.map.isTexture && this.renderer.initTexture) this.renderer.initTexture(m.map);
    });
  }

  /* Water that reads its own depth: pale and see-through in the shallows,
     dark in the middle, a broken foam line at the bank, and the sky
     reflected at grazing angles. Needs an aDepth attribute (yards). */
  waterMaterial(T, normalMap, foam = true){
    const deep = new THREE.Color(T.water).multiplyScalar(0.72);
    const shallow = new THREE.Color(T.waterTop).lerp(new THREE.Color(T.sand), 0.12);
    const m = new THREE.MeshPhongMaterial({ color: '#ffffff', specular: 0xffffff, shininess: 140, transparent: true,
      normalMap, normalScale: new THREE.Vector2(0.35, 0.35) });
    const u = { uDeep: { value: deep }, uShallow: { value: shallow }, uSky: { value: new THREE.Color(T.sky[1]).lerp(new THREE.Color(T.sky[0]), 0.35) },
                uTime: { value: 0 } };
    m.userData.u = u;
    m.customProgramCacheKey = () => 'water' + foam;
    m.onBeforeCompile = sh => {
      Object.assign(sh.uniforms, u);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aDepth; varying float vDepth; varying vec3 vWW;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvDepth = aDepth; vWW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vDepth; varying vec3 vWW; uniform vec3 uDeep; uniform vec3 uShallow; uniform vec3 uSky; uniform float uTime;')
        .replace('#include <color_fragment>', `#include <color_fragment>
          float dk = smoothstep(0.0, 1.3, vDepth);
          diffuseColor.rgb = mix(uShallow, uDeep, dk);
          diffuseColor.a = mix(0.5, 0.93, smoothstep(0.0, 0.9, vDepth));
          ${foam ? `float rip = 0.5 + 0.5 * sin(vWW.x * 2.1 + uTime * 1.3) * sin(vWW.z * 1.7 - uTime * 0.9);
          float fo = (1.0 - smoothstep(0.01, 0.1 + rip * 0.08, vDepth)) * step(-0.02, vDepth);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.94, 0.97, 1.0), fo * 0.6);
          diffuseColor.a = max(diffuseColor.a, fo * 0.9);` : ''}`)
        .replace('#include <opaque_fragment>', `float fr = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 4.0);
          outgoingLight = mix(outgoingLight, uSky, fr * 0.7);
          #include <opaque_fragment>`);
    };
    return m;
  }

  waterNormal(){
    if (this._wn) return this._wn;
    const S = 128, cv = document.createElement('canvas'); cv.width = cv.height = S;
    const ctx = cv.getContext('2d'), img = ctx.createImageData(S, S);
    const hgt = (i, j) => Math.sin(i / S * Math.PI * 2 * 3) * 0.5 + Math.sin((i + j) / S * Math.PI * 2 * 5) * 0.3
                        + Math.sin((j * 2 - i) / S * Math.PI * 2 * 2) * 0.4;
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++){
      const dx = hgt(i + 1, j) - hgt(i - 1, j), dy = hgt(i, j + 1) - hgt(i, j - 1);
      const o = (j * S + i) * 4;
      img.data[o] = 128 + dx * 60; img.data[o + 1] = 128 + dy * 60; img.data[o + 2] = 255; img.data[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(cv);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(6, 6);
    t.userData.shared = true;
    this._wn = t;
    return t;
  }

  buildFlag(h){
    const g = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, 2.33, 6),
      new THREE.MeshStandardMaterial({ color: '#f5f5f0', roughness: 0.4 }));
    pole.position.y = 2.33 / 2;
    const fg = new THREE.PlaneGeometry(0.62, 0.42, 14, 4);
    fg.translate(0.31, 0, 0);
    const flagColor = h.T.flag || '#ffd21f';
    const fm = new THREE.MeshLambertMaterial({ color: flagColor, side: THREE.DoubleSide,
      emissive: new THREE.Color(flagColor), emissiveIntensity: 0.45 });
    const flag = new THREE.Mesh(fg, fm);
    flag.position.y = 2.33 - 0.22;
    const swing = new THREE.Group();
    swing.add(flag);
    g.add(pole, swing);
    pole.castShadow = flag.castShadow = true;
    g.position.set(h.pin.x, h.pin.y, h.pin.z);
    swing.rotation.y = Math.PI / 2 - h.wind.dir;
    this.flagBase = Float32Array.from(fg.attributes.position.array);
    this.flag = { group: g, mesh: flag, swing, geo: fg };
    this.holeGroup.add(g);

    // cup and liner, tilted to the green
    const n = gradAt(h, h.pin.x, h.pin.z);
    const normal = new THREE.Vector3(-n.x, 1, -n.z).normalize();
    const cup = new THREE.Mesh(new THREE.CircleGeometry(CUP_R, 28), new THREE.MeshBasicMaterial({ color: '#0b0d0b' }));
    const rim = new THREE.Mesh(new THREE.RingGeometry(CUP_R * 0.86, CUP_R * 1.06, 28),
      new THREE.MeshBasicMaterial({ color: '#e9eee8' }));
    const cupG = new THREE.Group();
    cupG.add(cup, rim);
    cupG.position.set(h.pin.x, h.pin.y + 0.014, h.pin.z);
    cupG.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    cup.renderOrder = rim.renderOrder = 3;
    cup.material.polygonOffset = rim.material.polygonOffset = true;
    cup.material.polygonOffsetFactor = rim.material.polygonOffsetFactor = -4;
    this.holeGroup.add(cupG);
    this.cup = cupG;
  }

  buildMarkers(h){
    const col = h.T.marker || '#1d5c2c';
    const mm = new THREE.MeshStandardMaterial({ color: col, roughness: 0.5 });
    const geo = new THREE.SphereGeometry(0.09, 14, 10);
    const tb = h.teeBox;
    for (const side of [-1, 1]){
      const m = new THREE.Mesh(geo, mm);
      const lx = side * 3.6, lz = -tb.hl * 0.6;
      const c = Math.cos(-tb.rot), s = Math.sin(-tb.rot);
      const x = tb.x + lx * c - lz * s, z = tb.z + lx * s + lz * c;
      m.position.set(x, h.heightAt(x, z) + 0.07, z);
      this.holeGroup.add(m);
    }
    // white out-of-bounds stakes
    const sm = new THREE.MeshLambertMaterial({ color: '#ffffff' });
    const sg = new THREE.CylinderGeometry(0.05, 0.05, 1, 5);
    const inst = new THREE.InstancedMesh(sg, sm, h.stakes.length);
    const M = new THREE.Matrix4();
    h.stakes.forEach((s, i) => { M.makeTranslation(s.x, s.y + 0.5, s.z); inst.setMatrixAt(i, M); });
    this.holeGroup.add(inst);
  }

  /* ---- trees: one InstancedMesh per part ---- */
  treeGeos(q = this.quality){
    this._tg = this._tg || {};
    if (this._tg[q]) return this._tg[q];
    const hi = q === 'high';
    const mk = g => { g.userData.shared = true; return g; };
    const many = (n, f) => Array.from({ length: n }, (_, i) => mk(f(i)));
    const cs = hi ? 9 : 7, lumps = hi ? 6 : 5;
    this._tg[q] = {
      trunk: mk(trunkGeometry('bark', 3, hi)), birch: mk(trunkGeometry('birch', 5, hi)), palmTrunk: mk(trunkGeometry('palm', 7, hi)),
      canopy: many(4, i => canopyGeometry(101 + i * 17, { lumps, seg: cs })),
      tall: many(2, i => canopyGeometry(211 + i * 13, { lumps: lumps - 1, seg: cs, squash: 1.25, spread: 0.42 })),
      bush: many(3, i => canopyGeometry(307 + i * 11, { lumps: 5, seg: hi ? 8 : 6, squash: 0.62, rough: 0.36 })),
      flat: many(2, i => canopyGeometry(401 + i * 7, { lumps: 6, seg: cs - 2, squash: 0.5, spread: 0.6 })),
      pine: many(3, i => pineGeometry(503 + i * 19, { tiers: hi ? 7 : 5, seg: hi ? 14 : 10 })),
      snowPine: many(3, i => pineGeometry(601 + i * 23, { tiers: hi ? 7 : 5, seg: hi ? 14 : 10, snow: true })),
      frond: mk(frondGeometry(9)),
      rock: many(4, i => rockGeometry(701 + i * 29)),
      nut: mk(new THREE.SphereGeometry(0.16, 6, 5)),
      cactus: mk(new THREE.CapsuleGeometry(0.3, 1, 3, 10).translate(0, 0.5, 0)),
      arm: mk(new THREE.CapsuleGeometry(0.2, 1, 3, 8).translate(0, 0.5, 0)),
      mesa: mk(mesaGeometry()),
      dune: mk(new THREE.SphereGeometry(1, 20, 8, 0, Math.PI * 2, 0, Math.PI / 2))
    };
    return this._tg[q];
  }
  buildTrees(list, parent, T, scaleAll, shadows, detail){
    const G = this.treeGeos(detail);
    const parts = {};                 // key -> [{m, color}]
    const add = (key, geo, mat, m, color) => {
      key += '|' + geo.uuid;          // one InstancedMesh per geometry, or cones and blobs would share a shape
      (parts[key] = parts[key] || { geo, mat, items: [] }).items.push({ m, color });
    };
    const lam = (c, flat, side) => new THREE.MeshLambertMaterial({ color: c, flatShading: !!flat, vertexColors: true, side: side || THREE.FrontSide });
    const mats = this._tm || (this._tm = {
      trunk: lam('#6b4a32'), birchTrunk: lam('#ece8de'), palmTrunk: lam('#9a7d5a'), leaf: lam('#ffffff'),
      frond: lam('#ffffff', false, THREE.DoubleSide), cactus: lam('#ffffff', true), rock: lam('#ffffff', true),
      mesa: lam('#ffffff', true), dune: lam('#ffffff'), plain: new THREE.MeshLambertMaterial({ color: '#ffffff' })
    });
    mats.cactus.vertexColors = false;          // capsules carry no colour attribute
    for (const m of Object.values(mats)) m.userData.shared = true;
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3(), P = new THREE.Vector3();
    const E = new THREE.Euler();
    const comp = (x, y, z, sx, sy, sz, ry = 0, rx = 0, rz = 0) => {
      E.set(rx, ry, rz); Q.setFromEuler(E); S.set(sx, sy, sz); P.set(x, y, z);
      return new THREE.Matrix4().compose(P, Q, S);
    };
    const hsl = (h, s, l) => new THREE.Color().setHSL(h, s, l);
    const pick = (arr, v) => arr[Math.floor(v * 997) % arr.length];
    for (const t of list){
      const sc = (t.scale || 1) * scaleAll;
      const v = t.tint;
      if (t.kind === 'oak' || t.kind === 'maple'){
        let col, col2;
        if (t.kind === 'oak'){ col = hsl(0.26 + v * 0.05, 0.42, 0.24 + v * 0.06); col2 = hsl(0.25 + v * 0.05, 0.42, 0.28 + v * 0.05); }
        else {
          // fall colour: mostly reds and oranges, some gold, the odd one still green
          const hue = v < 0.38 ? 0.01 + v * 0.05 : v < 0.72 ? 0.06 + (v - 0.38) * 0.08 : v < 0.92 ? 0.11 + (v - 0.72) * 0.1 : 0.2;
          const lit = v < 0.38 ? 0.34 : 0.4;
          col = hsl(hue, 0.72, lit); col2 = hsl(hue + 0.015, 0.75, lit + 0.05);
        }
        add('trunk', G.trunk, mats.trunk, comp(t.x, t.y, t.z, sc, t.trunk * sc + t.r * 0.45, sc, t.rot));
        add('leaf', pick(G.canopy, v), mats.leaf, comp(t.x, t.y + t.h * sc, t.z, t.r * sc, t.r * 0.9 * sc, t.r * sc, t.rot), col);
        add('leaf', pick(G.canopy, v + 0.37), mats.leaf, comp(t.x + Math.cos(t.rot) * t.r * 0.42 * sc, t.y + (t.h + t.r * 0.3) * sc,
            t.z - Math.sin(t.rot) * t.r * 0.42 * sc, t.r * 0.6 * sc, t.r * 0.55 * sc, t.r * 0.6 * sc, t.rot * 2), col2);
      } else if (t.kind === 'pine' || t.kind === 'spruce'){
        const snow = t.kind === 'spruce';
        add('trunk', G.trunk, mats.trunk, comp(t.x, t.y, t.z, sc * 0.75, (t.trunk + t.r) * sc, sc * 0.75, t.rot));
        const col = snow ? new THREE.Color(1, 1, 1).multiplyScalar(0.92 + v * 0.1) : hsl(0.37 + v * 0.04, 0.42, 0.2 + v * 0.06);
        const hgt = (snow ? 3.1 : 2.75) * t.r;
        add('leaf', pick(snow ? G.snowPine : G.pine, v), mats.leaf,
            comp(t.x, t.y + (t.trunk * sc + hgt * sc * 0.5), t.z, t.r * sc, hgt * sc, t.r * sc, t.rot), col);
      } else if (t.kind === 'birch'){
        add('birch', G.birch, mats.birchTrunk, comp(t.x, t.y, t.z, sc * 0.65, (t.trunk + t.r * 0.6) * sc, sc * 0.65, t.rot));
        add('leaf', pick(G.tall, v), mats.leaf, comp(t.x, t.y + t.h * sc, t.z, t.r * 0.8 * sc, t.r * 0.95 * sc, t.r * 0.8 * sc, t.rot),
            hsl(0.21 + v * 0.05, 0.5, 0.34 + v * 0.06));
      } else if (t.kind === 'gorse'){
        add('leaf', pick(G.bush, v), mats.leaf, comp(t.x, t.y + t.r * 0.22, t.z, t.r * sc, t.r * 0.9 * sc, t.r * sc, t.rot),
            v > 0.6 ? hsl(0.13, 0.6, 0.4) : hsl(0.24 + v * 0.04, 0.38, 0.2 + v * 0.05));
      } else if (t.kind === 'cactus'){
        const col = hsl(0.3, 0.35, 0.3 + v * 0.06);
        add('cactus', G.cactus, mats.cactus, comp(t.x, t.y, t.z, sc, t.trunk * sc * 0.8, sc), col);
        if (v > 0.25){
          const a = t.rot;
          const ox = Math.cos(a) * 0.5 * sc, oz = Math.sin(a) * 0.5 * sc;
          add('cactus', G.arm, mats.cactus, comp(t.x + ox, t.y + t.trunk * 0.38 * sc, t.z + oz, sc, t.trunk * 0.35 * sc, sc), col);
          add('cactus', G.arm, mats.cactus, comp(t.x + ox * 0.5, t.y + t.trunk * 0.38 * sc, t.z + oz * 0.5, sc * 0.9, 0.5 * sc, sc * 0.9, 0, 0, Math.PI / 2 * (Math.cos(a) > 0 ? 1 : -1)), col);
        }
      } else if (t.kind === 'rock'){
        const rk = T.rock || [0.05, 0.45, 0.42];
        add('rock', pick(G.rock, v), mats.rock, comp(t.x, t.y + t.r * 0.12, t.z, t.r * sc, t.r * 0.66 * sc, t.r * 0.88 * sc, t.rot, v * 0.3, v * 0.2),
            hsl(rk[0] + v * 0.03, rk[1], rk[2] + v * 0.1));
      } else if (t.kind === 'palm'){
        // a curved trunk leaning away from the crown's base, then drooping fronds
        const segs = 4, lean = 0.12 + v * 0.3, seg = t.trunk * sc / segs;
        const dx = Math.cos(t.rot), dz = -Math.sin(t.rot);
        let reach = 0;
        for (let k = 0; k < segs; k++) reach += Math.sin(lean * (k + 0.5) / segs * 1.6) * seg;
        let px = t.x - dx * reach, py = t.y, pz = t.z - dz * reach;
        for (let k = 0; k < segs; k++){
          const a = lean * (k + 0.5) / segs * 1.6;
          add('trunk', G.palmTrunk, mats.palmTrunk, comp(px, py, pz, sc * (0.95 - k * 0.12), seg * 1.08, sc * (0.95 - k * 0.12), t.rot, 0, -a));
          px += dx * Math.sin(a) * seg; py += Math.cos(a) * seg; pz += dz * Math.sin(a) * seg;
        }
        const col = hsl(0.27 + v * 0.04, 0.55, 0.27 + v * 0.06), old = hsl(0.15, 0.45, 0.33);
        const n = 11;
        for (let k = 0; k < n; k++){
          const yaw = t.rot + k / n * Math.PI * 2 + v * 3, lift = -0.35 + ((k * 0.61 + v) % 1) * 0.6;
          const L = t.r * sc * (1.25 + ((k * 0.37) % 1) * 0.35);
          add('frond', G.frond, mats.frond, comp(px, py + 0.1, pz, L, L, L * (k % 4 === 0 ? 0.8 : 1), yaw, 0, lift), k % 5 === 2 ? old : col);
        }
        for (let k = 0; k < 3; k++)
          add('nut', G.nut, mats.plain, comp(px + Math.cos(k * 2.1) * 0.22, py - 0.15, pz + Math.sin(k * 2.1) * 0.22, sc, sc, sc), hsl(0.08, 0.5, 0.22));
      } else if (t.kind === 'mesa'){
        add('mesa', G.mesa, mats.mesa, comp(t.x, t.y, t.z, t.r, t.h, t.r * (0.8 + v * 0.4), t.rot),
            hsl(0.04 + v * 0.03, 0.5, 0.45 + v * 0.1));
      } else if (t.kind === 'dune'){
        add('dune', G.dune, mats.plain, comp(t.x, t.y - 2, t.z, t.r, t.h, t.r * 0.7, t.rot), hsl(0.2 + v * 0.03, 0.3, 0.38 + v * 0.08));
      } else {     // palo verde
        add('trunk', G.trunk, mats.trunk, comp(t.x, t.y, t.z, sc * 0.6, (t.trunk + 0.4) * sc, sc * 0.6, t.rot));
        add('leaf', pick(G.flat, v), mats.leaf, comp(t.x, t.y + t.h * sc, t.z, t.r * sc, t.r * 0.7 * sc, t.r * sc, t.rot),
            hsl(0.2 + v * 0.04, 0.42, 0.36));
      }
    }
    for (const key in parts){
      const p = parts[key];
      const inst = new THREE.InstancedMesh(p.geo, p.mat, p.items.length);
      p.items.forEach((it, i) => {
        inst.setMatrixAt(i, it.m);
        if (it.color) inst.setColorAt(i, it.color);
        else inst.setColorAt(i, new THREE.Color(1, 1, 1));
      });
      inst.instanceMatrix.needsUpdate = true;
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
      inst.computeBoundingSphere();
      if (shadows){ inst.castShadow = true; inst.receiveShadow = true; }
      parent.add(inst);
    }
  }

  /* ---- scenery outside the hole ---- */
  buildScenery(h){
    const rnd = mulberry32(h.seed + 4242);
    const b = h.bounds, T = h.T;
    const list = [];
    const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
    const hw = (b.maxX - b.minX) / 2, hd = (b.maxZ - b.minZ) / 2;
    const ringPoint = (near, far) => {
      // a point outside the playing area, roughly uniform around it
      const a = rnd() * Math.PI * 2;
      const d = near + rnd() * (far - near);
      const ex = Math.cos(a), ez = Math.sin(a);
      const k = 1 / Math.max(Math.abs(ex) / hw, Math.abs(ez) / hd);
      return { x: cx + ex * (k + d), z: cz + ez * (k + d) };
    };
    const inside = p => p.x > b.minX && p.x < b.maxX && p.z > b.minZ && p.z < b.maxZ;
    const hAt = (x, z) => h.heightAt(Math.max(b.minX, Math.min(b.maxX, x)), Math.max(b.minZ, Math.min(b.maxZ, z))) - 6;
    // links: the sea lies off one side of the hole, square to its line
    const sea = this.seaDir;
    const offSea = p => !sea || (p.x - cx) * sea.x + (p.z - cz) * sea.z < Math.abs(sea.x) * hw + Math.abs(sea.z) * hd + 40;
    if (h.theme === 'pines'){
      for (let i = 0; i < 520; i++){
        const p = ringPoint(-12, 420);
        const kind = rnd() < 0.6 ? 'pine' : 'oak';
        const r = kind === 'pine' ? 3.5 + rnd() * 2.5 : 5 + rnd() * 3;
        const trunk = kind === 'pine' ? 2 + rnd() : 3 + rnd();
        list.push({ x: p.x, z: p.z, y: p.x > b.minX && p.x < b.maxX && p.z > b.minZ && p.z < b.maxZ ? h.heightAt(p.x, p.z) : hAt(p.x, p.z),
                    kind, r, trunk, h: kind === 'pine' ? trunk + r * 1.5 : trunk + r * 0.75, rot: rnd() * 6, tint: rnd(),
                    scale: 1 + rnd() * 0.6 });
      }
    } else if (h.theme === 'links'){
      for (let i = 0; i < 90; i++){
        const p = ringPoint(30, 700);
        if (!offSea(p)) continue;
        list.push({ x: p.x, z: p.z, y: hAt(p.x, p.z), kind: 'dune', r: 30 + rnd() * 60, h: 6 + rnd() * 14, rot: rnd() * 6, tint: rnd() });
      }
      for (let i = 0; i < 160; i++){
        const p = ringPoint(-10, 200);
        if (!offSea(p)) continue;
        list.push({ x: p.x, z: p.z, y: hAt(p.x, p.z) + 5.5, kind: 'gorse', r: 1.5 + rnd() * 2, h: 1, rot: rnd() * 6, tint: rnd() });
      }
    } else if (h.theme === 'maple'){
      for (let i = 0; i < 480; i++){
        const p = ringPoint(-12, 420);
        const kind = rnd() < 0.72 ? 'maple' : 'pine';
        const r = kind === 'pine' ? 3.5 + rnd() * 2.5 : 4.5 + rnd() * 3;
        const trunk = kind === 'pine' ? 2 + rnd() : 2.6 + rnd();
        list.push({ x: p.x, z: p.z, y: inside(p) ? h.heightAt(p.x, p.z) : hAt(p.x, p.z),
                    kind, r, trunk, h: kind === 'pine' ? trunk + r * 1.5 : trunk + r * 0.75, rot: rnd() * 6, tint: rnd(),
                    scale: 1 + rnd() * 0.5 });
      }
    } else if (h.theme === 'cay'){
      for (let i = 0; i < 70; i++){
        const p = ringPoint(30, 600);
        if (!offSea(p)) continue;
        list.push({ x: p.x, z: p.z, y: hAt(p.x, p.z), kind: 'dune', r: 25 + rnd() * 50, h: 4 + rnd() * 9, rot: rnd() * 6, tint: rnd() });
      }
      for (let i = 0; i < 240; i++){
        const p = ringPoint(-10, 260);
        if (!offSea(p)) continue;
        const palm = rnd() < 0.75;
        list.push({ x: p.x, z: p.z, y: inside(p) ? h.heightAt(p.x, p.z) : hAt(p.x, p.z), kind: palm ? 'palm' : 'rock',
                    r: palm ? 2.8 + rnd() : 1.5 + rnd() * 2, trunk: 6 + rnd() * 4, h: 1, rot: rnd() * 6, tint: rnd(), scale: 1 + rnd() * 0.3 });
      }
    } else if (h.theme === 'frost'){
      for (let i = 0; i < 420; i++){
        const p = ringPoint(-12, 420);
        const kind = rnd() < 0.85 ? 'spruce' : 'rock';
        const r = kind === 'rock' ? 2 + rnd() * 5 : 3 + rnd() * 2;
        const trunk = 1.2 + rnd();
        list.push({ x: p.x, z: p.z, y: inside(p) ? h.heightAt(p.x, p.z) : hAt(p.x, p.z),
                    kind, r, trunk, h: trunk + r * 1.7, rot: rnd() * 6, tint: rnd(), scale: 1 + rnd() * 0.6 });
      }
    } else {
      for (let i = 0; i < 22; i++){
        const p = ringPoint(250, 1500);
        list.push({ x: p.x, z: p.z, y: hAt(p.x, p.z), kind: 'mesa', r: 50 + rnd() * 110, h: 35 + rnd() * 90, rot: rnd() * 6, tint: rnd() });
      }
      for (let i = 0; i < 260; i++){
        const p = ringPoint(-10, 380);
        const kind = rnd() < 0.55 ? 'cactus' : 'rock';
        list.push({ x: p.x, z: p.z, y: hAt(p.x, p.z) + 6, kind, r: kind === 'rock' ? 1.5 + rnd() * 4 : 0.42,
                    trunk: 2.5 + rnd() * 2.5, h: 1, rot: rnd() * 6, tint: rnd() });
      }
    }
    this.buildTrees(list, this.sceneryGroup, T, 1, false, 'low');     // background trees: the lighter variants

    // horizon: two ridgelines, the far one paler with distance
    const R = THEME_RIDGES[h.theme] || THEME_RIDGES.pines;
    for (const layer of R.layers) this.sceneryGroup.add(ridge(h.seed + layer.salt, cx, cz, layer, T.fog, sea));
    if (sea) this.sceneryGroup.add(this.buildSea(h, sea));
  }

  // links holes run beside the sea: a big plane past one side of the course
  buildSea(h, sea){
    const b = h.bounds;
    const lvl = Math.min(h.heightAt(b.minX, b.minZ), h.heightAt(b.maxX, b.maxZ), h.heightAt(b.minX, b.maxZ), h.heightAt(b.maxX, b.minZ)) - 1.2;
    const nm = this.waterNormal().clone();
    nm.repeat.set(160, 160); nm.userData.shared = false;
    const m = this.waterMaterial({ ...h.T, water: h.T.seaColor || '#3f7486', waterTop: h.T.seaColor || '#3f7486' }, nm, false);
    m.normalScale.set(0.5, 0.5);
    const g = new THREE.PlaneGeometry(9000, 9000);
    g.rotateX(-Math.PI / 2);
    g.setAttribute('aDepth', new THREE.BufferAttribute(new Float32Array(4).fill(20), 1));
    const w = new THREE.Mesh(g, m);
    const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
    const reach = Math.abs(sea.x) * (b.maxX - b.minX) / 2 + Math.abs(sea.z) * (b.maxZ - b.minZ) / 2;
    w.position.set(cx + sea.x * (reach + 4500 + 60), lvl, cz + sea.z * (reach + 4500 + 60));
    this.seaMesh = w;
    return w;
  }

  /* ---- grass tufts in the rough: swaying, faded with distance, and
     cleared around the ball so it is never hidden ---- */
  buildGrass(h, pts){
    this.grass = null;
    if (this.quality !== 'high' || !pts || !pts.length) return;
    const specs = Object.values(THEME_GRASS[h.theme] || THEME_GRASS.pines);
    const cols = specs.map(sp => new THREE.Color(h.T[sp.col] || sp.col).multiplyScalar(sp.k));
    const n = pts.length / 5;
    const mat = this.grassMat || (this.grassMat = grassMaterial(this));
    const inst = new THREE.InstancedMesh(grassGeometry(), mat, n);
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), Sv = new THREE.Vector3(), P = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0), C = new THREE.Color();
    for (let i = 0; i < n; i++){
      const x = pts[i * 5], z = pts[i * 5 + 1], hgt = pts[i * 5 + 2];
      P.set(x, this.groundAt(x, z) - 0.02, z);
      Q.setFromAxisAngle(Y, (x * 12.9898 + z * 78.233) % Math.PI);
      Sv.set(hgt * 1.7, hgt, hgt * 1.7);
      inst.setMatrixAt(i, M.compose(P, Q, Sv));
      inst.setColorAt(i, C.copy(cols[pts[i * 5 + 3]]).multiplyScalar(pts[i * 5 + 4]));
    }
    inst.frustumCulled = false;
    inst.renderOrder = 1;
    this.holeGroup.add(inst);
    this.grass = inst;
  }

  /* ---- green grid & slope flow ---- */
  buildGreenGrid(h){
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.gridPts, 3));
    const m = new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.0, depthWrite: false });
    this.grid = new THREE.LineSegments(g, m);
    this.grid.renderOrder = 4;
    this.holeGroup.add(this.grid);
    this.gridOn = 0;
  }
  setGreenRead(on){ this.gridTarget = on ? 1 : 0; }

  stepFlow(dt){
    const h = this.h;
    if (!h) return;
    const target = this.gridTarget || 0;
    this.gridOn += (target - this.gridOn) * Math.min(1, dt * 5);
    this.grid.material.opacity = this.gridOn * 0.34;
    this.grid.visible = this.gridOn > 0.02;
    this.flow.clear();
    if (this.gridOn < 0.02){ this.flow.commit(); return; }
    const r = this.gReg, rnd = this.flowSeed;
    while (this.flowP.length < 380){
      this.flowP.push({ x: r.minX + rnd() * (r.maxX - r.minX), z: r.minZ + rnd() * (r.maxZ - r.minZ),
                        life: rnd() * 2.5, max: 2.5 });
    }
    for (const p of this.flowP){
      p.life += dt;
      const s = h.surfaceAt(p.x, p.z);
      if (p.life > p.max || (s !== 'green' && s !== 'fringe')){
        p.x = r.minX + rnd() * (r.maxX - r.minX); p.z = r.minZ + rnd() * (r.maxZ - r.minZ); p.life = 0;
        continue;
      }
      const g = gradAt(h, p.x, p.z, 0.2);
      const m = Math.hypot(g.x, g.z);
      const sp = 0.35 + m * 55;
      p.x -= g.x / (m || 1) * sp * dt; p.z -= g.z / (m || 1) * sp * dt;
      const a = Math.sin(Math.PI * p.life / p.max) * this.gridOn;
      // colour by steepness: white (flat) -> cyan -> magenta (fast)
      const st = Math.min(1, m / 0.035);
      this.flow.push(p.x, h.heightAt(p.x, p.z) + 0.03, p.z, 0.75 + st * 0.25, 1 - st * 0.55, 1, a, 5.5);
    }
    this.flow.commit();
  }

  /* ================= ball, tracer, target ================= */
  buildBall(){
    const bm = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.3, metalness: 0 });
    this.ball = new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 22, 16), bm);
    this.ball.renderOrder = 7;
    this.scene.add(this.ball);
    const sm = new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0.35, depthWrite: false,
                                             polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
    this.ballShadow = new THREE.Mesh(new THREE.CircleGeometry(BALL_R * 1.15, 16), sm);
    this.ballShadow.rotation.x = -Math.PI / 2;
    this.ballShadow.renderOrder = 3;
    this.scene.add(this.ballShadow);
    // a glow sprite keeps a distant ball findable
    const cv = document.createElement('canvas'); cv.width = cv.height = 64;
    const c = cv.getContext('2d');
    const grd = c.createRadialGradient(32, 32, 2, 32, 32, 30);
    grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.25, 'rgba(255,255,255,0.55)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = grd; c.fillRect(0, 0, 64, 64);
    const st = new THREE.CanvasTexture(cv);
    this.glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: st, transparent: true, depthWrite: false,
      depthTest: false, sizeAttenuation: false, opacity: 0.0 }));
    this.glow.scale.set(0.03, 0.03, 1);
    this.glow.renderOrder = 9;
    this.scene.add(this.glow);
  }
  // physics runs on the analytic surface; near the ground, draw on the mesh
  visualY(p){
    if (!this.h) return p.y;
    const ga = this.h.heightAt(p.x, p.z), hgt = p.y - ga;
    if (hgt > 1.5) return p.y;
    return p.y + (this.groundAt(p.x, p.z) - ga) * (1 - Math.max(0, hgt) / 1.5);
  }
  placeBall(p, air = 0){
    const cam = this.camera.position;
    const y = this.visualY(p);
    const d = Math.hypot(cam.x - p.x, cam.y - y, cam.z - p.z);
    const s = Math.max(1, Math.min(14, d / 11));
    this.ball.position.set(p.x, y, p.z);
    this.ball.scale.setScalar(s);
    if (this.h){
      const gy = this.groundAt(p.x, p.z);
      this.ballShadow.position.set(p.x, gy + 0.006, p.z);
      const hgt = p.y - gy;
      this.ballShadow.scale.setScalar(s * (1 + hgt * 0.02));
      this.ballShadow.material.opacity = 0.38 * Math.max(0.1, 1 - hgt / 30);
    }
    this.glow.position.set(p.x, y, p.z);
    if (this.grassMat) this.grassMat.userData.u.uBall.value.set(p.x, y, p.z);
    this.glow.material.opacity = Math.min(0.9, Math.max(0, (d - 40) / 120)) * (this.glowBoost || 1);
  }

  buildTracer(){
    const max = 2400;
    this.trMax = max;
    const g = new THREE.BufferGeometry();
    this.trPos = new Float32Array(max * 2 * 3);
    this.trA = new Float32Array(max * 2);
    g.setAttribute('position', new THREE.BufferAttribute(this.trPos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.trA, 1).setUsage(THREE.DynamicDrawUsage));
    const idx = [];
    for (let i = 0; i < max - 1; i++){ const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    g.setIndex(idx);
    this.trColor = { value: new THREE.Color('#ffffff') };
    const m = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { col: this.trColor },
      vertexShader: `attribute float alpha; varying float vA; void main(){ vA = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 col; varying float vA; void main(){ gl_FragColor = vec4(col * vA, vA); }`
    });
    this.tracer = new THREE.Mesh(g, m);
    this.tracer.frustumCulled = false;
    this.tracer.renderOrder = 8;
    g.setDrawRange(0, 0);
    this.scene.add(this.tracer);
    this.trFade = 1;
  }
  // draw the shot's path up to sample index `upto` as a camera-facing ribbon
  setTracer(shot, upto, color, fade = 1){
    const g = this.tracer.geometry;
    if (!shot){ g.setDrawRange(0, 0); return; }
    const s = shot.samples;
    const n = Math.min(this.trMax, Math.floor(upto) + 1, s.length / 3);
    if (color) this.trColor.value.set(color);
    const cam = this.camera.position;
    let pi = 0, ai = 0;
    for (let i = 0; i < n; i++){
      const x = s[i * 3], y = s[i * 3 + 1], z = s[i * 3 + 2];
      const j = Math.min(n - 1, i + 1), h = Math.max(0, i - 1);
      let tx = s[j * 3] - s[h * 3], ty = s[j * 3 + 1] - s[h * 3 + 1], tz = s[j * 3 + 2] - s[h * 3 + 2];
      const vx = cam.x - x, vy = cam.y - y, vz = cam.z - z;
      let ox = ty * vz - tz * vy, oy = tz * vx - tx * vz, oz = tx * vy - ty * vx;
      const oL = Math.hypot(ox, oy, oz) || 1;
      const dist = Math.hypot(vx, vy, vz);
      const w = Math.max(0.012, Math.min(1.3, dist * 0.0026));
      ox = ox / oL * w; oy = oy / oL * w; oz = oz / oL * w;
      this.trPos[pi++] = x + ox; this.trPos[pi++] = y + oy; this.trPos[pi++] = z + oz;
      this.trPos[pi++] = x - ox; this.trPos[pi++] = y - oy; this.trPos[pi++] = z - oz;
      const age = (n - 1 - i);
      const near = Math.min(1, Math.max(0, (dist - 2) / 10));
      const a = (0.25 + 0.75 * Math.min(1, i / 6)) * (age < 3 ? 1 : Math.max(0.35, 1 - age / 900)) * fade * near;
      this.trA[ai++] = a; this.trA[ai++] = a;
    }
    g.setDrawRange(0, Math.max(0, (n - 1) * 6));
    g.attributes.position.needsUpdate = true;
    g.attributes.alpha.needsUpdate = true;
  }

  buildTarget(){
    const segs = 56;
    const g = new THREE.BufferGeometry();
    this.tgPos = new Float32Array((segs + 1) * 2 * 3);
    g.setAttribute('position', new THREE.BufferAttribute(this.tgPos, 3).setUsage(THREE.DynamicDrawUsage));
    const idx = [];
    for (let i = 0; i < segs; i++){ const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    g.setIndex(idx);
    this.tgSegs = segs;
    this.target = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.9,
      depthWrite: false, depthTest: false, side: THREE.DoubleSide, fog: false }));
    this.target.frustumCulled = false;
    this.target.renderOrder = 6;
    this.target.visible = false;
    this.scene.add(this.target);
    // the ghost landing marker for chips uses a second ring
    this.ghost = this.target.clone();
    this.ghost.geometry = g.clone();
    this.ghost.material = this.target.material.clone();
    this.ghost.visible = false;
    this.scene.add(this.ghost);
  }
  setRing(mesh, p, radius, width, color, opacity = 0.9){
    if (!p){ mesh.visible = false; return; }
    mesh.visible = true;
    mesh.material.color.set(color);
    mesh.material.opacity = opacity;
    const arr = mesh.geometry.attributes.position.array;
    const segs = this.tgSegs, h = this.h;
    let k = 0;
    for (let i = 0; i <= segs; i++){
      const a = i / segs * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      for (const r of [radius - width / 2, radius + width / 2]){
        const x = p.x + c * r, z = p.z + s * r;
        arr[k++] = x; arr[k++] = this.groundAt(x, z) + 0.05 + radius * 0.004; arr[k++] = z;
      }
    }
    mesh.geometry.attributes.position.needsUpdate = true;
  }

  /* ================= particles ================= */
  burst(p, n, color, opts = {}){
    const c = new THREE.Color(color);
    for (let i = 0; i < n; i++){
      const a = Math.random() * Math.PI * 2;
      const up = opts.up ?? 4, sp = (opts.speed ?? 3) * (0.4 + Math.random() * 0.8);
      const dir = opts.dir;
      this.particles.push({
        x: p.x, y: p.y + 0.02, z: p.z,
        vx: Math.cos(a) * sp + (dir ? dir.x * (opts.push || 0) : 0),
        vy: up * (0.5 + Math.random() * 0.8),
        vz: Math.sin(a) * sp + (dir ? dir.z * (opts.push || 0) : 0),
        life: 0, max: (opts.life ?? 0.9) * (0.6 + Math.random() * 0.7),
        r: c.r * (0.85 + Math.random() * 0.3), g: c.g * (0.85 + Math.random() * 0.3), b: c.b * (0.85 + Math.random() * 0.3),
        s: (opts.size ?? 4) * (0.6 + Math.random() * 0.8), grav: opts.grav ?? 9, drag: opts.drag ?? 1.5,
        multi: opts.multi
      });
    }
  }
  confetti(p, n = 160){
    const cols = ['#ff5a4f', '#ffd23d', '#3d8bff', '#43d17a', '#ff8ad1', '#ffffff'];
    for (let i = 0; i < n; i++){
      this.burst(p, 1, cols[i % cols.length], { up: 9, speed: 5, life: 2.6, size: 6, grav: 4, drag: 1.2 });
    }
  }
  stepParticles(dt){
    const P = this.particles;
    this.parts.clear();
    for (let i = P.length - 1; i >= 0; i--){
      const p = P[i];
      p.life += dt;
      if (p.life > p.max){ P[i] = P[P.length - 1]; P.pop(); continue; }
      p.vy -= p.grav * dt;
      const k = Math.exp(-p.drag * dt);
      p.vx *= k; p.vy *= k; p.vz *= k;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      if (this.h){
        const gy = this.h.heightAt(p.x, p.z);
        if (p.y < gy){ p.y = gy; p.vy *= -0.2; p.vx *= 0.5; p.vz *= 0.5; }
      }
      const a = 1 - p.life / p.max;
      this.parts.push(p.x, p.y, p.z, p.r, p.g, p.b, Math.min(1, a * 1.6), p.s);
    }
    this.parts.commit();
  }

  /* ================= frame ================= */
  update(dt, windStrength){
    this.t += dt;
    // flag ripple
    if (this.flag){
      const arr = this.flag.geo.attributes.position.array, base = this.flagBase;
      const w = Math.min(1, windStrength / 14);
      const t = this.t;
      for (let i = 0; i < arr.length; i += 3){
        const x = base[i], y = base[i + 1];
        const f = x / 0.62;
        arr[i] = x * (0.35 + 0.65 * Math.max(0.15, w));
        arr[i + 2] = Math.sin(x * 9 - t * (4 + w * 8)) * 0.045 * f * (0.3 + w) + Math.sin(y * 7 + t * 3) * 0.01 * f;
        arr[i + 1] = y - (1 - w) * f * 0.22 * (1 - Math.max(0.15, w));
      }
      this.flag.geo.attributes.position.needsUpdate = true;
      this.flag.geo.computeVertexNormals();
      // scale the flag up with distance so it reads from the tee
      const d = this.camera.position.distanceTo(this.flag.group.position);
      this.flag.group.scale.setScalar(Math.max(1, Math.min(4.5, d / 110)));
    }
    for (const w of this.water || []){
      const nm = w.material.normalMap;
      if (nm){ nm.offset.x = this.t * 0.012; nm.offset.y = this.t * 0.008; }
      if (w.material.userData.u) w.material.userData.u.uTime.value = this.t;
    }
    if (this.clouds) this.clouds.rotation.y += dt * 0.0016;
    if (this.seaMesh){ const nm = this.seaMesh.material.normalMap; nm.offset.x = this.t * 0.004; nm.offset.y = this.t * 0.003; }
    if (this.grassMat){ this.grassMat.userData.u.uTime.value = this.t; this.grassMat.userData.u.uWind.value = Math.min(1.5, 0.25 + windStrength / 14); }
    if (this.sun.castShadow && this.sunDir) this.followShadow();
    this.stepParticles(dt);
    this.stepFlow(dt);
  }
  render(){ this.renderer.render(this.scene, this.camera); }

  // centre the shadow map a little ahead of the camera, snapped to its texels so edges don't crawl
  followShadow(){
    const c = this.camera, f = this.shadowFocus;
    const dir = c.getWorldDirection(_v1); dir.y = 0;
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
    dir.normalize();
    f.copy(c.position).addScaledVector(dir, SHADOW_R * 0.45);
    if (this.h) f.y = this.groundAt(f.x, f.z);
    const d = this.sunDir;
    const right = _v2.set(0, 1, 0).cross(d).normalize(), up = _v3.copy(d).cross(right).normalize();
    const texel = SHADOW_R * 2 / this.sun.shadow.mapSize.x;
    const u = Math.round(f.dot(right) / texel) * texel, v = Math.round(f.dot(up) / texel) * texel, w = f.dot(d);
    f.copy(right).multiplyScalar(u).addScaledVector(up, v).addScaledVector(d, w);
    this.sun.target.position.copy(f);
    this.sun.position.copy(f).addScaledVector(d, 420);
    this.sun.target.updateMatrixWorld();
  }

  project(p){
    const v = new THREE.Vector3(p.x, p.y, p.z).project(this.camera);
    return { x: (v.x + 1) / 2 * window.innerWidth, y: (1 - v.y) / 2 * window.innerHeight, behind: v.z > 1 };
  }
}

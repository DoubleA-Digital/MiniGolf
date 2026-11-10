/* ============================================================
   RENDER — the three.js world: sky, terrain, green, water, trees, flag,
   ball, tracer, previews and particles. Holds no game rules.
   ============================================================ */
import * as THREE from 'three';
import { BALL_R, CUP_R } from './config.js';
import { paintRegion, detailCanvas } from './paint.js';
import { gradAt } from './course.js';
import { mulberry32 } from './noise.js';

/* ---------- shared shader bits ---------- */
function addDetail(mat, detailTex, strength = 0.5){
  mat.customProgramCacheKey = () => 'detail' + strength;
  mat.onBeforeCompile = sh => {
    sh.uniforms.detailMap = { value: detailTex };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nuniform sampler2D detailMap;')
      .replace('#include <map_fragment>', `#include <map_fragment>
        float dd = length(vWPos - cameraPosition);
        float near = 1.0 - smoothstep(6.0, 70.0, dd);
        float d1 = texture2D(detailMap, vWPos.xz * 1.7).r;
        float d2 = texture2D(detailMap, vWPos.xz * 0.21).r;
        float dv = mix(d2, d1, near);
        diffuseColor.rgb *= mix(1.0, dv * 2.0, ${strength.toFixed(2)} * (0.35 + 0.65 * near));`);
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

    // sky dome
    this.skyU = { top: { value: new THREE.Color() }, bottom: { value: new THREE.Color() },
                  sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunCol: { value: new THREE.Color() } };
    const sky = new THREE.Mesh(new THREE.SphereGeometry(7000, 32, 16), new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false, uniforms: this.skyU,
      vertexShader: `varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `varying vec3 vD; uniform vec3 top; uniform vec3 bottom; uniform vec3 sunDir; uniform vec3 sunCol;
        void main(){ float h = clamp(vD.y, -0.2, 1.0);
          vec3 c = mix(bottom, top, pow(max(h, 0.0), 0.55));
          float s = max(dot(normalize(vD), normalize(sunDir)), 0.0);
          c += sunCol * (pow(s, 900.0) * 1.6 + pow(s, 12.0) * 0.12);
          gl_FragColor = vec4(c, 1.0); }`
    }));
    sky.renderOrder = -10;
    this.sky = sky;
    this.scene.add(sky);
    this.scene.fog = new THREE.Fog(0xcccccc, 380, 3200);

    this.detailTex = new THREE.CanvasTexture(detailCanvas(256));
    this.detailTex.wrapS = this.detailTex.wrapT = THREE.RepeatWrapping;
    this.detailTex.colorSpace = THREE.NoColorSpace;
    this.detailTex.anisotropy = 4;

    this.holeGroup = new THREE.Group();
    this.scene.add(this.holeGroup);
    this.sceneryGroup = new THREE.Group();
    this.scene.add(this.sceneryGroup);

    this.buildBall();
    this.buildTracer();
    this.dots = new Dots(400);                       // previews
    this.flow = new Dots(420);                       // green-reading flow
    this.parts = new Dots(900, { order: 6 });       // particles
    this.scene.add(this.dots.obj, this.flow.obj, this.parts.obj);
    this.particles = [];
    this.buildTarget();
    this.others = [];
    this.golfers = [];
    this.resize();
  }

  setQuality(q){
    this.quality = q;
    this.resize();
  }
  resize(){
    const w = window.innerWidth, h = window.innerHeight;
    const pr = Math.min(window.devicePixelRatio || 1, this.quality === 'high' ? 2 : 1.25);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    for (const d of [this.dots, this.flow, this.parts]) if (d) d.mat.uniforms.pr.value = pr;
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
    this.sun.color.set(T.sunColor);
    this.sun.intensity = T.sunI;
    this.hemi.color.set(T.hemi[0]);
    this.hemi.groundColor.set(T.hemi[1]);
    this.hemi.intensity = T.hemi[2];
    this.scene.fog.color.set(T.fog);
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

  buildHole(h){
    this.disposeHole();
    this.h = h;
    const T = h.T;
    this.setTheme(T);
    const b = h.bounds;

    /* ---- surface texture ---- */
    const ppy = this.quality === 'high' ? 2.6 : 1.8;
    const painted = paintRegion(h, b, ppy);
    this.surfaceCanvas = painted.canvas;
    const tex = new THREE.CanvasTexture(painted.canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = false;
    tex.anisotropy = 8;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;

    /* ---- terrain mesh with a far skirt ---- */
    const step = this.quality === 'high' ? 1.5 : 2.2;
    const nx = Math.ceil((b.maxX - b.minX) / step) + 1;
    const nz = Math.ceil((b.maxZ - b.minZ) / step) + 1;
    const cols = nx + 2, rows = nz + 2;
    const pos = new Float32Array(cols * rows * 3);
    const uv = new Float32Array(cols * rows * 2);
    const W = b.maxX - b.minX, D = b.maxZ - b.minZ;
    const SK = 2600;
    let k = 0, u = 0;
    for (let r = 0; r < rows; r++){
      const zi = r === 0 ? b.minZ - SK : r === rows - 1 ? b.maxZ + SK : Math.min(b.maxZ, b.minZ + (r - 1) * step);
      for (let c = 0; c < cols; c++){
        const xi = c === 0 ? b.minX - SK : c === cols - 1 ? b.maxX + SK : Math.min(b.maxX, b.minX + (c - 1) * step);
        const skirt = r === 0 || c === 0 || r === rows - 1 || c === cols - 1;
        pos[k++] = xi;
        pos[k++] = skirt ? h.heightAt(Math.max(b.minX, Math.min(b.maxX, xi)), Math.max(b.minZ, Math.min(b.maxZ, zi))) - 6
                         : h.heightAt(xi, zi);
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
    tg.setIndex(new THREE.BufferAttribute(idx, 1));
    tg.computeVertexNormals();
    const tm = new THREE.MeshLambertMaterial({ map: tex });
    addDetail(tm, this.detailTex, 0.42);
    this.terrain = new THREE.Mesh(tg, tm);
    this.holeGroup.add(this.terrain);

    /* ---- high-res green patch ---- */
    const gr = h.greenRmax + 9;
    const gReg = { minX: h.greenC.x - gr, maxX: h.greenC.x + gr, minZ: h.greenC.z - gr, maxZ: h.greenC.z + gr };
    const gp = paintRegion(h, gReg, 14, { edgeFade: 3, salt: 3 });
    const gtex = new THREE.CanvasTexture(gp.canvas);
    gtex.colorSpace = THREE.SRGBColorSpace; gtex.flipY = false; gtex.anisotropy = 8;
    const gs = 0.33;
    const gn = Math.ceil(gr * 2 / gs) + 1;
    const gpos = new Float32Array(gn * gn * 3), guv = new Float32Array(gn * gn * 2);
    k = 0; u = 0;
    for (let r = 0; r < gn; r++){
      const z = gReg.minZ + Math.min(gr * 2, r * gs);
      for (let c = 0; c < gn; c++){
        const x = gReg.minX + Math.min(gr * 2, c * gs);
        gpos[k++] = x; gpos[k++] = h.heightAt(x, z) + 0.008; gpos[k++] = z;
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
    greenMesh.renderOrder = 1;
    this.holeGroup.add(greenMesh);
    this.gReg = gReg;

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
      wg.computeVertexNormals();
      const wm = new THREE.MeshPhongMaterial({ color: T.waterTop, specular: 0xffffff, shininess: 120,
        transparent: true, opacity: 0.86, normalMap: this.waterNormal(), normalScale: new THREE.Vector2(0.35, 0.35) });
      const w = new THREE.Mesh(wg, wm);
      w.position.set(p.bound.x, p.level, p.bound.z);
      w.renderOrder = 2;
      this.holeGroup.add(w);
      this.water.push(w);
    }

    /* ---- flag, cup, tee markers, stakes ---- */
    this.buildFlag(h);
    this.buildMarkers(h);

    /* ---- trees ---- */
    this.buildTrees(h.trees, this.holeGroup, T, 1);
    this.buildScenery(h);

    /* ---- green grid for reading putts ---- */
    this.buildGreenGrid(h);
    this.flowSeed = mulberry32(h.seed + 99);
    this.flowP = [];
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
    const flagColor = h.theme === 'links' ? '#e63b2e' : h.theme === 'mesa' ? '#ffffff' : '#ffd21f';
    const fm = new THREE.MeshLambertMaterial({ color: flagColor, side: THREE.DoubleSide,
      emissive: new THREE.Color(flagColor), emissiveIntensity: 0.45 });
    const flag = new THREE.Mesh(fg, fm);
    flag.position.y = 2.33 - 0.22;
    const swing = new THREE.Group();
    swing.add(flag);
    g.add(pole, swing);
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
    const col = h.theme === 'links' ? '#2c5fd6' : h.theme === 'mesa' ? '#d84a2a' : '#1d5c2c';
    const mm = new THREE.MeshStandardMaterial({ color: col, roughness: 0.5 });
    const geo = new THREE.SphereGeometry(0.16, 14, 10);
    const tb = h.teeBox;
    for (const side of [-1, 1]){
      const m = new THREE.Mesh(geo, mm);
      const lx = side * 3.2, lz = -tb.hl * 0.3;
      const c = Math.cos(-tb.rot), s = Math.sin(-tb.rot);
      const x = tb.x + lx * c - lz * s, z = tb.z + lx * s + lz * c;
      m.position.set(x, h.heightAt(x, z) + 0.12, z);
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
  treeGeos(){
    if (this._tg) return this._tg;
    const mk = g => { g.userData.shared = true; return g; };
    this._tg = {
      trunk: mk(new THREE.CylinderGeometry(0.16, 0.26, 1, 6).translate(0, 0.5, 0)),
      blob: mk(new THREE.IcosahedronGeometry(1, 1)),
      blob0: mk(new THREE.IcosahedronGeometry(1, 0)),
      cone: mk(new THREE.ConeGeometry(1, 1, 8)),
      cactus: mk(new THREE.CapsuleGeometry(0.3, 1, 3, 8).translate(0, 0.5, 0)),
      arm: mk(new THREE.CapsuleGeometry(0.2, 1, 3, 6).translate(0, 0.5, 0)),
      rock: mk(new THREE.DodecahedronGeometry(1, 0)),
      mesa: mk(new THREE.CylinderGeometry(1, 1.15, 1, 9, 1).translate(0, 0.5, 0)),
      dune: mk(new THREE.SphereGeometry(1, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2))
    };
    return this._tg;
  }
  buildTrees(list, parent, T, scaleAll){
    const G = this.treeGeos();
    const parts = {};                 // key -> [{m, color}]
    const add = (key, geo, mat, m, color) => {
      (parts[key] = parts[key] || { geo, mat, items: [] }).items.push({ m, color });
    };
    const lam = (c, flat) => { const m = new THREE.MeshLambertMaterial({ color: c, flatShading: !!flat }); return m; };
    const mats = this._tm || (this._tm = {
      trunk: lam('#6b4a32'), birchTrunk: lam('#e8e4da'), leaf: lam('#ffffff', true), cactus: lam('#ffffff', true),
      rock: lam('#ffffff', true), mesa: lam('#ffffff', true), dune: lam('#ffffff')
    });
    for (const m of Object.values(mats)) m.userData.shared = true;
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3(), P = new THREE.Vector3();
    const E = new THREE.Euler();
    const comp = (x, y, z, sx, sy, sz, ry = 0, rx = 0, rz = 0) => {
      E.set(rx, ry, rz); Q.setFromEuler(E); S.set(sx, sy, sz); P.set(x, y, z);
      return new THREE.Matrix4().compose(P, Q, S);
    };
    const hsl = (h, s, l) => new THREE.Color().setHSL(h, s, l);
    for (const t of list){
      const sc = (t.scale || 1) * scaleAll;
      const v = t.tint;
      if (t.kind === 'oak'){
        add('trunk', G.trunk, mats.trunk, comp(t.x, t.y, t.z, sc, t.trunk * sc + t.r * 0.4, sc));
        add('leaf', G.blob, mats.leaf, comp(t.x, t.y + t.h * sc, t.z, t.r * sc, t.r * 0.82 * sc, t.r * sc, t.rot),
            hsl(0.27 + v * 0.05, 0.45, 0.26 + v * 0.07));
        add('leaf', G.blob, mats.leaf, comp(t.x + t.r * 0.4 * sc, t.y + (t.h + t.r * 0.35) * sc, t.z - t.r * 0.2 * sc,
            t.r * 0.62 * sc, t.r * 0.55 * sc, t.r * 0.62 * sc, t.rot), hsl(0.26 + v * 0.05, 0.45, 0.3 + v * 0.06));
      } else if (t.kind === 'pine'){
        add('trunk', G.trunk, mats.trunk, comp(t.x, t.y, t.z, sc * 0.8, (t.trunk + t.r) * sc, sc * 0.8));
        const c1 = hsl(0.36 + v * 0.04, 0.42, 0.19 + v * 0.06);
        add('leaf', G.cone, mats.leaf, comp(t.x, t.y + (t.trunk + t.r * 0.9) * sc, t.z, t.r * sc, t.r * 1.9 * sc, t.r * sc, t.rot), c1);
        add('leaf', G.cone, mats.leaf, comp(t.x, t.y + (t.trunk + t.r * 1.95) * sc, t.z, t.r * 0.7 * sc, t.r * 1.5 * sc, t.r * 0.7 * sc, t.rot), c1);
      } else if (t.kind === 'birch'){
        add('birch', G.trunk, mats.birchTrunk, comp(t.x, t.y, t.z, sc * 0.7, (t.trunk + t.r * 0.6) * sc, sc * 0.7));
        add('leaf', G.blob, mats.leaf, comp(t.x, t.y + t.h * sc, t.z, t.r * 0.8 * sc, t.r * 1.15 * sc, t.r * 0.8 * sc, t.rot),
            hsl(0.21 + v * 0.05, 0.5, 0.36 + v * 0.06));
      } else if (t.kind === 'gorse'){
        add('leaf', G.blob, mats.leaf, comp(t.x, t.y + t.r * 0.25, t.z, t.r * sc, t.r * 0.62 * sc, t.r * sc, t.rot),
            v > 0.6 ? hsl(0.14, 0.65, 0.42) : hsl(0.24 + v * 0.04, 0.4, 0.2 + v * 0.05));
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
        add('rock', G.rock, mats.rock, comp(t.x, t.y + t.r * 0.15, t.z, t.r * sc, t.r * 0.62 * sc, t.r * 0.85 * sc, t.rot, v, v * 0.5),
            hsl(0.05 + v * 0.03, 0.45, 0.42 + v * 0.1));
      } else if (t.kind === 'mesa'){
        add('mesa', G.mesa, mats.mesa, comp(t.x, t.y, t.z, t.r, t.h, t.r * (0.8 + v * 0.4), t.rot),
            hsl(0.04 + v * 0.03, 0.5, 0.45 + v * 0.1));
      } else if (t.kind === 'dune'){
        add('dune', G.dune, mats.dune, comp(t.x, t.y - 2, t.z, t.r, t.h, t.r * 0.7, t.rot), hsl(0.17, 0.3, 0.5 + v * 0.08));
      } else {     // palo verde
        add('trunk', G.trunk, mats.trunk, comp(t.x, t.y, t.z, sc * 0.6, (t.trunk + 0.4) * sc, sc * 0.6));
        add('leaf', G.blob0, mats.leaf, comp(t.x, t.y + t.h * sc, t.z, t.r * sc, t.r * 0.45 * sc, t.r * sc, t.rot),
            hsl(0.2 + v * 0.04, 0.45, 0.38));
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
    const hAt = (x, z) => h.heightAt(Math.max(b.minX, Math.min(b.maxX, x)), Math.max(b.minZ, Math.min(b.maxZ, z))) - 6;
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
        list.push({ x: p.x, z: p.z, y: hAt(p.x, p.z), kind: 'dune', r: 30 + rnd() * 60, h: 6 + rnd() * 14, rot: rnd() * 6, tint: rnd() });
      }
      for (let i = 0; i < 160; i++){
        const p = ringPoint(-10, 200);
        list.push({ x: p.x, z: p.z, y: hAt(p.x, p.z) + 5.5, kind: 'gorse', r: 1.5 + rnd() * 2, h: 1, rot: rnd() * 6, tint: rnd() });
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
    this.buildTrees(list, this.sceneryGroup, T, 1);

    // far mountains to give the horizon a shape (no fog, pre-tinted)
    const mcol = new THREE.Color(T.fog).lerp(new THREE.Color(h.theme === 'mesa' ? '#b7745a' : h.theme === 'links' ? '#7f9188' : '#5f8a86'), 0.4);
    const mm = new THREE.MeshBasicMaterial({ color: mcol, fog: false });
    const mg = new THREE.ConeGeometry(1, 1, 7, 1);
    const n = 26;
    const inst = new THREE.InstancedMesh(mg, mm, n);
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3(), P = new THREE.Vector3();
    for (let i = 0; i < n; i++){
      const a = (i / n) * Math.PI * 2 + rnd() * 0.2;
      const d = 4200 + rnd() * 900;
      const hh = 260 + rnd() * 420;
      P.set(cx + Math.cos(a) * d, hh / 2 - 60, cz + Math.sin(a) * d);
      S.set(700 + rnd() * 700, hh, 500 + rnd() * 500);
      Q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * 6);
      inst.setMatrixAt(i, M.compose(P, Q, S));
    }
    this.sceneryGroup.add(inst);
  }

  /* ---- green grid & slope flow ---- */
  buildGreenGrid(h){
    const r = this.gReg, step = 1, sub = 0.25;
    const pts = [];
    const on = (x, z) => { const s = h.surfaceAt(x, z); return s === 'green' || s === 'fringe'; };
    for (let gx = Math.ceil(r.minX); gx <= r.maxX; gx += step){
      for (let z = r.minZ; z < r.maxZ - sub; z += sub){
        if (on(gx, z) && on(gx, z + sub))
          pts.push(gx, h.heightAt(gx, z) + 0.02, z, gx, h.heightAt(gx, z + sub) + 0.02, z + sub);
      }
    }
    for (let gz = Math.ceil(r.minZ); gz <= r.maxZ; gz += step){
      for (let x = r.minX; x < r.maxX - sub; x += sub){
        if (on(x, gz) && on(x + sub, gz))
          pts.push(x, h.heightAt(x, gz) + 0.02, gz, x + sub, h.heightAt(x + sub, gz) + 0.02, gz);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
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
    const sm = new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0.35, depthWrite: false });
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
  placeBall(p, air = 0){
    const cam = this.camera.position;
    const d = cam.distanceTo(new THREE.Vector3(p.x, p.y, p.z));
    const s = Math.max(1, Math.min(14, d / 11));
    this.ball.position.set(p.x, p.y, p.z);
    this.ball.scale.setScalar(s);
    if (this.h){
      const gy = this.h.heightAt(p.x, p.z);
      this.ballShadow.position.set(p.x, gy + 0.01, p.z);
      const hgt = p.y - gy;
      this.ballShadow.scale.setScalar(s * (1 + hgt * 0.02));
      this.ballShadow.material.opacity = 0.38 * Math.max(0.1, 1 - hgt / 30);
    }
    this.glow.position.set(p.x, p.y, p.z);
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
      const w = Math.max(0.015, Math.min(1.6, dist * 0.0032));
      ox = ox / oL * w; oy = oy / oL * w; oz = oz / oL * w;
      this.trPos[pi++] = x + ox; this.trPos[pi++] = y + oy; this.trPos[pi++] = z + oz;
      this.trPos[pi++] = x - ox; this.trPos[pi++] = y - oy; this.trPos[pi++] = z - oz;
      const age = (n - 1 - i);
      const a = (0.25 + 0.75 * Math.min(1, i / 6)) * (age < 3 ? 1 : Math.max(0.35, 1 - age / 900)) * fade;
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
      depthWrite: false, side: THREE.DoubleSide, fog: false }));
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
        arr[k++] = x; arr[k++] = h.heightAt(x, z) + 0.06 + radius * 0.004; arr[k++] = z;
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
    }
    this.stepParticles(dt);
    this.stepFlow(dt);
  }
  render(){ this.renderer.render(this.scene, this.camera); }

  project(p){
    const v = new THREE.Vector3(p.x, p.y, p.z).project(this.camera);
    return { x: (v.x + 1) / 2 * window.innerWidth, y: (1 - v.y) / 2 * window.innerHeight, behind: v.z > 1 };
  }
}

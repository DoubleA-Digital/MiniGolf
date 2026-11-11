/* ============================================================
   GOLFER — a stylized player whose swing is driven by a single number:
     s < 0  backswing (s = -1 is the top)
     s > 0  follow-through (s = 1 is the finish)
   Local frame: the ball is at the origin, the target is down -z and a
   right-handed golfer stands on the -x side facing +x.

   The body is a connected skeleton: the club sets where the hands are,
   two-bone IK joins the hands to the shoulders and the hips to the feet,
   so nothing can come apart however far the body turns.
   ============================================================ */
import * as THREE from 'three';

const CLUB_SPECS = {
  driver: { L: 1.22, lie: 55, head: 'wood',   arms: 146, hinge: 104, turn: 92, stance: 0.24 },
  wood:   { L: 1.16, lie: 56, head: 'wood',   arms: 143, hinge: 102, turn: 88, stance: 0.22 },
  iron:   { L: 1.03, lie: 61, head: 'iron',   arms: 138, hinge: 98,  turn: 84, stance: 0.2 },
  wedge:  { L: 0.97, lie: 63, head: 'wedge',  arms: 130, hinge: 95,  turn: 76, stance: 0.17 },
  putter: { L: 0.95, lie: 71, head: 'putter', arms: 0,   hinge: 0,   turn: 0,  stance: 0.15 }
};

export function clubKind(id){
  if (id === 'D') return 'driver';
  if (id === '3W' || id === '5W' || id === '4H') return 'wood';
  if (id === 'P') return 'putter';
  if (['PW', 'GW', 'SW', 'LW'].includes(id)) return 'wedge';
  return 'iron';
}

// limb lengths (yards)
const UPPER = 0.365, FORE = 0.335, THIGH = 0.47, SHIN = 0.46;
const NECK = 0.075, HEAD_R = 0.112;

let shadowTex = null;
function blobTexture(){
  if (shadowTex) return shadowTex;
  const cv = document.createElement('canvas'); cv.width = cv.height = 64;
  const c = cv.getContext('2d');
  const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(0.45, 'rgba(0,0,0,0.6)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = g; c.fillRect(0, 0, 64, 64);
  shadowTex = new THREE.CanvasTexture(cv);
  return shadowTex;
}

const ease = x => x * x * (3 - 2 * x);
const clamp01 = x => x < 0 ? 0 : x > 1 ? 1 : x;
const DEG = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0), YAXIS = UP, ZAXIS = new THREE.Vector3(0, 0, 1);

/* two-bone IK: the middle joint for a chain a -> target, bending toward `pole`.
   Out of reach, the chain straightens and the limbs stretch a touch. */
function solveIK(a, target, l1, l2, pole, out){
  const d = new THREE.Vector3().subVectors(target, a);
  const dist = d.length();
  d.divideScalar(dist || 1);
  if (dist >= l1 + l2 - 1e-4) return out.copy(a).addScaledVector(d, dist * l1 / (l1 + l2));
  const x = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
  const h = Math.sqrt(Math.max(0, l1 * l1 - x * x));
  const perp = pole.clone().addScaledVector(d, -pole.dot(d));
  if (perp.lengthSq() < 1e-8) perp.set(1, 0, 0).addScaledVector(d, -d.x);
  perp.normalize();
  return out.copy(a).addScaledVector(d, x).addScaledVector(perp, h);
}

export function createGolfer(color, skin){
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  const mat = (c, r = 0.85) => new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: 0 });
  const shirt = mat(color, 0.8);
  const shirtDark = mat(new THREE.Color(color).multiplyScalar(0.78), 0.8);
  const pants = mat('#2d3442', 0.9);
  const skinM = mat(skin || '#d9a57e', 0.7);
  const white = mat('#f4f4f2', 0.6);
  const shoe = mat('#f2f2f2', 0.5);
  const sole = mat('#30343c', 0.7);
  const metal = new THREE.MeshStandardMaterial({ color: '#c9ced6', roughness: 0.28, metalness: 0.85 });
  const black = new THREE.MeshStandardMaterial({ color: '#1b1d22', roughness: 0.35, metalness: 0.4 });

  // a unit capsule that `span` stretches between two points
  function limb(r, m, segs = 10){
    const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(r, 1, 4, segs), m);
    mesh.userData.r = r;
    body.add(mesh);
    return mesh;
  }
  const dTmp = new THREE.Vector3();
  function span(mesh, a, b){
    dTmp.subVectors(b, a);
    const len = Math.max(0.01, dTmp.length());
    mesh.position.copy(a).addScaledVector(dTmp, 0.5);
    mesh.scale.set(1, len / (1 + mesh.userData.r * 2), 1);
    mesh.quaternion.setFromUnitVectors(UP, dTmp.divideScalar(len));
  }
  const ball = (r, m, parent = body, segs = 12) => {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, segs, Math.max(6, segs * 0.75 | 0)), m);
    parent.add(mesh);
    return mesh;
  };

  /* ---- legs ---- */
  const thighL = limb(0.082, pants), thighR = limb(0.082, pants);
  const shinL = limb(0.064, pants), shinR = limb(0.064, pants);
  const kneeL = ball(0.07, pants), kneeR = ball(0.07, pants);
  const ankleL = ball(0.048, pants, body, 8), ankleR = ball(0.048, pants, body, 8);
  function makeFoot(){
    const g = new THREE.Group();             // pivots at the toe
    g.rotation.order = 'YZX';
    const geo = new THREE.CapsuleGeometry(0.047, 0.15, 4, 10);
    geo.rotateZ(Math.PI / 2);
    geo.scale(1, 0.72, 1.05);
    const upper = new THREE.Mesh(geo, shoe);
    upper.position.set(-0.085, 0.03, 0);
    const sl = new THREE.Mesh(new THREE.BoxGeometry(0.23, 0.014, 0.085), sole);
    sl.position.set(-0.085, 0.007, 0);
    g.add(upper, sl);
    body.add(g);
    return g;
  }
  const footL = makeFoot(), footR = makeFoot();

  /* ---- hips ---- */
  const hips = limb(0.128, pants, 12);
  const belt = new THREE.Mesh(new THREE.CylinderGeometry(0.133, 0.133, 0.035, 18), mat('#1b1d22', 0.5));
  belt.scale.set(0.95, 1, 1.62);
  body.add(belt);

  /* ---- torso: pivots at the pelvis, tilts toward the ball and turns about the spine ---- */
  const spine = new THREE.Group();
  body.add(spine);
  const abdomen = new THREE.Mesh(new THREE.CapsuleGeometry(0.14, 0.24, 4, 12), shirt);
  abdomen.scale.set(0.9, 1, 1.3);
  const chest = new THREE.Mesh(new THREE.CapsuleGeometry(0.155, 0.22, 4, 12), shirt);
  chest.scale.set(0.88, 1, 1.32);
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.062, 0.085, 0.06, 12), shirtDark);
  const delL = ball(0.07, shirt, spine), delR = ball(0.07, shirt, spine);
  spine.add(abdomen, chest, collar);

  /* ---- neck and head ---- */
  const neck = limb(0.048, skinM, 8);
  const head = new THREE.Group();           // +z looks where the eyes look
  const skull = ball(HEAD_R, skinM, head, 16);
  skull.scale.set(0.94, 1.04, 1);
  const capTop = new THREE.Mesh(new THREE.SphereGeometry(HEAD_R * 1.07, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.5), white);
  capTop.position.y = 0.018;
  const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.012, 16, 1, false, -Math.PI / 2, Math.PI), white);
  brim.scale.set(0.95, 1, 0.9);
  brim.rotation.y = -Math.PI / 2;
  brim.position.set(0, 0.03, 0.07);
  const nose = ball(0.022, skinM, head, 8);
  nose.position.set(0, -0.015, HEAD_R * 0.98);
  const earL = ball(0.024, skinM, head, 8), earR = ball(0.024, skinM, head, 8);
  earL.position.set(-HEAD_R * 0.95, -0.01, 0); earR.position.set(HEAD_R * 0.95, -0.01, 0);
  head.add(capTop, brim);
  body.add(head);

  /* ---- arms ---- */
  const sleeveL = limb(0.06, shirt), sleeveR = limb(0.06, shirt);
  const upperL = limb(0.046, skinM), upperR = limb(0.046, skinM);
  const foreL = limb(0.041, skinM), foreR = limb(0.041, skinM);
  const elbowL = ball(0.045, skinM, body, 8), elbowR = ball(0.045, skinM, body, 8);
  const handL = ball(0.05, white, body, 10), handR = ball(0.047, skinM, body, 10);
  handL.scale.set(1, 1.25, 1); handR.scale.set(1, 1.2, 1);

  /* ---- club: the group pivots at the hands and points down to the head ---- */
  const clubG = new THREE.Group();
  body.add(clubG);
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.011, 1, 6), metal);
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.014, 0.28, 8), black);
  clubG.add(shaft, grip);
  const heads = {
    wood:   new THREE.Mesh(new THREE.SphereGeometry(0.07, 14, 10), black),
    iron:   new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.06, 0.025), metal),
    wedge:  new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.065, 0.025), metal),
    putter: new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.035, 0.04), metal)
  };
  heads.wood.scale.set(1.25, 0.6, 1);
  for (const k in heads){ heads[k].visible = false; clubG.add(heads[k]); }

  /* ---- a soft shadow that follows the ground ---- */
  const shGeo = new THREE.PlaneGeometry(1, 1, 6, 6);
  shGeo.rotateX(-Math.PI / 2);
  const shadow = new THREE.Mesh(shGeo, new THREE.MeshBasicMaterial({ map: blobTexture(), color: 0x000000,
    transparent: true, opacity: 0.32, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }));
  shadow.renderOrder = 2;
  root.add(shadow);
  const shBase = Float32Array.from(shGeo.attributes.position.array);

  root.traverse(o => { if (o.isMesh){ o.frustumCulled = false; if (o !== shadow) o.castShadow = true; } });

  const state = { spec: CLUB_SPECS.iron, kind: 'iron', S: new THREE.Vector3(), hands0: new THREE.Vector3(),
                  axis: new THREE.Vector3(), pelvis0: new THREE.Vector3(), ankleX: 0,
                  s: 0, style: 'full', idleT: 0, stretch: 1 };
  let ground = null, groundKey = '';
  const off = { L: 0, R: 0 };

  function setGround(fn){ ground = fn; groundKey = ''; }
  // world height under a point of the golfer's local frame, relative to the root
  function groundOff(lx, lz){
    if (!ground) return 0;
    const th = root.rotation.y, c = Math.cos(th), s = Math.sin(th);
    const wx = root.position.x + lx * c + lz * s, wz = root.position.z - lx * s + lz * c;
    return Math.max(-0.3, Math.min(0.3, ground(wx, wz) - root.position.y));
  }
  function settle(){
    const key = `${root.position.x.toFixed(3)}|${root.position.z.toFixed(3)}|${root.rotation.y.toFixed(4)}|${state.kind}`;
    if (key === groundKey) return;
    groundKey = key;
    const st = state.spec.stance;
    off.L = groundOff(state.ankleX, -st);
    off.R = groundOff(state.ankleX, st);
    // stretch the shadow over the stance and lay it on the turf
    const arr = shGeo.attributes.position.array;
    const cx = state.ankleX - 0.12, sx = 1.25, sz = 1.25 + st * 2.4;
    for (let i = 0; i < arr.length; i += 3){
      const x = cx + shBase[i] * sx, z = shBase[i + 2] * sz;
      arr[i] = x; arr[i + 2] = z;
      arr[i + 1] = groundOff(x, z) + 0.012;
    }
    shGeo.attributes.position.needsUpdate = true;
  }

  function setClub(kind){
    const sp = CLUB_SPECS[kind] || CLUB_SPECS.iron;
    state.spec = sp; state.kind = kind;
    const lie = sp.lie * Math.PI / 180;
    // hands at address, from the club's length and lie
    const hands = new THREE.Vector3(-Math.cos(lie) * sp.L, Math.sin(lie) * sp.L, 0);
    // shoulders a little behind and well above the hands: the arms hang
    const S = new THREE.Vector3(hands.x - 0.2, hands.y + 0.55, 0);
    state.S.copy(S); state.hands0.copy(hands);
    // pelvis behind the shoulders (bent from the hips), feet under the shoulders
    state.pelvis0.set(S.x - 0.42, 0.93, 0);
    state.ankleX = S.x - 0.02;
    const sv = new THREE.Vector3().subVectors(S, state.pelvis0);
    spine.userData.tilt = Math.atan2(sv.x, sv.y);
    spine.userData.len = sv.length();
    const len = sv.length();
    abdomen.position.y = 0.2;
    chest.position.y = len - 0.17;
    collar.position.set(0.01, len + 0.03, 0);
    delL.position.set(-0.01, len - 0.03, -0.19);
    delR.position.set(-0.01, len - 0.03, 0.19);

    // swing plane: contains the target line and the ball-to-shoulder line
    state.axis.crossVectors(ZAXIS, S.clone().normalize()).normalize();

    const L = sp.L;
    shaft.scale.set(1, L, 1);
    shaft.position.set(0, -L / 2, 0);
    grip.position.set(0, -0.12, 0);
    for (const k in heads) heads[k].visible = false;
    const hm = heads[sp.head];
    hm.visible = true;
    hm.position.set(0, -L, 0);
    groundKey = '';
    pose(state.s, state.style);
  }

  // scratch
  const v = () => new THREE.Vector3();
  const pelvis = v(), hipL = v(), hipR = v(), knee = v(), aL = v(), aR = v(), toe = v(), pole = v();
  const shL = v(), shR = v(), neckBase = v(), headC = v(), look = v(), spineDir = v();
  const hc = v(), gL = v(), gR = v(), el = v(), sleeveEnd = v(), tmp = v();
  const qRig = new THREE.Quaternion(), qHinge = new THREE.Quaternion(), qAddr = new THREE.Quaternion();
  const qTilt = new THREE.Quaternion(), qTurn = new THREE.Quaternion(), qHip = new THREE.Quaternion();
  const mLook = new THREE.Matrix4();
  const addressDir = v();
  const SOLE = new THREE.Vector3(-0.02, 0, 0.075);

  /* opts.down: this is the downswing from opts.top — the hips lead and the
     wrists hold their hinge, so the club whips through instead of retracing. */
  function pose(s, style, opts){
    state.s = s; state.style = style;
    settle();
    const sp = state.spec;
    let A = sp.arms, H = sp.hinge, Tn = sp.turn, bw = 1;
    if (style === 'chip'){ A *= 0.62; H *= 0.65; Tn *= 0.45; bw = 0.35; }
    if (style === 'putt'){ A = 22; H = 0; Tn = 6; bw = 0; }

    const back = Math.max(0, -s), thru = Math.max(0, s);
    const upHinge = b => H * ease(clamp01((b - 0.2) / 0.8));
    let armAng, hinge, turn, hipFrac;
    if (back > 0){
      armAng = A * Math.min(1.1, back);
      turn = Tn * Math.min(1.1, back);
      hinge = upHinge(back);
      hipFrac = 0.45;
      if (opts && opts.down && opts.top > 0.05){
        const top = opts.top;
        hinge = upHinge(top) * ease(clamp01((back - 0.04) / Math.max(0.1, top * 0.6)));
        hipFrac = 0.45 * Math.pow(Math.min(1, back / top), 0.8);
      }
    } else {
      armAng = -(style === 'putt' ? A * 1.1 : A * 1.12) * thru;
      hinge = -H * 1.1 * ease(clamp01((thru - 0.25) / 0.75));
      turn = -(Tn * 1.15) * thru;
      hipFrac = 0.45 + 0.3 * ease(clamp01(thru * 1.4));
    }

    /* ---- pelvis: shifts back, then fires toward the target ---- */
    const fin = ease(clamp01(thru));
    pelvis.copy(state.pelvis0);
    pelvis.z += bw * (0.025 * Math.min(1, back) - 0.08 * fin);
    pelvis.y += bw * 0.025 * fin;
    const hipYaw = -turn * hipFrac * DEG;
    qHip.setFromAxisAngle(YAXIS, hipYaw);
    hipL.set(0, -0.05, -0.1).applyQuaternion(qHip).add(pelvis);
    hipR.set(0, -0.05, 0.1).applyQuaternion(qHip).add(pelvis);
    span(hips, hipL, hipR);
    belt.position.set(pelvis.x, pelvis.y + 0.035, pelvis.z);
    belt.rotation.y = hipYaw;

    /* ---- legs: feet planted, the trail heel comes up on the way through ---- */
    const st = sp.stance;
    const lift = bw * ease(clamp01((thru - 0.3) / 0.55));
    aL.set(state.ankleX, 0.075 + off.L, -st);
    footL.position.set(state.ankleX + 0.11, 0.025 + off.L, -st);
    footL.rotation.set(0, 0, 0);
    toe.set(state.ankleX + 0.11, 0.025 + off.R, st - 0.05 * lift);
    footR.position.copy(toe);
    footR.rotation.set(0, 0.75 * lift, -0.95 * lift);
    aR.set(-0.11, 0.05, 0).applyEuler(footR.rotation).add(toe);
    // the lead knee kicks in on the backswing; the trail knee drives through
    pole.set(1, 0, -0.25 + 0.5 * bw * Math.min(1, back)).normalize();
    solveIK(hipL, aL, THIGH, SHIN, pole, knee);
    span(thighL, hipL, knee); span(shinL, knee, aL); kneeL.position.copy(knee); ankleL.position.copy(aL);
    pole.set(1, 0, 0.25 - 1.4 * lift).normalize();
    solveIK(hipR, aR, THIGH, SHIN, pole, knee);
    span(thighR, hipR, knee); span(shinR, knee, aR); kneeR.position.copy(knee); ankleR.position.copy(aR);

    /* ---- torso: tilt toward the ball (straightening in the finish), turn about the spine ---- */
    const tilt = (spine.userData.tilt || 0) * (1 - (style === 'full' ? 0.5 : style === 'chip' ? 0.15 : 0) * fin);
    const len = spine.userData.len || 0.7;
    qTilt.setFromAxisAngle(ZAXIS, -tilt);
    qTurn.setFromAxisAngle(YAXIS, -turn * DEG);
    spine.position.copy(pelvis);
    spine.quaternion.copy(qTilt).multiply(qTurn);
    spine.updateMatrix();
    shL.set(-0.01, len - 0.03, -0.19).applyMatrix4(spine.matrix);
    shR.set(-0.01, len - 0.03, 0.19).applyMatrix4(spine.matrix);
    spineDir.set(0, 1, 0).applyQuaternion(qTilt);
    neckBase.copy(spineDir).multiplyScalar(len + 0.04).add(pelvis);

    /* ---- hands and club: the arms swing about the plane axis through the shoulders ---- */
    qRig.setFromAxisAngle(state.axis, armAng * DEG);
    hc.copy(state.hands0).sub(state.S).applyQuaternion(qRig).add(state.S);
    // keep the hands moving with the body as the pelvis slides
    hc.x += pelvis.x - state.pelvis0.x; hc.z += pelvis.z - state.pelvis0.z; hc.y += pelvis.y - state.pelvis0.y;
    addressDir.copy(SOLE).sub(state.hands0).normalize();
    qAddr.setFromUnitVectors(tmp.set(0, -1, 0), addressDir);
    qHinge.setFromAxisAngle(state.axis, hinge * DEG);
    clubG.position.copy(hc);
    clubG.quaternion.copy(qRig).multiply(qHinge).multiply(qAddr);
    gL.set(0, -0.035, 0).applyQuaternion(clubG.quaternion).add(hc);
    gR.set(0, -0.115, 0).applyQuaternion(clubG.quaternion).add(hc);
    handL.position.copy(gL); handL.quaternion.copy(clubG.quaternion);
    handR.position.copy(gR); handR.quaternion.copy(clubG.quaternion);

    // arms: elbows point down at the hips
    let worst = 1;
    const arm = (sh, g, upperM, sleeveM, foreM, elbowM, side) => {
      pole.set(-0.35, -1, side * 0.35).normalize();
      solveIK(sh, g, UPPER, FORE, pole, el);
      span(upperM, sh, el); span(foreM, el, g);
      sleeveEnd.copy(sh).lerp(el, 0.5);
      span(sleeveM, sh, sleeveEnd);
      elbowM.position.copy(el);
      worst = Math.max(worst, sh.distanceTo(g) / (UPPER + FORE));
    };
    arm(shL, gL, upperL, sleeveL, foreL, elbowL, -1);
    arm(shR, gR, upperR, sleeveR, foreR, elbowR, 1);
    state.stretch = worst;

    /* ---- head: steady over the ball, then turns to watch it go ---- */
    const watch = ease(clamp01((thru - 0.2) / 0.6));
    headC.copy(spineDir).multiplyScalar(NECK + HEAD_R * 0.9).add(neckBase);
    headC.x += 0.03;
    look.set(0, 0, 0).lerp(tmp.set(1.2, 0.4 + 0.8 * fin, -14), watch);
    if (style === 'putt') look.set(0, 0, -0.6 * watch);
    head.position.copy(headC);
    mLook.lookAt(look, headC, UP);
    head.quaternion.setFromRotationMatrix(mLook);
    span(neck, tmp.copy(spineDir).multiplyScalar(len - 0.05).add(pelvis), headC);
  }

  function update(dt, idle){
    if (!idle) return;
    state.idleT += dt;
    // gentle waggle while addressing the ball
    const w = Math.sin(state.idleT * 2.1) * 0.03 * (state.style === 'putt' ? 0.3 : 1);
    pose(-Math.max(0, w), state.style);
  }

  setClub('iron');
  return { group: root, setClub, pose, update, state, shirt, setGround };
}

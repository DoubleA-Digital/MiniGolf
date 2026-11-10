/* ============================================================
   GOLFER — a stylized player whose swing is driven by a single number:
     s < 0  backswing (s = -1 is the top)
     s > 0  follow-through (s = 1 is the finish)
   Local frame: the ball is at the origin, the target is down -z and a
   right-handed golfer stands on the -x side facing +x.
   ============================================================ */
import * as THREE from 'three';

const CLUB_SPECS = {
  driver: { L: 1.22, lie: 55, head: 'wood',   arms: 146, hinge: 104, turn: 92 },
  wood:   { L: 1.16, lie: 56, head: 'wood',   arms: 143, hinge: 102, turn: 88 },
  iron:   { L: 1.03, lie: 61, head: 'iron',   arms: 138, hinge: 98, turn: 84 },
  wedge:  { L: 0.97, lie: 63, head: 'wedge',  arms: 130, hinge: 95, turn: 76 },
  putter: { L: 0.95, lie: 71, head: 'putter', arms: 0,   hinge: 0,  turn: 0 }
};

export function clubKind(id){
  if (id === 'D') return 'driver';
  if (id === '3W' || id === '5W' || id === '4H') return 'wood';
  if (id === 'P') return 'putter';
  if (['PW', 'GW', 'SW', 'LW'].includes(id)) return 'wedge';
  return 'iron';
}

export function createGolfer(color, skin){
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  const mat = (c, r = 0.85) => new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: 0 });
  const shirt = mat(color, 0.8);
  const shirtDark = mat(new THREE.Color(color).multiplyScalar(0.72), 0.8);
  const pants = mat('#2d3442', 0.9);
  const skinM = mat(skin || '#d9a57e', 0.7);
  const white = mat('#f4f4f2', 0.6);
  const shoe = mat('#f2f2f2', 0.5);
  const metal = new THREE.MeshStandardMaterial({ color: '#c9ced6', roughness: 0.28, metalness: 0.85 });
  const black = new THREE.MeshStandardMaterial({ color: '#1b1d22', roughness: 0.35, metalness: 0.4 });

  const cap = (r, len, m, segs = 8) => new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 4, segs), m);
  // a capsule spanning two points
  function limb(r, m){
    const g = new THREE.CapsuleGeometry(r, 1, 4, 8);
    const mesh = new THREE.Mesh(g, m);
    mesh.userData.r = r;
    return mesh;
  }
  const up = new THREE.Vector3(0, 1, 0);
  function span(mesh, a, b){
    const d = new THREE.Vector3().subVectors(b, a);
    const len = Math.max(0.01, d.length());
    mesh.position.copy(a).addScaledVector(d, 0.5);
    mesh.scale.set(1, len / (1 + mesh.userData.r * 2) , 1);
    mesh.quaternion.setFromUnitVectors(up, d.normalize());
  }

  // legs and hips (body frame)
  const legL = limb(0.075, pants), legR = limb(0.075, pants);
  const footGeo = new THREE.CapsuleGeometry(0.048, 0.16, 4, 10);
  footGeo.rotateZ(Math.PI / 2);
  footGeo.scale(1, 0.75, 1);
  const footL = new THREE.Mesh(footGeo, shoe);
  const footR = footL.clone();
  const belt = new THREE.Mesh(new THREE.CylinderGeometry(0.165, 0.165, 0.04, 14), mat('#1b1d22', 0.5));
  const hips = cap(0.15, 0.2, pants);
  hips.rotation.x = Math.PI / 2;
  body.add(legL, legR, footL, footR, hips, belt);

  // torso pivots at the hips and turns about the spine
  const spine = new THREE.Group();
  body.add(spine);
  const torso = cap(0.17, 0.36, shirt, 10);
  torso.position.y = 0.32;
  const shoulders = cap(0.1, 0.36, shirtDark);
  shoulders.rotation.x = Math.PI / 2;
  shoulders.position.y = 0.55;
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.06, 10), shirt);
  collar.position.y = 0.66;
  spine.add(torso, shoulders, collar);

  // head stays steady over the ball
  const head = new THREE.Group();
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.115, 16, 12), skinM);
  const capTop = new THREE.Mesh(new THREE.SphereGeometry(0.122, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), white);
  capTop.position.y = 0.02;
  const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.015, 16, 1, false, -Math.PI / 2, Math.PI), white);
  brim.position.set(0.06, 0.03, 0);
  brim.scale.set(1.1, 1, 1);
  head.add(skull, capTop, brim);
  body.add(head);

  // arms + club rotate together about the swing-plane axis through the shoulders
  const rig = new THREE.Group();
  body.add(rig);
  const armL = limb(0.055, shirt), armR = limb(0.055, shirt);
  const foreL = limb(0.045, skinM), foreR = limb(0.045, skinM);
  const glove = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), white);
  rig.add(armL, armR, foreL, foreR, glove);

  const clubG = new THREE.Group();            // pivots at the hands
  rig.add(clubG);
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

  // a soft blob shadow on the ground
  const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.55, 24),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.scale.set(1.3, 0.8, 1);
  root.add(shadow);

  root.traverse(o => { if (o.isMesh) o.frustumCulled = false; });

  const state = { spec: CLUB_SPECS.iron, kind: 'iron', S: new THREE.Vector3(), hands0: new THREE.Vector3(),
                  axis: new THREE.Vector3(), s: 0, style: 'full', idleT: 0 };
  const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3(), q = new THREE.Quaternion();

  function setClub(kind){
    const sp = CLUB_SPECS[kind] || CLUB_SPECS.iron;
    state.spec = sp; state.kind = kind;
    const lie = sp.lie * Math.PI / 180;
    // hands at address, from the club's length and lie
    const hands = new THREE.Vector3(-Math.cos(lie) * sp.L, Math.sin(lie) * sp.L, 0);
    const Sy = 1.5, armLen = 0.66;
    const drop = Sy - hands.y;
    const horiz = Math.sqrt(Math.max(0.01, armLen * armLen - drop * drop));
    const S = new THREE.Vector3(hands.x - horiz, Sy, 0);
    state.S.copy(S); state.hands0.copy(hands);

    // body: pelvis behind and below the shoulders
    const pelvis = new THREE.Vector3(S.x - 0.27, 0.98, 0);
    const feetX = pelvis.x + 0.08;
    span(legL, new THREE.Vector3(pelvis.x, pelvis.y - 0.05, -0.12), new THREE.Vector3(feetX + 0.06, 0.08, -0.2));
    span(legR, new THREE.Vector3(pelvis.x, pelvis.y - 0.05, 0.12), new THREE.Vector3(feetX + 0.06, 0.08, 0.2));
    footL.position.set(feetX + 0.1, 0.04, -0.2);
    footR.position.set(feetX + 0.1, 0.04, 0.2);
    hips.position.copy(pelvis);
    belt.position.set(pelvis.x, pelvis.y + 0.1, 0);
    spine.position.copy(pelvis);
    // tilt the spine toward the ball so the shoulders sit at S
    const sv = new THREE.Vector3().subVectors(S, pelvis);
    spine.userData.tilt = Math.atan2(sv.x, sv.y);
    spine.userData.len = sv.length();
    torso.position.y = sv.length() * 0.45;
    shoulders.position.y = sv.length() * 0.92;
    collar.position.y = sv.length() + 0.03;
    head.position.set(S.x + 0.1, S.y + 0.2, 0);
    head.rotation.z = -0.5;

    // swing plane: contains the target line and the ball-to-shoulder line
    state.axis.crossVectors(new THREE.Vector3(0, 0, 1), S.clone().normalize()).normalize();
    rig.position.copy(S);

    // club geometry (in the club group's frame, hands at origin pointing to the head)
    const L = sp.L;
    shaft.scale.set(1, L, 1);
    shaft.position.set(0, -L / 2, 0);
    grip.position.set(0, -0.12, 0);
    for (const k in heads) heads[k].visible = false;
    const hm = heads[sp.head];
    hm.visible = true;
    hm.position.set(0, -L, 0);
    pose(state.s, state.style);
  }

  // the club group points from hands to head; the head soles just behind the ball
  const addressDir = new THREE.Vector3();
  const SOLE = new THREE.Vector3(-0.02, 0, 0.075);
  function pose(s, style){
    state.s = s; state.style = style;
    const sp = state.spec;
    let A = sp.arms, H = sp.hinge, Tn = sp.turn;
    if (style === 'chip'){ A *= 0.62; H *= 0.65; Tn *= 0.45; }
    if (style === 'putt'){ A = 22; H = 0; Tn = 6; }

    const back = Math.max(0, -s), thru = Math.max(0, s);
    const ease = x => x * x * (3 - 2 * x);
    let armAng, hinge, turn;
    if (back > 0){
      armAng = A * Math.min(1.1, back);
      hinge = H * ease(Math.min(1, Math.max(0, (back - 0.2) / 0.8)));
      turn = Tn * Math.min(1.1, back);
    } else {
      armAng = -(style === 'putt' ? A * 1.1 : A * 1.12) * thru;
      hinge = -H * 1.1 * ease(Math.min(1, Math.max(0, (thru - 0.25) / 0.75)));
      turn = -(Tn * 1.15) * thru;
    }
    const DEG = Math.PI / 180;
    // rotate the whole arm rig about the plane axis
    rig.quaternion.setFromAxisAngle(state.axis, armAng * DEG);
    // hands in rig space at address
    const handsLocal = tmp.copy(state.hands0).sub(state.S);
    glove.position.copy(handsLocal);
    const shL = new THREE.Vector3(0.04, -0.03, -0.13), shR = new THREE.Vector3(0.0, -0.06, 0.13);
    const elbowL = shL.clone().lerp(handsLocal, 0.5).add(new THREE.Vector3(0.03, 0, -0.03));
    const elbowR = shR.clone().lerp(handsLocal, 0.5).add(new THREE.Vector3(0.05, 0.02, 0.04));
    span(armL, shL, elbowL); span(foreL, elbowL, handsLocal);
    span(armR, shR, elbowR); span(foreR, elbowR, handsLocal);
    // club: from hands toward the ball at address, then hinged in the plane
    addressDir.copy(SOLE).sub(state.hands0).normalize();
    clubG.position.copy(handsLocal);
    q.setFromUnitVectors(new THREE.Vector3(0, -1, 0), addressDir);
    const qh = new THREE.Quaternion().setFromAxisAngle(state.axis, hinge * DEG);
    clubG.quaternion.copy(qh).multiply(q);

    // torso turn about the (tilted) spine
    const tilt = spine.userData.tilt || 0;
    const qt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -tilt);
    const qturn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -turn * DEG);
    spine.quaternion.copy(qt).multiply(qturn);
    hips.rotation.set(Math.PI / 2, 0, 0);
    hips.rotateZ(-turn * 0.4 * DEG);
    // the head turns to watch the ball go on the follow-through
    head.rotation.y = thru > 0.3 ? -Math.min(0.9, (thru - 0.3) * 1.6) : 0;
  }

  function update(dt, idle){
    if (!idle) return;
    state.idleT += dt;
    // gentle waggle while addressing the ball
    const w = Math.sin(state.idleT * 2.1) * 0.03 * (state.style === 'putt' ? 0.3 : 1);
    pose(-Math.max(0, w), state.style);
  }

  setClub('iron');
  return { group: root, setClub, pose, update, state, shirt };
}

import * as THREE from 'three';
import { RAPIER, type PhysicsWorld } from '../physics/world';

export const GROUND_SIZE = 2000; // 2 x 2 km
export const SPAWN = new THREE.Vector3(0, 1.2, 0);

/** Hill: centre (cx,cz), size m, height m. Asymmetric on purpose so orientation bugs show up. */
const HILL = { cx: -140, cz: -60, size: 160, peak: 7, res: 64 };
export function hillHeight(lx: number, lz: number): number {
  // lx, lz in [0, size] local coordinates
  const u = lx / HILL.size, v = lz / HILL.size;
  const edge = Math.sin(Math.PI * u) * Math.sin(Math.PI * v);
  const bump = 0.65 + 0.35 * Math.sin(u * 9) * Math.cos(v * 5);
  return HILL.peak * Math.pow(Math.max(edge, 0), 1.5) * bump;
}

function gridTexture(): THREE.CanvasTexture {
  const S = 1024; // covers 20 m x 20 m
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  g.fillStyle = '#6f7a66';
  g.fillRect(0, 0, S, S);
  // 10x10 checker of 2 m cells in two subtle tones
  const cell = S / 10;
  for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) {
    if ((i + j) % 2) { g.fillStyle = 'rgba(0,0,0,0.06)'; g.fillRect(i * cell, j * cell, cell, cell); }
  }
  g.strokeStyle = 'rgba(255,255,255,0.28)';
  g.lineWidth = 2;
  for (let i = 0; i <= 10; i++) { g.beginPath(); g.moveTo(i * cell, 0); g.lineTo(i * cell, S); g.stroke(); g.beginPath(); g.moveTo(0, i * cell); g.lineTo(S, i * cell); g.stroke(); }
  g.strokeStyle = 'rgba(255,255,255,0.7)';
  g.lineWidth = 5; // 20 m major line on the tile border
  g.strokeRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 16;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.repeat.set(GROUND_SIZE / 20, GROUND_SIZE / 20);
  return tex;
}

/** Flat ground + obstacles + ramp + heightfield hill. Everything is static. */
export function buildTestWorld(physics: PhysicsWorld, scene: THREE.Scene): void {
  const w = physics.world;

  // --- ground ---
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE),
    new THREE.MeshStandardMaterial({ map: gridTexture(), roughness: 0.95 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  w.createCollider(RAPIER.ColliderDesc.cuboid(GROUND_SIZE / 2, 1, GROUND_SIZE / 2).setTranslation(0, -1, 0).setFriction(1));

  // --- static boxes helper ---
  const boxMat = new THREE.MeshStandardMaterial({ color: 0xb9b2a5, roughness: 0.8 });
  const addBox = (x: number, z: number, sx: number, sy: number, sz: number, color?: number, rotY = 0) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), color ? new THREE.MeshStandardMaterial({ color, roughness: 0.8 }) : boxMat);
    mesh.position.set(x, sy / 2, z);
    mesh.rotation.y = rotY;
    mesh.castShadow = mesh.receiveShadow = true;
    scene.add(mesh);
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY);
    w.createCollider(RAPIER.ColliderDesc.cuboid(sx / 2, sy / 2, sz / 2).setTranslation(x, sy / 2, z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }));
  };

  // "buildings" ahead (north = -Z) and around
  const colors = [0xc9a98a, 0x9aa9b8, 0xb98f8f, 0xa8b89a, 0xd0c9a0];
  for (let i = 0; i < 24; i++) {
    const a = (i * 2.399) % (Math.PI * 2), d = 80 + ((i * 53) % 400);
    addBox(Math.cos(a) * d, Math.sin(a) * d, 12 + (i % 4) * 6, 10 + ((i * 7) % 5) * 8, 14 + (i % 3) * 5, colors[i % colors.length], a);
  }
  // low obstacles near spawn (cone-ish crates, for slalom)
  for (let i = 0; i < 8; i++) addBox(30 + i * 22, i % 2 ? 6 : -6, 1.2, 1.2, 1.2, 0xe08a1e);
  // a wall to hit
  addBox(60, -140, 30, 3, 1.5, 0x884444);

  // --- ramp (30 m ahead-left): wedge via rotated box ---
  {
    const len = 18, width = 7, rise = 2.6;
    const ang = Math.atan2(rise, len);
    const hyp = Math.hypot(len, rise);
    const thick = 0.4;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, thick, hyp), new THREE.MeshStandardMaterial({ color: 0xd8c040, roughness: 0.7 }));
    // ramp rises toward -Z (north). Centre at (0, rise/2, -85)
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), ang);
    // +ang about X lifts the -Z (north) end
    mesh.quaternion.copy(q);
    mesh.position.set(0, rise / 2 - thick / 2 * Math.cos(ang), -85);
    mesh.castShadow = mesh.receiveShadow = true;
    scene.add(mesh);
    w.createCollider(
      RAPIER.ColliderDesc.cuboid(width / 2, thick / 2, hyp / 2)
        .setTranslation(mesh.position.x, mesh.position.y, mesh.position.z)
        .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
        .setFriction(1),
    );
  }

  // --- speed-perception posts along the main straight (north from spawn) ---
  const postGeo = new THREE.CylinderGeometry(0.12, 0.12, 2.2, 8);
  const postMat = new THREE.MeshStandardMaterial({ color: 0xffffff });
  const posts = new THREE.InstancedMesh(postGeo, postMat, 200 * 2);
  const m4 = new THREE.Matrix4();
  let n = 0;
  for (let i = 0; i < 200; i++) for (const sx of [-9, 9]) {
    m4.makeTranslation(sx, 1.1, 20 - i * 10);
    posts.setMatrixAt(n++, m4);
  }
  posts.castShadow = true;
  scene.add(posts);

  // --- heightfield hill ---
  {
    const { cx, cz, size, res, peak } = HILL;
    const n1 = res + 1;
    // Rapier heightfield: heights column-major, (nrows+1)*(ncols+1); rows along X? verified at runtime (see README / __game.checkHill)
    const heights = new Float32Array(n1 * n1);
    const geo = new THREE.PlaneGeometry(size, size, res, res);
    geo.rotateX(-Math.PI / 2); // vertex (ix,iz): x = -size/2 + ix*s, z = -size/2 + iz*s
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let iz = 0; iz < n1; iz++) for (let ix = 0; ix < n1; ix++) {
      const h = hillHeight((ix / res) * size, (iz / res) * size);
      heights[ix * n1 + iz] = h; // column(x)-major: index = col * (nrows+1) + row, col=x, row=z
      pos.setY(iz * n1 + ix, h);
    }
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x7f9a62, roughness: 0.95 }));
    mesh.position.set(cx, 0.02, cz);
    mesh.receiveShadow = mesh.castShadow = true;
    scene.add(mesh);
    w.createCollider(
      RAPIER.ColliderDesc.heightfield(res, res, heights, { x: size, y: 1, z: size })
        .setTranslation(cx, 0.02, cz)
        .setFriction(1),
    );
    void peak;
  }

  // --- a few dynamic crates to smash (interpolated) ---
  const crateMat = new THREE.MeshStandardMaterial({ color: 0xa0763c, roughness: 0.9 });
  for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) {
    const s = 1.1;
    const body = w.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(-25 + i * 1.3, 0.55 + j * 1.12, -45));
    w.createCollider(RAPIER.ColliderDesc.cuboid(s / 2, s / 2, s / 2).setMass(40).setFriction(0.8), body);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), crateMat);
    mesh.castShadow = mesh.receiveShadow = true;
    scene.add(mesh);
    physics.track(body, mesh);
  }
}

export const HILL_INFO = HILL;

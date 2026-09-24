// Манекен из боксов. Без анимации: только дискретные позы (GDD → Враги).
import * as THREE from 'three';

const fract = (v: number) => v - Math.floor(v);
const hash = (pose: number, k: number) => fract(Math.sin(pose * 1000 * k + k * 12.9898) * 43758.5453);

export interface PoseParams {
  yaw: number;
  lean: number;
  headTilt: number;
  headTurn: number;
  armL: number;
  armR: number;
}

export function poseParams(pose: number): PoseParams {
  return {
    yaw: (hash(pose, 1) - 0.5) * 0.9,
    lean: (hash(pose, 2) - 0.5) * 0.3,
    headTilt: (hash(pose, 3) - 0.5) * 0.7,
    headTurn: (hash(pose, 4) - 0.5) * 0.9,
    armL: -hash(pose, 5) * 2.0, // отрицательный — рука тянется вперёд
    armR: -hash(pose, 6) * 2.0,
  };
}

export interface MannequinRig {
  root: THREE.Group;
  body: THREE.Group;
  head: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  meshes: THREE.Mesh[];
}

export function buildMannequin(material: THREE.Material): MannequinRig {
  const box = (w: number, h: number, d: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  };
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  const legs = box(0.36, 0.9, 0.22);
  legs.position.y = 0.45;
  const torso = box(0.46, 0.62, 0.26);
  torso.position.y = 1.21;
  body.add(legs, torso);

  const head = new THREE.Group();
  head.position.y = 1.56;
  const skull = box(0.24, 0.3, 0.26);
  skull.position.y = 0.15;
  head.add(skull);
  body.add(head);

  const arm = (side: number) => {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.29, 1.48, 0);
    const a = box(0.11, 0.66, 0.11);
    a.position.y = -0.33;
    pivot.add(a);
    body.add(pivot);
    return { pivot, mesh: a };
  };
  const l = arm(-1);
  const r = arm(1);
  return { root, body, head, armL: l.pivot, armR: r.pivot, meshes: [legs, torso, skull, l.mesh, r.mesh] };
}

/** Поставить манекен на позицию лицом к камере (0, y, 0) и применить позу. */
export function placeMannequin(rig: MannequinRig, x: number, z: number, pose: number): void {
  const p = poseParams(pose);
  rig.root.position.set(x, 0, z);
  rig.root.rotation.set(0, Math.atan2(-x, -z) + p.yaw, 0);
  rig.body.rotation.set(p.lean, 0, p.lean * 0.5);
  rig.head.rotation.set(p.headTilt, p.headTurn, 0);
  rig.armL.rotation.set(p.armL, 0, 0.1);
  rig.armR.rotation.set(p.armR, 0, -0.1);
  rig.root.updateMatrixWorld(true);
}

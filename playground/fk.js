// MuJoCo's forward kinematics for the G1: every joint a hinge at its body's origin, the pelvis on a free joint.
// Quaternions are [w, x, y, z], as MuJoCo and the recordings store them.

export function qmul(a, b) {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}

export function qrot(q, v) {
  const [w, x, y, z] = q;
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

function axisAngle(axis, a) {
  const s = Math.sin(a / 2);
  return [Math.cos(a / 2), axis[0] * s, axis[1] * s, axis[2] * s];
}

// World poses of every body: rootPos [x, y, z], rootQuat [w, x, y, z], joints (29, in spec.joints' order).
// Returns {pos: [[x, y, z], ...], quat: [[w, x, y, z], ...]}, indexed as spec.bodies.
export function forward(spec, rootPos, rootQuat, joints) {
  const n = spec.bodies.length, pos = new Array(n), quat = new Array(n);
  spec.bodies.forEach((b, i) => {
    if (b.joint === "free") {
      pos[i] = [rootPos[0], rootPos[1], rootPos[2]];
      const s = Math.hypot(...rootQuat);
      quat[i] = rootQuat.map(c => c / s);
      return;
    }
    const pp = pos[b.parent], pq = quat[b.parent];
    const o = qrot(pq, b.pos);
    pos[i] = [pp[0] + o[0], pp[1] + o[1], pp[2] + o[2]];
    quat[i] = qmul(qmul(pq, b.quat), axisAngle(b.joint.axis, joints[b.joint.index]));
  });
  return { pos, quat };
}

// A geom's world pose from its body's.
export function geomPose(spec, fk, g) {
  const b = spec.geoms[g].body, o = qrot(fk.quat[b], spec.geoms[g].pos);
  return { pos: [fk.pos[b][0] + o[0], fk.pos[b][1] + o[1], fk.pos[b][2] + o[2]], quat: qmul(fk.quat[b], spec.geoms[g].quat) };
}

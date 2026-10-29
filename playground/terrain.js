// The terrain: each tile's mesh, shaded earth low and honey high with darker risers, and its top surface for the
// height scan overlay.
import * as THREE from "three";

export async function fetchBytes(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  if (!url.endsWith(".gz")) return new Uint8Array(await r.arrayBuffer());
  const s = r.body.pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

function header(buf) {
  if (String.fromCharCode(...buf.subarray(0, 4)) !== "SBPG") throw new Error("not a playground file");
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
}

// a packed mesh: magic, version, big, vertex count, face count; int16 mm vertices; uint16/uint32 faces
export function decodeMesh(buf) {
  const dv = header(buf);
  const big = dv.getUint16(6, true), nv = dv.getUint32(8, true), nf = dv.getUint32(12, true);
  const q = new Int16Array(buf.slice(16, 16 + nv * 6).buffer);
  const pos = new Float32Array(nv * 3);
  for (let i = 0; i < pos.length; i++) pos[i] = q[i] / 1000;
  let off = 16 + nv * 6;
  off += (4 - (off % 4)) % 4;
  const idx = big ? new Uint32Array(buf.slice(off, off + nf * 12).buffer) : new Uint16Array(buf.slice(off, off + nf * 6).buffer);
  return { pos, idx };
}

const LOW = new THREE.Color("#7A684D"), HIGH = new THREE.Color("#D8A25C"), MID = new THREE.Color("#B39062");

// A non-indexed, flat-shaded mesh with one colour per face: tops by height, sides darker.
export function terrainMesh({ pos, idx }) {
  let zmin = Infinity, zmax = -Infinity;
  for (let f = 0; f < idx.length; f += 3) {
    for (let k = 0; k < 3; k++) { const z = pos[idx[f + k] * 3 + 2]; if (z > -0.9) { zmin = Math.min(zmin, z); zmax = Math.max(zmax, z); } }
  }
  const span = zmax - zmin;
  const P = new Float32Array(idx.length * 3), C = new Float32Array(idx.length * 3);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), col = new THREE.Color();
  for (let f = 0; f < idx.length; f += 3) {
    a.fromArray(pos, idx[f] * 3); b.fromArray(pos, idx[f + 1] * 3); c.fromArray(pos, idx[f + 2] * 3);
    n.subVectors(c, b).cross(b.clone().sub(a)).normalize();
    const zc = (a.z + b.z + c.z) / 3;
    if (span < 0.02) col.copy(MID);
    else col.copy(LOW).lerp(HIGH, THREE.MathUtils.clamp((zc - zmin) / span, 0, 1));
    if (Math.abs(n.z) < 0.7) col.multiplyScalar(0.8);
    if (zc < -0.9) col.copy(LOW).multiplyScalar(0.55);   // a trench's floor
    for (let k = 0; k < 3; k++) {
      const v = [a, b, c][k];
      P.set([v.x, v.y, v.z], (f + k) * 3);
      C.set([col.r, col.g, col.b], (f + k) * 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(P, 3));
  g.setAttribute("color", new THREE.BufferAttribute(C, 3));
  g.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0, flatShading: true, side: THREE.DoubleSide });
  // faint lines every 0.5 m in plan, so slopes and flat ground read as surfaces
  mat.onBeforeCompile = sh => {
    sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nvarying vec3 vW;\nvarying float vUp;")
      .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvW = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvUp = normal.z;");
    sh.fragmentShader = sh.fragmentShader.replace("#include <common>", "#include <common>\nvarying vec3 vW;\nvarying float vUp;")
      .replace("#include <color_fragment>", `#include <color_fragment>
        vec2 gq = abs(fract(vW.xy / 0.5 - 0.5) - 0.5) / max(fwidth(vW.xy / 0.5), vec2(1e-4));
        float gl = (1.0 - min(min(gq.x, gq.y), 1.0)) * step(0.7, vUp);   // tops only
        diffuseColor.rgb *= 1.0 - 0.13 * gl;`);
  };
  const m = new THREE.Mesh(g, mat);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}

// The top surface: upward faces binned on a 0.25 m grid; height(x, y) is the highest face above the point.
export class Surface {
  constructor({ pos, idx }, half = 4.6, cell = 0.25) {
    this.half = half; this.cell = cell; this.n = Math.ceil(2 * half / cell);
    this.bins = Array.from({ length: this.n * this.n }, () => []);
    this.pos = pos; this.idx = idx; this.boxes = [];
    for (let f = 0; f < idx.length; f += 3) {
      const i0 = idx[f] * 3, i1 = idx[f + 1] * 3, i2 = idx[f + 2] * 3;
      const ux = pos[i1] - pos[i0], uy = pos[i1 + 1] - pos[i0 + 1], vx = pos[i2] - pos[i0], vy = pos[i2 + 1] - pos[i0 + 1];
      if (Math.abs(ux * vy - uy * vx) < 1e-9) continue;   // vertical faces: no top
      const xs = [pos[i0], pos[i1], pos[i2]], ys = [pos[i0 + 1], pos[i1 + 1], pos[i2 + 1]];
      const [x0, x1] = this.range(Math.min(...xs), Math.max(...xs)), [y0, y1] = this.range(Math.min(...ys), Math.max(...ys));
      for (let i = x0; i <= x1; i++) for (let j = y0; j <= y1; j++) this.bins[i * this.n + j].push(f);
    }
  }
  range(lo, hi) {
    const k = v => THREE.MathUtils.clamp(Math.floor((v + this.half) / this.cell), 0, this.n - 1);
    return [k(lo), k(hi)];
  }
  height(x, y) {
    const [i] = this.range(x, x), [j] = this.range(y, y);
    let best = -Infinity;
    const p = this.pos, idx = this.idx;
    for (const f of this.bins[i * this.n + j]) {
      const i0 = idx[f] * 3, i1 = idx[f + 1] * 3, i2 = idx[f + 2] * 3;
      const ax = p[i0], ay = p[i0 + 1], bx = p[i1], by = p[i1 + 1], cx = p[i2], cy = p[i2 + 1];
      const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d, l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d, l3 = 1 - l1 - l2;
      if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
      best = Math.max(best, l1 * p[i0 + 2] + l2 * p[i1 + 2] + l3 * p[i2 + 2]);
    }
    for (const b of this.boxes) {   // blocks: {x, y, yaw, hl, hw, top}
      const c = Math.cos(b.yaw), s = Math.sin(b.yaw), dx = x - b.x, dy = y - b.y;
      if (Math.abs(c * dx + s * dy) <= b.hl && Math.abs(-s * dx + c * dy) <= b.hw) best = Math.max(best, b.top);
    }
    return best;
  }
}

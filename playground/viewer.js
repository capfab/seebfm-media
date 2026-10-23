// The SeeBFM playground: recorded attempts replayed in 3D.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { toCreasedNormals } from "three/addons/utils/BufferGeometryUtils.js";
import { forward } from "./fk.js";
import { fetchBytes, decodeMesh, terrainMesh, Surface } from "./terrain.js";
import * as matcher from "./match.js";

const $ = id => document.getElementById(id);
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const OUTCOME = { success: ["crossed", "good"], crossed_then_fell: ["crossed, then fell", "mid"], fell: ["fell", "bad"],
  fell_before_crossing: ["fell", "bad"], stayed: ["stayed short", "mid"], stayed_without_falling: ["stayed short", "mid"],
  recovered: ["recovered", "good"], fell_before_push: ["fell before the push", "bad"], other: ["not scored", "mid"] };
const GRID = { terrain: ["flat", "stairs_up", "stairs_down", "slope_up", "slope_down", "boxes", "obstacles", "gaps"],
  block: ["block_static", "block_moving"], push: ["flat", "stairs_up", "boxes"] };
const SIZE_NAME = { stairs_up: "Step height", stairs_down: "Step height", slope_up: "Slope", slope_down: "Slope",
  boxes: "Box height", obstacles: "Obstacle height", gaps: "Gap width", block_static: "Block top", block_moving: "Block top" };
const COMMANDS = ["walk forward", "walk backward", "side step left", "turn around in place", "wave the right hand",
  "crouch down", "jump in place", "stand still"];

let IX, SPEC;
const S = { model: "seebfm", tab: "reward", prompt: "fwd07", typed: null, mode: "terrain", terrain: "stairs_up", size: 2,
  ghost: false, ghostModel: "bfmzero", attempt: 0, playing: true, speed: 1, follow: true, scan: false, t: 0 };
const cache = new Map();
let cur = null, ghostCur = null, holdUntil = 0;

// ---------- scene
const canvas = $("scene");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.AgXToneMapping; renderer.toneMappingExposure = 1.15;
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
const STUDIO = new THREE.Color("#D6D2C6");
scene.background = STUDIO; scene.fog = new THREE.Fog(STUDIO, 9, 22);
const camera = new THREE.PerspectiveCamera(36, 1, 0.05, 80); camera.up.set(0, 0, 1);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true; controls.maxPolarAngle = Math.PI * 0.49; controls.minDistance = 1.2; controls.maxDistance = 14;
scene.add(new THREE.HemisphereLight("#ffffff", "#9a8f7a", 1.4));
const sun = new THREE.DirectionalLight("#fff6e8", 2.6);
sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0004; sun.shadow.radius = 4;
Object.assign(sun.shadow.camera, { left: -3.5, right: 3.5, top: 3.5, bottom: -3.5, near: 0.5, far: 20 });
scene.add(sun, sun.target);
const floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshStandardMaterial({ color: "#DAD7CF", roughness: 1 }));
floor.receiveShadow = true; scene.add(floor);
const terrainGroup = new THREE.Group(); scene.add(terrainGroup);

function resize() {
  const r = canvas.parentElement.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false); camera.aspect = r.width / r.height; camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(canvas.parentElement);

// ---------- robot
function robotMeshes(buf, opts = {}) {
  const pos = new Uint16Array(buf.buffer, buf.byteOffset + SPEC.buffer.positions[0], SPEC.buffer.positions[1] / 2);
  const idx = new Uint16Array(buf.buffer, buf.byteOffset + SPEC.buffer.indices[0], SPEC.buffer.indices[1] / 2);
  const mats = opts.ghost
    ? [false, true].map(() => new THREE.MeshStandardMaterial({ color: opts.color, roughness: 0.6, transparent: true, opacity: 0.32, depthWrite: false }))
    : [new THREE.MeshStandardMaterial({ color: "#c9c8c4", roughness: 0.42, metalness: 0.35 }),
       new THREE.MeshStandardMaterial({ color: "#2b2b2b", roughness: 0.55, metalness: 0.2 })];
  const bodies = SPEC.bodies.map(() => { const g = new THREE.Group(); g.matrixAutoUpdate = true; return g; });
  SPEC.geoms.forEach(g => {
    const [vo, vn] = g.vertices, [fo, fn] = g.faces;
    const P = new Float32Array(vn * 3);
    for (let i = 0; i < vn; i++) for (let k = 0; k < 3; k++) P[i * 3 + k] = g.min[k] + pos[(vo + i) * 3 + k] * g.scale[k];
    let geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(P, 3));
    geo.setIndex(new THREE.BufferAttribute(idx.slice(fo * 3, (fo + fn) * 3), 1));
    geo = toCreasedNormals(geo, Math.PI / 6);
    const m = new THREE.Mesh(geo, mats[g.dark ? 1 : 0]);
    m.position.fromArray(g.pos); m.quaternion.set(g.quat[1], g.quat[2], g.quat[3], g.quat[0]);
    m.castShadow = !opts.ghost; m.receiveShadow = !opts.ghost;
    bodies[g.body].add(m);
  });
  const root = new THREE.Group(); bodies.forEach(b => root.add(b)); scene.add(root);
  return { root, bodies };
}
let robot, ghost;
const TORSO = () => SPEC.bodies.findIndex(b => b.name === "torso_link");

function setPose(r, rp, rq, j) {
  const fk = forward(SPEC, rp, rq, j);
  r.bodies.forEach((b, i) => { b.position.fromArray(fk.pos[i]); const q = fk.quat[i]; b.quaternion.set(q[1], q[2], q[3], q[0]); });
  return fk;
}

// ---------- attempts
function decodeAttempts(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (String.fromCharCode(...buf.subarray(0, 4)) !== "SBPG") throw new Error("not a playground file");
  const A = dv.getUint16(6, true), T = dv.getUint16(8, true), flags = dv.getUint16(10, true);
  const scale = [12, 16, 20].map(o => dv.getFloat32(o, true));   // position, quaternion and joint steps
  const lens = Array.from({ length: A }, (_, a) => dv.getUint16(24 + 2 * a, true));
  let off = 24 + 2 * A;
  const read = nch => {
    const n = A * nch * T, lo = buf.subarray(off, off + n), hi = buf.subarray(off + n, off + 2 * n), out = new Int16Array(n);
    off += 2 * n;
    for (let r = 0; r < A * nch; r++) {
      let acc = 0;
      for (let t = 0; t < T; t++) { const i = r * T + t; let v = lo[i] | (hi[i] << 8); if (v & 0x8000) v -= 0x10000; acc = ((acc + v) << 16) >> 16; out[i] = acc; }
    }
    return out;
  };
  const ch = read(36), block = flags & 1 ? read(4) : null;
  return { A, T, lens, ch, block, scale };
}

function frame(rec, a, f, out) {
  const T = rec.T, base = a * 36 * T, L = rec.lens[a];
  const i0 = Math.min(Math.floor(f), L - 1), i1 = Math.min(i0 + 1, L - 1), w = Math.min(Math.max(f - i0, 0), 1);
  const v = c => { const x0 = rec.ch[base + c * T + i0], x1 = rec.ch[base + c * T + i1]; return x0 + (x1 - x0) * w; };
  const [sp, sq, sj] = rec.scale;
  for (let c = 0; c < 3; c++) out.pos[c] = v(c) * sp;
  let n = 0; for (let c = 0; c < 4; c++) { out.quat[c] = v(3 + c) * sq; n += out.quat[c] ** 2; }
  n = Math.sqrt(n); for (let c = 0; c < 4; c++) out.quat[c] /= n;
  for (let c = 0; c < 29; c++) out.joints[c] = v(7 + c) * sj;
  if (rec.block) {
    const bb = a * 4 * T, b = c => rec.block[bb + c * T + i0];
    out.block = { x: b(0) / 1000, y: b(1) / 1000, top: b(2) / 1000, yaw: b(3) / 1e4 };
  }
  return out;
}
const poseBuf = () => ({ pos: [0, 0, 0], quat: [1, 0, 0, 0], joints: new Array(29).fill(0), block: null });

async function loadAttempts(key) {
  if (!cache.has(key)) cache.set(key, fetchBytes(`data/a/${key}.bin.gz`).then(decodeAttempts));
  return cache.get(key);
}
async function loadTile(id) {
  const k = `tile:${id}`;
  if (!cache.has(k)) cache.set(k, fetchBytes(`data/cells/${id}.bin.gz`).then(b => { const d = decodeMesh(b); return { d, surface: new Surface(d) }; }));
  return cache.get(k);
}

// ---------- choice -> cell and attempt key
function cellList() {
  const C = IX.cells, keys = Object.keys(C);
  if (S.mode === "push") return keys.filter(k => C[k].push_mps && C[k].terrain === S.terrain).sort((a, b) => C[a].push_mps - C[b].push_mps);
  if (S.terrain === "flat") return ["flat"];
  return keys.filter(k => C[k].terrain === S.terrain && !C[k].push_mps).sort((a, b) => C[a].size - C[b].size);
}
const cellKey = () => { const l = cellList(); return l[Math.min(S.size, l.length - 1)]; };
const promptKey = () => (S.tab === "typed" ? S.typed : S.prompt);
const attKey = (model = S.model) => `${model}/${promptKey()}/${cellKey()}`;

// ---------- UI
function seg(el, items, cur, onPick, label = x => x, extra = () => "", off = () => false) {
  el.innerHTML = "";
  items.forEach(it => {
    const b = document.createElement("button");
    b.innerHTML = extra(it) + label(it); b.setAttribute("aria-pressed", String(it === cur));
    b.disabled = off(it); if (b.disabled) b.title = "Not recorded for this model and prompt";
    b.onclick = () => onPick(it); el.appendChild(b);
  });
}
// what was recorded: a model's prompts, and a model and prompt's terrains (a partial delivery offers only these)
const has = prefix => Object.keys(IX.attempts).some(k => k.startsWith(prefix));
const terrainRecorded = t => Object.entries(IX.cells).some(([k, c]) => c.terrain === t && (S.mode === "push") === !!c.push_mps
  && IX.attempts[`${S.model}/${promptKey()}/${k}`]);
function renderUI() {
  const M = Object.keys(IX.models);
  seg($("models"), M, S.model, m => { S.model = m; if (m !== "seebfm") { S.tab = "reward"; if (!IX.prompts[S.prompt]?.six) S.prompt = "fwd07"; } choose(); },
    m => IX.models[m], m => `<span class="dot" style="background:${css(`--m-${m}`)}"></span>`);
  [...$("ptabs").children].forEach(b => {
    b.setAttribute("aria-pressed", String(b.dataset.tab === S.tab));
    b.disabled = b.dataset.tab === "typed" && S.model !== "seebfm";
    b.title = b.disabled ? "Typed commands were tested with SeeBFM" : "";
  });
  $("tab-reward").hidden = S.tab !== "reward"; $("tab-typed").hidden = S.tab !== "typed";
  const P = Object.entries(IX.prompts).filter(([, p]) => p.kind === "reward" && (S.model === "seebfm" || p.six));
  const box = $("prompts"); box.innerHTML = "";
  P.forEach(([k, p]) => {
    const b = document.createElement("button"); b.className = "chip"; b.setAttribute("aria-pressed", String(k === S.prompt));
    b.innerHTML = `<span>${p.name}</span>${p.six ? "" : "<small>further</small>"}`;
    b.disabled = !has(`${S.model}/${k}/`); if (b.disabled) b.title = "Not recorded for this model";
    b.onclick = () => { S.prompt = k; choose(); }; box.appendChild(b);
  });
  $("panel").innerHTML = (IX.prompts[S.prompt]?.panel || []).map(([a, b]) => `<div><b>${a}</b><span>${b}</span></div>`).join("");
  [...$("modes").children].forEach(b => b.setAttribute("aria-pressed", String(b.dataset.mode === S.mode)));
  seg($("terrains"), GRID[S.mode], S.terrain, t => { S.terrain = t; S.size = Math.min(S.size, cellList().length - 1); choose(); },
    t => IX.terrains[t], () => "", t => !terrainRecorded(t));
  const l = cellList(), c = IX.cells[cellKey()];
  $("sizebox").hidden = l.length < 2;
  $("size").max = String(l.length - 1); $("size").value = String(Math.min(S.size, l.length - 1));
  $("sizename").textContent = S.mode === "push" ? "Push strength" : SIZE_NAME[S.terrain] || "Size";
  $("sizelabel").textContent = c?.label || "";
  const six = IX.prompts[promptKey()]?.six;
  $("ghost").disabled = !six; $("ghost").checked = S.ghost && six;
  seg($("ghosts"), M.filter(m => m !== S.model), S.ghostModel, m => { S.ghostModel = m; S.ghost = true; choose(); },
    m => IX.models[m], m => `<span class="dot" style="background:${css(`--m-${m}`)}"></span>`);
  $("ghosts").hidden = !(S.ghost && six);
}

function outcomeLabel(o) { return OUTCOME[o] || [o, "mid"]; }
function renderStatus(entry) {
  const dots = $("dots"); dots.innerHTML = "";
  if (!entry) { $("title").textContent = "Not recorded for this choice"; $("counts").textContent = ""; $("attlabel").textContent = "Attempt"; return; }
  entry.outcome.forEach((o, i) => {
    const b = document.createElement("button"); const [lab, tone] = outcomeLabel(o);
    b.style.background = css(`--o-${tone}`); b.title = `attempt ${i + 1}: ${lab}`; b.setAttribute("aria-label", b.title);
    b.setAttribute("aria-pressed", String(i === S.attempt)); b.onclick = () => { S.attempt = i; start(false); }; dots.appendChild(b);
  });
  const tally = {};
  entry.outcome.forEach(o => { const l = outcomeLabel(o)[0]; tally[l] = (tally[l] || 0) + 1; });
  $("attlabel").textContent = `Attempt ${S.attempt + 1} of ${entry.outcome.length}`;
  const p = IX.prompts[promptKey()];
  const tl = IX.tiles?.[entry.tile?.[S.attempt]]?.label || IX.cells[cellKey()].label;
  $("title").textContent = `${p.kind === "reward" ? p.name : `\u201c${p.text}\u201d`} · ${IX.terrains[IX.cells[cellKey()].terrain]}${tl ? ", " + tl : ""}`;
  $("counts").textContent = `All ${entry.outcome.length} attempts: ` + Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(" · ");
  $("who").textContent = IX.models[S.model] + (S.ghost && ghostCur ? `  ·  ghost: ${IX.models[S.ghostModel]}` : "");
}

// ---------- playback
let cellShown = null, blockMesh = null, pushArrow = null, scanDots = null, surface = null;
const scanPts = (() => {
  const p = [];
  for (const [x0, x1, ym, d] of [[-0.8, 1.6, 0.6, 0.1], [-0.3, 0.7, 0.3, 0.05]]) {   // the scan's coarse and fine grids, torso frame
    const nx = Math.round((x1 - x0) / d) + 1, ny = Math.round(2 * ym / d) + 1;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) p.push([x0 + i * d, -ym + j * d]);
  }
  return p;
})();

// the tile an attempt ran on (each size has two, each built at its own difficulty), and the block if there is one
const FLAT = c => c.terrain === "flat" || c.terrain.startsWith("block_");
async function showTile(id, key) {
  const c = IX.cells[key];
  if (cellShown === `${id}|${key}`) return;
  const { d, surface: s } = await loadTile(id);
  terrainGroup.clear();
  const m = terrainMesh(d); terrainGroup.add(m);
  let zmin = Infinity; for (let i = 2; i < d.pos.length; i += 3) zmin = Math.min(zmin, d.pos[i]);
  floor.position.z = FLAT(c) ? -0.002 : zmin - 0.002;   // flat ground carries on past the tile's edge
  surface = s; surface.boxes = [];
  blockMesh = null;
  if (c.block_size_m) {
    const [L, W, H] = c.block_size_m;
    blockMesh = new THREE.Mesh(new THREE.BoxGeometry(L, W, H), new THREE.MeshStandardMaterial({ color: "#8d97a3", roughness: 0.7 }));
    blockMesh.castShadow = blockMesh.receiveShadow = true; blockMesh.userData = { L, W, H }; terrainGroup.add(blockMesh);
  }
  cellShown = `${id}|${key}`;
}

// a second model's attempt for comparison: on the same tile where it has one, starting closest to this attempt's heading,
// turned by a quarter turn where the tile is the same after one (stairs, slopes, gaps, flat ground)
function pairGhost(entry, a, ge) {
  const tile = entry.tile[a], yaw = entry.yaw[a], sym = IX.tiles[tile]?.symmetric;
  const same = ge.tile.map((t, i) => i).filter(i => ge.tile[i] === tile);
  let best = { a: (same[0] ?? 0), rot: 0, d: Infinity };
  for (const i of (same.length ? same : ge.tile.map((t, i) => i)))
    for (const k of (sym ? [0, 1, 2, 3] : [0])) {
      const rot = k * Math.PI / 2, dd = Math.abs(Math.atan2(Math.sin(ge.yaw[i] + rot - yaw), Math.cos(ge.yaw[i] + rot - yaw)));
      if (dd < best.d) best = { a: i, rot, d: dd };
    }
  return best;
}
function turn(pose, rot) {
  if (!rot) return pose;
  const c = Math.cos(rot), s = Math.sin(rot), [x, y] = pose.pos;
  pose.pos[0] = c * x - s * y; pose.pos[1] = s * x + c * y;
  const q = pose.quat, h = [Math.cos(rot / 2), 0, 0, Math.sin(rot / 2)];
  pose.quat = [h[0] * q[0] - h[3] * q[3], h[0] * q[1] - h[3] * q[2], h[0] * q[2] + h[3] * q[1], h[0] * q[3] + h[3] * q[0]];
  return pose;
}

// the choice in the address, so the project page can link to one (#m=seebfm&p=fwd07&c=stairs-up-3&a=2)
function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (IX.models[h.get("m")]) S.model = h.get("m");
  const p = h.get("p");
  if (IX.prompts[p]) {
    if (IX.prompts[p].kind === "wording") { S.tab = "typed"; S.typed = p; S.model = "seebfm"; } else { S.tab = "reward"; S.prompt = p; }
  }
  const c = IX.cells[h.get("c")];
  if (c) {
    S.mode = c.push_mps ? "push" : c.terrain.startsWith("block_") ? "block" : "terrain";
    S.terrain = c.terrain;
    S.size = Math.max(0, cellList().indexOf(h.get("c")));
  }
  if (h.has("a")) S.attempt = +h.get("a");
  if (IX.models[h.get("g")]) { S.ghost = true; S.ghostModel = h.get("g"); }
  if (h.get("scan") === "1") { S.scan = true; $("scan").setAttribute("aria-pressed", "true"); }
  S.query = h.get("q");   // a typed command in the link
  if (h.has("t")) { S.seek = +h.get("t"); S.playing = h.get("play") !== "0"; $("play").textContent = S.playing ? "Pause" : "Play"; }
}
function writeHash() {
  const h = new URLSearchParams({ m: S.model, p: promptKey() || "", c: cellKey(), a: String(S.attempt) });
  if (S.ghost && ghostCur) h.set("g", S.ghostModel);
  history.replaceState(null, "", "#" + h);
}

async function start(resetCamera = true) {
  const key = attKey();
  const entry = IX.attempts[key];
  renderUI();
  $("loading").hidden = false;
  try {
    if (entry) S.attempt = Math.min(S.attempt, entry.outcome.length - 1);
    if (entry) await showTile(entry.tile[S.attempt], cellKey());
    cur = entry ? { key, entry, rec: await loadAttempts(key), pose: poseBuf() } : null;
    const gk = attKey(S.ghostModel), ge = IX.attempts[gk];
    ghostCur = S.ghost && IX.prompts[promptKey()]?.six && ge && entry
      ? { entry: ge, rec: await loadAttempts(gk), pose: poseBuf(), ...pairGhost(entry, S.attempt, ge) } : null;
  } finally { $("loading").hidden = true; }
  if (cur) S.attempt = Math.min(S.attempt, cur.rec.A - 1);
  if (ghost) { ghost.root.removeFromParent(); ghost = null; }
  if (ghostCur) {
    const buf = cache.get("robot.bin");
    ghost = robotMeshes(await buf, { ghost: true, color: css(`--m-${S.ghostModel}`) });
  }
  robot.root.visible = !!cur;
  S.t = S.seek ?? 0; S.seek = null; holdUntil = 0;
  renderStatus(entry);
  writeHash();
  if (cur) {
    const tOut = entry.t[S.attempt], dur = cur.rec.lens[S.attempt] / IX.rate_hz;
    $("mark").hidden = false; $("mark").style.left = `${(100 * tOut) / dur}%`;
    if (resetCamera || !S.follow) aimCamera();
  }
}

function aimCamera() {
  const p = frame(cur.rec, S.attempt, S.t * IX.rate_hz, poseBuf());
  const yaw = Math.atan2(2 * (p.quat[0] * p.quat[3] + p.quat[1] * p.quat[2]), 1 - 2 * (p.quat[2] ** 2 + p.quat[3] ** 2));
  const a = yaw - 1.9, target = new THREE.Vector3(p.pos[0], p.pos[1], p.pos[2] - 0.15);
  const r = 4.2 / Math.min(1, camera.aspect * 1.2);   // further back on a narrow screen
  controls.target.copy(target);
  camera.position.set(target.x + r * Math.cos(a), target.y + r * Math.sin(a), target.z + 1.3 * r / 4.2);
  controls.update();
}

function step(dt) {
  if (!cur) return;
  const dur = cur.rec.lens[S.attempt] / IX.rate_hz;
  if (S.playing) {
    S.t += dt * S.speed;
    if (S.t >= dur) { S.t = dur; if (!holdUntil) holdUntil = performance.now() + 1500; else if (performance.now() > holdUntil) { S.t = 0; holdUntil = 0; } }
  }
  const p = frame(cur.rec, S.attempt, S.t * IX.rate_hz, cur.pose);
  const fk = setPose(robot, p.pos, p.quat, p.joints);
  if (ghostCur) {
    const ga = ghostCur.a, gd = ghostCur.rec.lens[ga] / IX.rate_hz;
    const g = turn(frame(ghostCur.rec, ga, Math.min(S.t, gd) * IX.rate_hz, ghostCur.pose), ghostCur.rot);
    setPose(ghost, g.pos, g.quat, g.joints);
  }
  if (blockMesh && p.block) {
    const { H } = blockMesh.userData;
    blockMesh.position.set(p.block.x, p.block.y, p.block.top - H / 2); blockMesh.rotation.set(0, 0, p.block.yaw);
    surface.boxes = [{ x: p.block.x, y: p.block.y, yaw: p.block.yaw, hl: blockMesh.userData.L / 2, hw: blockMesh.userData.W / 2, top: p.block.top }];
  }
  // the push, as an arrow at the pelvis for 0.8 s
  const e = cur.entry;
  if (e.push_t) {
    const pt = e.push_t[S.attempt], dv = e.push_dv[S.attempt];
    if (!pushArrow) { pushArrow = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 0.8, 0xd0613f, 0.22, 0.14); scene.add(pushArrow); }
    const on = S.t >= pt && S.t < pt + 0.8;
    pushArrow.visible = on;
    if (on) {
      const dir = new THREE.Vector3(dv[0], dv[1], 0).normalize();
      pushArrow.position.set(p.pos[0] - dir.x * 0.9, p.pos[1] - dir.y * 0.9, p.pos[2]); pushArrow.setDirection(dir);
    }
  } else if (pushArrow) pushArrow.visible = false;
  // the outcome, from the moment it is scored
  const [lab, tone] = outcomeLabel(e.outcome[S.attempt]);
  const shown = S.t >= e.t[S.attempt];
  $("outcome").hidden = !shown;
  if (shown) $("outcome").innerHTML = e.off?.[S.attempt]
    ? `<b style="background:${css(`--o-${tone}`)}"></b>${lab}, after leaving the recorded tile`
    : `<b style="background:${css(`--o-${tone}`)}"></b>${lab} at ${e.t[S.attempt].toFixed(1)} s`;
  $("clock").textContent = `${S.t.toFixed(1)} s / ${dur.toFixed(1)} s`;
  if (document.activeElement !== $("time")) $("time").value = String(Math.round((1000 * S.t) / dur));
  // follow the pelvis, keeping the viewer's own angle and distance
  if (S.follow) {
    const want = new THREE.Vector3(p.pos[0], p.pos[1], p.pos[2] - 0.15), d = want.sub(controls.target);
    if (d.length() < 1.0) d.multiplyScalar(0.08);   // ease, or catch up at once after a jump in time
    controls.target.add(d); camera.position.add(d);
  }
  sun.position.set(p.pos[0] - 2, p.pos[1] - 3, p.pos[2] + 5); sun.target.position.set(p.pos[0], p.pos[1], 0);
  if (S.scan) drawScan(fk);
  if (scanDots) scanDots.visible = S.scan;
}

function drawScan(fk) {
  if (!scanDots) {
    scanDots = new THREE.InstancedMesh(new THREE.SphereGeometry(0.012, 8, 6),
      new THREE.MeshStandardMaterial({ color: "#f3e3c2", emissive: "#a8661c", emissiveIntensity: 0.4, roughness: 0.5 }), scanPts.length);
    scene.add(scanDots);
  }
  const ti = TORSO(), tp = fk.pos[ti], q = fk.quat[ti];
  const yaw = Math.atan2(2 * (q[0] * q[3] + q[1] * q[2]), 1 - 2 * (q[2] ** 2 + q[3] ** 2)), c = Math.cos(yaw), s = Math.sin(yaw);
  const m4 = new THREE.Matrix4();
  scanPts.forEach(([x, y], i) => {
    const wx = tp[0] + c * x - s * y, wy = tp[1] + s * x + c * y;
    const h = surface.height(wx, wy);
    m4.makeTranslation(wx, wy, (Number.isFinite(h) ? h : -1) + 0.012); scanDots.setMatrixAt(i, m4);
  });
  scanDots.instanceMatrix.needsUpdate = true;
}

// ---------- events
function choose() { S.attempt = cur ? Math.floor(Math.random() * 5) : 0; start(true); }
[...$("ptabs").children].forEach(b => b.onclick = () => { if (b.disabled) return; S.tab = b.dataset.tab; if (S.tab === "typed" && !S.typed) { renderUI(); warmMatcher(); return; } choose(); });
[...$("modes").children].forEach(b => b.onclick = () => { S.mode = b.dataset.mode; S.terrain = GRID[S.mode].includes(S.terrain) ? S.terrain : GRID[S.mode][S.mode === "terrain" ? 1 : 0]; S.size = S.mode === "push" ? 1 : 2; choose(); });
$("size").oninput = e => { S.size = +e.target.value; choose(); };
$("ghost").onchange = e => { S.ghost = e.target.checked; start(false); };
$("play").onclick = () => { S.playing = !S.playing; $("play").textContent = S.playing ? "Pause" : "Play"; };
$("restart").onclick = () => { S.t = 0; holdUntil = 0; };
$("speed").onclick = () => { S.speed = S.speed === 1 ? 2 : S.speed === 2 ? 0.5 : 1; $("speed").textContent = `${S.speed}×`; };
$("next").onclick = () => { if (!cur) return; S.attempt = (S.attempt + 1) % cur.rec.A; start(false); };
$("time").oninput = e => { if (!cur) return; S.t = (+e.target.value / 1000) * cur.rec.lens[S.attempt] / IX.rate_hz; holdUntil = 0; };
const toggle = (id, k) => { S[k] = !S[k]; $(id).setAttribute("aria-pressed", String(S[k])); };
$("follow").onclick = () => toggle("follow", "follow");
$("scan").onclick = () => toggle("scan", "scan");
$("fullscreen").onclick = () => (document.fullscreenElement ? document.exitFullscreen() : $("view").requestFullscreen?.());
$("theme").onclick = () => {
  const t = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = t; try { localStorage.setItem("seebfm-theme", t); } catch {}
  renderUI(); if (cur) renderStatus(cur.entry);
};
try { const t = localStorage.getItem("seebfm-theme"); if (t) document.documentElement.dataset.theme = t; } catch {}
addEventListener("keydown", e => {
  if (e.target.tagName === "INPUT" && e.target.type === "text") return;
  if (e.key === " ") { e.preventDefault(); $("play").click(); }
  else if (e.key === "r" || e.key === "R") $("restart").click();
  else if (e.key === "n" || e.key === "N") $("next").click();
  else if (e.key === "s" || e.key === "S") $("scan").click();
  else if (e.key === "f" || e.key === "F") $("follow").click();
});

// typed commands
const wordings = () => Object.fromEntries(Object.entries(IX.prompts).filter(([, p]) => p.kind === "wording"));
function warmMatcher() {
  $("match").textContent = "Loading the sentence model (about 23 MB, once)…";
  matcher.load(wordings(), p => { if (p.status === "progress" && p.total) $("match").textContent = `Loading the sentence model: ${Math.round(p.progress)}%`; })
    .then(() => { if (!S.typed) showCommands("Type a command, or pick one:"); })
    .catch(() => { $("match").textContent = "The sentence model could not load here; reward prompts still work."; });
}
function showCommands(msg) {
  $("match").innerHTML = `${msg}<div class="seg" style="margin-top:6px">${COMMANDS.map(c => `<button type="button" data-c="${c}">${c}</button>`).join("")}</div>`;
  $("match").querySelectorAll("button").forEach(b => b.onclick = () => { $("text").value = b.dataset.c; $("typed").requestSubmit(); });
}
$("text").onfocus = warmMatcher;
$("typed").onsubmit = async e => {
  e.preventDefault();
  const text = $("text").value.trim();
  if (!text) return;
  $("match").textContent = "Matching…";
  try {
    const r = await matcher.match(text, wordings());
    const w = IX.prompts[r.key];
    if (!r.ok) { showCommands(`No tested wording is close enough (nearest: “${w.text}”, ${r.score.toFixed(2)}). Try one of these:`); return; }
    $("match").innerHTML = `Understood as <q>${w.text}</q>, a wording of “${w.command}” (similarity ${r.score.toFixed(2)}).`;
    S.typed = r.key; choose();
  } catch { $("match").textContent = "The sentence model could not load here; reward prompts still work."; }
};

// ---------- go
(async () => {
  IX = await (await fetch("data/index.json")).json();
  SPEC = await (await fetch("data/robot.json")).json();
  $("fixture").hidden = !IX.fixture;
  cache.set("robot.bin", fetchBytes("data/robot.bin"));
  robot = robotMeshes(await cache.get("robot.bin"));
  resize();
  readHash();
  await start(true);
  if (S.query) { S.model = "seebfm"; S.tab = "typed"; renderUI(); $("text").value = S.query; $("typed").requestSubmit(); }
  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => { step(Math.min(clock.getDelta(), 0.1)); controls.update(); renderer.render(scene, camera); });
  document.title = "SeeBFM playground";
  window.__ready = true;
})().catch(err => { $("loading").textContent = `Could not load: ${err.message}`; console.error(err); });

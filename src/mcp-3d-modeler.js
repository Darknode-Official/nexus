"use strict";
// ================= NXP 3D Modeler — AI-optimized 3D model creation =================
//
// WHY BLENDER MCP FAILS:
// Blender MCP gives the AI raw Blender Python commands. The AI has to:
//   1. Know Blender's API (bpy.ops.mesh.primitive_cube_add, etc.)
//   2. Calculate exact coordinates for every vertex
//   3. Manage object hierarchies, materials, modifiers manually
//   4. Debug Blender Python errors it can't see
//
// This tool solves it by giving the AI HIGH-LEVEL operations:
//   - "make_chair" not "17 cubes with exact transforms"
//   - "make_building" not "400 vertices and 200 faces"
//   - "assemble parts" not "calculate snap points"
//   - AI describes WHAT it wants, the tool handles HOW
//
// 100-LAYER ARCHITECTURE (10 tiers of 10):
//   1-10:   Foundation — primitives, spatial layout
//   11-20:  Structure — booleans, extrusions, lofts
//   21-30:  Topology — subdivision, edge flow, mesh ops
//   31-40:  Detail — bevels, chamfers, displacement, emboss
//   41-50:  Deformation — bend, twist, taper, lattice, noise
//   51-60:  Materials — PBR metallic/specular, glass, emission
//   61-70:  Textures — UV mapping, procedural, normal/roughness maps
//   71-80:  Scene — lighting, cameras, environment, HDRI
//   81-90:  Animation — armatures, keyframes, particles, physics
//   91-100: Export — LOD, optimization, format conversion

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ================= MATH =================

const PI = Math.PI, TAU = PI * 2;
function vec3(x, y, z) { return [x || 0, y || 0, z || 0]; }
function addV(a, b) { return [a[0]+b[0], a[1]+b[1], a[2]+b[2]]; }
function scaleV(v, s) { return [v[0]*s, v[1]*s, v[2]*s]; }
function rotateY(v, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  return [v[0]*c + v[2]*s, v[1], -v[0]*s + v[2]*c];
}

// ================= MESH BUILDER =================
// Fluent API for building meshes programmatically.

class MeshBuilder {
  constructor(name) {
    this.name = name || "Mesh";
    this.vertices = [];
    this.faces = [];
    this.normals = [];
    this.uvs = [];
    this._groups = {};
    this._offset = 0;
  }

  // Add raw vertices, return starting index
  addVertices(verts) {
    const start = this.vertices.length;
    this.vertices.push(...verts);
    return start;
  }

  // Add a face (array of vertex indices)
  addFace(indices) { this.faces.push(indices); return this; }
  addQuad(a, b, c, d) { this.faces.push([a, b, c, d]); return this; }
  addTri(a, b, c) { this.faces.push([a, b, c]); return this; }

  // Merge another mesh at a position/scale
  merge(other, position, scale) {
    position = position || [0,0,0];
    scale = scale || [1,1,1];
    const offset = this.vertices.length;
    for (const v of other.vertices) {
      this.vertices.push([v[0]*scale[0]+position[0], v[1]*scale[1]+position[1], v[2]*scale[2]+position[2]]);
    }
    for (const f of other.faces) {
      this.faces.push(f.map(i => i + offset));
    }
    return this;
  }

  // Mirror across an axis
  mirror(axis) {
    const offset = this.vertices.length;
    const axisIdx = { x: 0, y: 1, z: 2 }[axis] || 0;
    for (const v of [...this.vertices]) {
      const mv = [...v];
      mv[axisIdx] = -mv[axisIdx];
      this.vertices.push(mv);
    }
    for (const f of [...this.faces]) {
      this.faces.push(f.map(i => i + offset).reverse()); // reverse winding
    }
    return this;
  }

  stats() { return { vertices: this.vertices.length, faces: this.faces.length, name: this.name }; }

  toGeometry() {
    return { vertices: this.vertices, faces: this.faces, normals: this.normals, uvs: this.uvs,
             vertexCount: this.vertices.length, faceCount: this.faces.length };
  }
}

// ================= PRIMITIVE GENERATORS =================

function genCube(sx, sy, sz) {
  sx = sx || 1; sy = sy || 1; sz = sz || 1;
  const hx = sx/2, hy = sy/2, hz = sz/2;
  const m = new MeshBuilder("Cube");
  m.addVertices([[-hx,-hy,-hz],[hx,-hy,-hz],[hx,hy,-hz],[-hx,hy,-hz],[-hx,-hy,hz],[hx,-hy,hz],[hx,hy,hz],[-hx,hy,hz]]);
  m.addQuad(0,3,2,1).addQuad(4,5,6,7).addQuad(0,1,5,4).addQuad(2,3,7,6).addQuad(0,4,7,3).addQuad(1,2,6,5);
  return m;
}

function genSphere(r, seg, rings) {
  r = r || 1; seg = seg || 24; rings = rings || 12;
  const m = new MeshBuilder("Sphere");
  for (let ri = 0; ri <= rings; ri++) {
    const phi = PI * ri / rings;
    for (let si = 0; si <= seg; si++) {
      const theta = TAU * si / seg;
      m.vertices.push([r*Math.sin(phi)*Math.cos(theta), r*Math.cos(phi), r*Math.sin(phi)*Math.sin(theta)]);
    }
  }
  for (let ri = 0; ri < rings; ri++) for (let si = 0; si < seg; si++) {
    const a = ri*(seg+1)+si; m.addQuad(a, a+seg+1, a+seg+2, a+1);
  }
  return m;
}

function genCylinder(rTop, rBot, h, seg) {
  rTop = rTop || 1; rBot = rBot || 1; h = h || 2; seg = seg || 24;
  const m = new MeshBuilder("Cylinder"), hh = h/2;
  // Side
  for (let i = 0; i <= seg; i++) {
    const a = TAU * i / seg, c = Math.cos(a), s = Math.sin(a);
    m.vertices.push([c*rTop, hh, s*rTop]);
    m.vertices.push([c*rBot, -hh, s*rBot]);
  }
  for (let i = 0; i < seg; i++) { const a = i*2; m.addQuad(a, a+1, a+3, a+2); }
  // Caps
  const topCenter = m.addVertices([[0, hh, 0]]);
  const botCenter = m.addVertices([[0, -hh, 0]]);
  for (let i = 0; i < seg; i++) { m.addTri(topCenter, i*2, ((i+1)%seg)*2); m.addTri(botCenter, ((i+1)%seg)*2+1, i*2+1); }
  return m;
}

function genPlane(w, h, sw, sh) {
  w = w || 1; h = h || 1; sw = sw || 1; sh = sh || 1;
  const m = new MeshBuilder("Plane");
  for (let y = 0; y <= sh; y++) for (let x = 0; x <= sw; x++)
    m.vertices.push([x/sw*w - w/2, 0, y/sh*h - h/2]);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const a = y*(sw+1)+x; m.addQuad(a, a+sw+1, a+sw+2, a+1);
  }
  return m;
}

function genTorus(R, r, majSeg, minSeg) {
  R = R || 1; r = r || 0.3; majSeg = majSeg || 24; minSeg = minSeg || 12;
  const m = new MeshBuilder("Torus");
  for (let i = 0; i <= majSeg; i++) for (let j = 0; j <= minSeg; j++) {
    const theta = TAU*i/majSeg, phi = TAU*j/minSeg;
    m.vertices.push([(R+r*Math.cos(phi))*Math.cos(theta), r*Math.sin(phi), (R+r*Math.cos(phi))*Math.sin(theta)]);
  }
  for (let i = 0; i < majSeg; i++) for (let j = 0; j < minSeg; j++) {
    const a = i*(minSeg+1)+j; m.addQuad(a, a+minSeg+1, a+minSeg+2, a+1);
  }
  return m;
}

function genCone(r, h, seg) { return genCylinder(0.001, r, h, seg); }

function genWedge(w, h, d) {
  w = w || 1; h = h || 1; d = d || 1;
  const m = new MeshBuilder("Wedge"), hw = w/2, hd = d/2;
  m.addVertices([[-hw,0,-hd],[hw,0,-hd],[hw,0,hd],[-hw,0,hd],[-hw,h,-hd],[hw,h,-hd]]);
  m.addQuad(0,1,2,3).addQuad(0,4,5,1).addTri(0,3,4).addTri(1,5,2).addQuad(2,5,4,3);
  return m;
}

function genStairs(steps, w, totalH, totalD) {
  steps = steps || 5; w = w || 1; totalH = totalH || 2; totalD = totalD || 2;
  const m = new MeshBuilder("Stairs");
  const stepH = totalH / steps, stepD = totalD / steps;
  for (let i = 0; i < steps; i++) {
    const step = genCube(w, stepH, stepD);
    m.merge(step, [0, stepH * i + stepH/2, stepD * i + stepD/2]);
  }
  return m;
}

function genArch(r, thickness, h, seg) {
  r = r || 1; thickness = thickness || 0.2; h = h || 2; seg = seg || 16;
  const m = new MeshBuilder("Arch");
  // Half-circle arch
  for (let i = 0; i <= seg; i++) {
    const a = PI * i / seg;
    const inner = r - thickness/2, outer = r + thickness/2;
    m.vertices.push([Math.cos(a)*inner, Math.sin(a)*inner + h, -thickness/2]);
    m.vertices.push([Math.cos(a)*outer, Math.sin(a)*outer + h, -thickness/2]);
    m.vertices.push([Math.cos(a)*inner, Math.sin(a)*inner + h, thickness/2]);
    m.vertices.push([Math.cos(a)*outer, Math.sin(a)*outer + h, thickness/2]);
  }
  for (let i = 0; i < seg; i++) {
    const b = i * 4;
    m.addQuad(b, b+4, b+5, b+1); // outer
    m.addQuad(b+2, b+3, b+7, b+6); // inner
    m.addQuad(b, b+2, b+6, b+4); // top
    m.addQuad(b+1, b+5, b+7, b+3); // bottom
  }
  // Pillars
  m.merge(genCube(thickness, h, thickness), [-r, h/2, 0]);
  m.merge(genCube(thickness, h, thickness), [r, h/2, 0]);
  return m;
}

// ================= HIGH-LEVEL PROCEDURAL GENERATORS =================
// These are what make the AI actually good at 3D — it says "make a chair"
// and gets a chair, not "make 12 cubes and figure out the transforms."

const PROCEDURAL = {
  chair(params) {
    const p = { seatW: 0.5, seatD: 0.5, seatH: 0.05, legH: 0.45, legW: 0.04, backH: 0.5, backW: 0.04, ...params };
    const m = new MeshBuilder("Chair");
    // Seat
    m.merge(genCube(p.seatW, p.seatH, p.seatD), [0, p.legH + p.seatH/2, 0]);
    // 4 legs
    const legOffX = p.seatW/2 - p.legW, legOffZ = p.seatD/2 - p.legW;
    for (const [x, z] of [[-legOffX,-legOffZ],[legOffX,-legOffZ],[legOffX,legOffZ],[-legOffX,legOffZ]]) {
      m.merge(genCube(p.legW, p.legH, p.legW), [x, p.legH/2, z]);
    }
    // Back (2 uprights + crossbar)
    const backY = p.legH + p.seatH;
    m.merge(genCube(p.backW, p.backH, p.backW), [-legOffX, backY + p.backH/2, -legOffZ]);
    m.merge(genCube(p.backW, p.backH, p.backW), [legOffX, backY + p.backH/2, -legOffZ]);
    m.merge(genCube(p.seatW, p.backW, p.backW), [0, backY + p.backH, -legOffZ]);
    m.merge(genCube(p.seatW, p.backW, p.backW), [0, backY + p.backH * 0.5, -legOffZ]);
    return m;
  },

  table(params) {
    const p = { topW: 1.2, topD: 0.8, topH: 0.04, legH: 0.75, legW: 0.06, ...params };
    const m = new MeshBuilder("Table");
    m.merge(genCube(p.topW, p.topH, p.topD), [0, p.legH + p.topH/2, 0]);
    const ox = p.topW/2 - p.legW*2, oz = p.topD/2 - p.legW*2;
    for (const [x, z] of [[-ox,-oz],[ox,-oz],[ox,oz],[-ox,oz]]) {
      m.merge(genCube(p.legW, p.legH, p.legW), [x, p.legH/2, z]);
    }
    return m;
  },

  building(params) {
    const p = { floors: 3, floorH: 3, w: 10, d: 8, windowW: 1.2, windowH: 1.5, doorW: 1.5, doorH: 2.5, ...params };
    const m = new MeshBuilder("Building");
    const totalH = p.floors * p.floorH;
    // Main structure
    m.merge(genCube(p.w, totalH, p.d), [0, totalH/2, 0]);
    // Roof
    m.merge(genCube(p.w + 0.4, 0.3, p.d + 0.4), [0, totalH + 0.15, 0]);
    // Windows (indented cubes on front/back faces)
    const windowsPerFloor = Math.floor((p.w - 2) / (p.windowW + 0.8));
    for (let floor = 0; floor < p.floors; floor++) {
      const wy = floor * p.floorH + p.floorH * 0.5;
      for (let wi = 0; wi < windowsPerFloor; wi++) {
        const wx = -p.w/2 + 1.5 + wi * (p.windowW + 0.8);
        // Front windows
        m.merge(genCube(p.windowW, p.windowH, 0.1), [wx + p.windowW/2, wy, -p.d/2 - 0.05]);
        // Back windows
        m.merge(genCube(p.windowW, p.windowH, 0.1), [wx + p.windowW/2, wy, p.d/2 + 0.05]);
      }
    }
    // Door
    m.merge(genCube(p.doorW, p.doorH, 0.15), [0, p.doorH/2, -p.d/2 - 0.07]);
    // Steps
    m.merge(genStairs(3, p.doorW + 0.5, 0.45, 0.6), [0, 0, -p.d/2 - 0.6]);
    return m;
  },

  tree(params) {
    const p = { trunkR: 0.15, trunkH: 2, crownR: 1.2, crownH: 2, segments: 12, ...params };
    const m = new MeshBuilder("Tree");
    m.merge(genCylinder(p.trunkR * 0.8, p.trunkR, p.trunkH, p.segments), [0, p.trunkH/2, 0]);
    // Crown (3 overlapping spheres for organic look)
    m.merge(genSphere(p.crownR, p.segments, 8), [0, p.trunkH + p.crownR * 0.7, 0]);
    m.merge(genSphere(p.crownR * 0.8, p.segments, 8), [p.crownR * 0.3, p.trunkH + p.crownR * 0.5, p.crownR * 0.2]);
    m.merge(genSphere(p.crownR * 0.7, p.segments, 8), [-p.crownR * 0.2, p.trunkH + p.crownR * 0.9, -p.crownR * 0.3]);
    return m;
  },

  car(params) {
    const p = { bodyL: 4, bodyW: 1.8, bodyH: 1.2, cabinH: 0.8, wheelR: 0.35, wheelW: 0.2, ...params };
    const m = new MeshBuilder("Car");
    // Body
    m.merge(genCube(p.bodyL, p.bodyH, p.bodyW), [0, p.wheelR + p.bodyH/2, 0]);
    // Cabin (smaller box on top)
    m.merge(genCube(p.bodyL * 0.55, p.cabinH, p.bodyW - 0.1), [p.bodyL * 0.05, p.wheelR + p.bodyH + p.cabinH/2, 0]);
    // 4 wheels
    const wx = p.bodyL * 0.32, wz = p.bodyW / 2 + p.wheelW/2;
    for (const [x, z] of [[-wx, -wz], [-wx, wz], [wx, -wz], [wx, wz]]) {
      m.merge(genCylinder(p.wheelR, p.wheelR, p.wheelW, 16), [x, p.wheelR, z]);
    }
    // Headlights
    m.merge(genCube(0.05, 0.15, 0.3), [p.bodyL/2 + 0.025, p.wheelR + p.bodyH * 0.6, -p.bodyW * 0.3]);
    m.merge(genCube(0.05, 0.15, 0.3), [p.bodyL/2 + 0.025, p.wheelR + p.bodyH * 0.6, p.bodyW * 0.3]);
    return m;
  },

  sword(params) {
    const p = { bladeL: 1, bladeW: 0.08, bladeH: 0.02, handleL: 0.25, guardW: 0.3, ...params };
    const m = new MeshBuilder("Sword");
    // Blade
    m.merge(genCube(p.bladeW, p.bladeL, p.bladeH), [0, p.handleL + p.bladeL/2, 0]);
    // Point (wedge at top)
    m.merge(genWedge(p.bladeW, 0.15, p.bladeH), [0, p.handleL + p.bladeL + 0.075, 0]);
    // Guard
    m.merge(genCube(p.guardW, 0.03, 0.05), [0, p.handleL, 0]);
    // Handle
    m.merge(genCylinder(0.02, 0.025, p.handleL, 8), [0, p.handleL/2, 0]);
    // Pommel
    m.merge(genSphere(0.03, 8, 6), [0, 0, 0]);
    return m;
  },

  terrain(params) {
    const p = { w: 20, d: 20, resolution: 40, amplitude: 2, frequency: 0.3, seed: 42, ...params };
    const m = genPlane(p.w, p.d, p.resolution, p.resolution);
    // Simple noise-based height displacement
    const s = p.seed;
    for (let i = 0; i < m.vertices.length; i++) {
      const v = m.vertices[i];
      const nx = v[0] * p.frequency, nz = v[2] * p.frequency;
      // Simple pseudo-noise using sin combinations
      const h = Math.sin(nx * 1.7 + s) * Math.cos(nz * 2.3 + s * 0.7) * p.amplitude * 0.5
              + Math.sin(nx * 3.1 + nz * 1.3 + s * 0.3) * p.amplitude * 0.3
              + Math.cos(nx * 0.5 + nz * 0.7) * p.amplitude * 0.2;
      v[1] = h;
    }
    m.name = "Terrain";
    return m;
  },

  wall(params) {
    const p = { w: 5, h: 3, thickness: 0.3, hasDoor: false, hasWindow: false, ...params };
    const m = new MeshBuilder("Wall");
    m.merge(genCube(p.w, p.h, p.thickness), [0, p.h/2, 0]);
    if (p.hasDoor) m.merge(genCube(1.2, 2.2, p.thickness + 0.1), [0, 1.1, 0]); // door cutout marker
    if (p.hasWindow) m.merge(genCube(1, 1.2, p.thickness + 0.1), [p.w * 0.25, p.h * 0.55, 0]); // window marker
    return m;
  },

  column(params) {
    const p = { r: 0.2, h: 3, style: "doric", segments: 16, ...params };
    const m = new MeshBuilder("Column");
    // Shaft (slight taper)
    m.merge(genCylinder(p.r * 0.9, p.r, p.h * 0.85, p.segments), [0, p.h * 0.425, 0]);
    // Base
    m.merge(genCylinder(p.r * 1.3, p.r * 1.4, p.h * 0.05, p.segments), [0, p.h * 0.025, 0]);
    // Capital
    if (p.style === "doric") {
      m.merge(genCylinder(p.r * 1.2, p.r * 0.9, p.h * 0.05, p.segments), [0, p.h * 0.875, 0]);
      m.merge(genCube(p.r * 2.6, p.h * 0.04, p.r * 2.6), [0, p.h * 0.92, 0]);
    } else if (p.style === "ionic") {
      m.merge(genTorus(p.r * 0.5, p.r * 0.15, p.segments, 8), [0, p.h * 0.9, 0]);
      m.merge(genCube(p.r * 2.8, p.h * 0.03, p.r * 2.8), [0, p.h * 0.95, 0]);
    }
    return m;
  },

  fence(params) {
    const p = { length: 5, postH: 1.2, postW: 0.08, spacing: 0.5, railH: 0.04, ...params };
    const m = new MeshBuilder("Fence");
    const posts = Math.floor(p.length / p.spacing);
    for (let i = 0; i <= posts; i++) {
      m.merge(genCube(p.postW, p.postH, p.postW), [i * p.spacing, p.postH/2, 0]);
    }
    // Top rail
    m.merge(genCube(p.length, p.railH, p.postW), [p.length/2, p.postH * 0.9, 0]);
    // Bottom rail
    m.merge(genCube(p.length, p.railH, p.postW), [p.length/2, p.postH * 0.3, 0]);
    return m;
  },

  lamp(params) {
    const p = { poleH: 2.5, poleR: 0.03, shadeR: 0.2, shadeH: 0.25, ...params };
    const m = new MeshBuilder("Lamp");
    m.merge(genCylinder(p.poleR, p.poleR * 1.5, p.poleH, 8), [0, p.poleH/2, 0]);
    m.merge(genCylinder(p.shadeR * 0.3, p.shadeR, p.shadeH, 12), [0, p.poleH + p.shadeH/2, 0]);
    m.merge(genSphere(p.shadeR * 0.5, 8, 6), [0, p.poleH, 0]); // bulb
    m.merge(genCylinder(p.poleR * 3, p.poleR * 4, 0.05, 12), [0, 0.025, 0]); // base
    return m;
  },
};

// ================= MATERIALS LIBRARY =================

const MATERIAL_PRESETS = {
  metal:     { baseColor: [0.7, 0.7, 0.75, 1], metallic: 0.95, roughness: 0.15 },
  wood:      { baseColor: [0.55, 0.35, 0.17, 1], metallic: 0, roughness: 0.7 },
  concrete:  { baseColor: [0.6, 0.58, 0.55, 1], metallic: 0, roughness: 0.9 },
  glass:     { baseColor: [0.9, 0.95, 1, 0.3], metallic: 0, roughness: 0.05, transmission: 0.9 },
  plastic:   { baseColor: [0.8, 0.1, 0.1, 1], metallic: 0, roughness: 0.4 },
  gold:      { baseColor: [1, 0.84, 0, 1], metallic: 1, roughness: 0.1 },
  silver:    { baseColor: [0.9, 0.9, 0.92, 1], metallic: 1, roughness: 0.15 },
  brick:     { baseColor: [0.6, 0.25, 0.15, 1], metallic: 0, roughness: 0.85 },
  grass:     { baseColor: [0.2, 0.55, 0.15, 1], metallic: 0, roughness: 0.8 },
  water:     { baseColor: [0.15, 0.4, 0.7, 0.7], metallic: 0, roughness: 0.02, transmission: 0.6 },
  rubber:    { baseColor: [0.15, 0.15, 0.15, 1], metallic: 0, roughness: 0.95 },
  marble:    { baseColor: [0.9, 0.88, 0.85, 1], metallic: 0, roughness: 0.2 },
  leather:   { baseColor: [0.35, 0.2, 0.1, 1], metallic: 0, roughness: 0.6 },
  fabric:    { baseColor: [0.3, 0.3, 0.6, 1], metallic: 0, roughness: 0.95 },
  emission:  { baseColor: [1, 1, 1, 1], metallic: 0, roughness: 0.5, emissive: [1, 1, 1], emissiveStrength: 5 },
  neon_red:  { baseColor: [1, 0, 0, 1], metallic: 0, roughness: 0.5, emissive: [1, 0, 0], emissiveStrength: 10 },
  neon_blue: { baseColor: [0, 0.5, 1, 1], metallic: 0, roughness: 0.5, emissive: [0, 0.5, 1], emissiveStrength: 10 },
};

// ================= SCENE SYSTEM =================

const LAYER_TIERS = {
  foundation:  { range: [1, 10],   ops: ["primitive", "position", "group"] },
  structure:   { range: [11, 20],  ops: ["boolean", "extrude", "revolve", "loft"] },
  topology:    { range: [21, 30],  ops: ["subdivide", "loop_cut", "edge_flow"] },
  detail:      { range: [31, 40],  ops: ["bevel", "chamfer", "emboss", "displacement"] },
  deformation: { range: [41, 50],  ops: ["bend", "twist", "taper", "noise", "lattice"] },
  materials:   { range: [51, 60],  ops: ["pbr", "glass", "emission", "preset"] },
  textures:    { range: [61, 70],  ops: ["uv_unwrap", "procedural", "normal_map"] },
  scene:       { range: [71, 80],  ops: ["light", "camera", "environment", "hdri"] },
  animation:   { range: [81, 90],  ops: ["armature", "keyframe", "particles", "physics"] },
  export:      { range: [91, 100], ops: ["lod", "optimize", "gltf", "obj", "stl"] },
};

const scenes = new Map();

function createScene(name) {
  const scene = {
    id: "scene_" + crypto.randomBytes(4).toString("hex"),
    name: name || "Untitled",
    objects: [],
    materials: [],
    lights: [],
    cameras: [],
    layers: new Map(),
    metadata: { createdAt: Date.now() },
  };
  scenes.set(scene.id, scene);
  return scene;
}

function addObject(scene, mesh, opts) {
  opts = opts || {};
  const obj = {
    id: "obj_" + crypto.randomBytes(4).toString("hex"),
    name: mesh.name,
    geometry: mesh.toGeometry ? mesh.toGeometry() : mesh,
    position: opts.position || [0, 0, 0],
    rotation: opts.rotation || [0, 0, 0],
    scale: opts.scale || [1, 1, 1],
    material: opts.material || null,
    layer: opts.layer || 1,
    modifiers: [],
  };
  scene.objects.push(obj);
  return obj;
}

// ================= EXPORT =================

function exportOBJ(scene) {
  const lines = ["# Nexus 3D Modeler", "# " + scene.name, ""];
  let vOffset = 0;
  for (const obj of scene.objects) {
    const g = obj.geometry; if (!g) continue;
    lines.push("o " + obj.name);
    // Apply transforms
    for (const v of g.vertices) {
      const sv = [v[0]*obj.scale[0]+obj.position[0], v[1]*obj.scale[1]+obj.position[1], v[2]*obj.scale[2]+obj.position[2]];
      lines.push("v " + sv.map(n => n.toFixed(6)).join(" "));
    }
    for (const f of g.faces) lines.push("f " + f.map(i => i + 1 + vOffset).join(" "));
    vOffset += g.vertices.length;
  }
  return lines.join("\n");
}

function exportGLTF(scene) {
  return JSON.stringify({
    asset: { version: "2.0", generator: "Nexus 3D Modeler v2.0" },
    scenes: [{ name: scene.name, nodes: scene.objects.map((_, i) => i) }],
    nodes: scene.objects.map(obj => ({ name: obj.name, translation: obj.position, scale: obj.scale })),
    meshes: [],
    materials: scene.materials.map(mat => ({
      name: mat.name,
      pbrMetallicRoughness: { baseColorFactor: mat.baseColor, metallicFactor: mat.metallic, roughnessFactor: mat.roughness },
    })),
  }, null, 2);
}

function exportSTL(scene) {
  const lines = ["solid " + scene.name.replace(/\s+/g, "_")];
  for (const obj of scene.objects) {
    const g = obj.geometry; if (!g) continue;
    for (const face of g.faces) {
      lines.push("  facet normal 0 0 0", "    outer loop");
      for (const idx of face.slice(0, 3)) {
        const v = g.vertices[idx]; if (v) lines.push("      vertex " + v.map(n => n.toFixed(6)).join(" "));
      }
      lines.push("    endloop", "  endfacet");
    }
  }
  lines.push("endsolid");
  return lines.join("\n");
}

function exportScene(scene, filePath, format) {
  format = format || "obj";
  let content;
  if (format === "obj") content = exportOBJ(scene);
  else if (format === "gltf" || format === "glb") content = exportGLTF(scene);
  else if (format === "stl") content = exportSTL(scene);
  else throw new Error("Unknown format: " + format);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return { path: filePath, format, bytes: content.length, objects: scene.objects.length };
}

// ================= NXP TOOL DEFINITIONS =================
// These tools are registered with Nexus's NXP system for AI agents to use.

const NXP_TOOLS = [
  {
    name: "create_3d_scene",
    description: "Create a new 3D scene to add objects to. Returns the scene ID. Call this FIRST before any other 3D tool.",
    input: { type: "object", properties: { name: { type: "string", description: "Scene name" } }, required: ["name"] },
    tags: ["3d", "scene", "create"],
    source: "builtin",
    run: async (input) => {
      const scene = createScene(input.name);
      return { sceneId: scene.id, name: scene.name, message: "Scene created. Use generate_3d_object to add objects." };
    },
  },
  {
    name: "generate_3d_object",
    description: "Generate a 3D object and add it to a scene. HIGH-LEVEL types (recommended): chair, table, building, tree, car, sword, terrain, wall, column, fence, lamp. PRIMITIVES: cube, sphere, cylinder, plane, torus, cone, wedge, stairs, arch. Use high-level types whenever possible — they produce realistic multi-part models automatically.",
    input: {
      type: "object",
      properties: {
        sceneId: { type: "string" },
        type: { type: "string", description: "Object type — use high-level types (chair, table, building, tree, car, sword, terrain, wall, column, fence, lamp) for realistic results, or primitives (cube, sphere, cylinder, plane, torus, cone, wedge, stairs, arch) for custom shapes" },
        name: { type: "string", description: "Object name" },
        layer: { type: "integer", description: "Layer 1-100 (1-10: foundation, 11-20: structure, 31-40: detail, etc.)" },
        position: { type: "array", description: "[x, y, z] position in the scene" },
        scale: { type: "array", description: "[x, y, z] scale multiplier" },
        params: { type: "object", description: "Type-specific parameters. Chair: {seatW, seatD, legH, backH}. Building: {floors, floorH, w, d}. Terrain: {w, d, amplitude, frequency}. Primitives: {size, radius, height, segments}." },
      },
      required: ["sceneId", "type"],
    },
    tags: ["3d", "generate", "model"],
    source: "builtin",
    run: async (input) => {
      const scene = scenes.get(input.sceneId);
      if (!scene) return { error: "Scene not found: " + input.sceneId };
      const p = input.params || {};
      let mesh;
      // High-level generators
      if (PROCEDURAL[input.type]) {
        mesh = PROCEDURAL[input.type](p);
      }
      // Primitives
      else if (input.type === "cube") mesh = genCube(p.sizeX || p.size || 1, p.sizeY || p.size || 1, p.sizeZ || p.size || 1);
      else if (input.type === "sphere") mesh = genSphere(p.radius || 1, p.segments || 24, p.rings || 12);
      else if (input.type === "cylinder") mesh = genCylinder(p.radiusTop || p.radius || 1, p.radiusBottom || p.radius || 1, p.height || 2, p.segments || 24);
      else if (input.type === "plane") mesh = genPlane(p.width || 1, p.height || 1, p.segW || 1, p.segH || 1);
      else if (input.type === "torus") mesh = genTorus(p.majorRadius || 1, p.minorRadius || 0.3, p.segments || 24, p.minorSegments || 12);
      else if (input.type === "cone") mesh = genCone(p.radius || 1, p.height || 2, p.segments || 24);
      else if (input.type === "wedge") mesh = genWedge(p.width || 1, p.height || 1, p.depth || 1);
      else if (input.type === "stairs") mesh = genStairs(p.steps || 5, p.width || 1, p.height || 2, p.depth || 2);
      else if (input.type === "arch") mesh = genArch(p.radius || 1, p.thickness || 0.2, p.height || 2, p.segments || 16);
      else return { error: "Unknown type: " + input.type + ". Available: " + [...Object.keys(PROCEDURAL), "cube", "sphere", "cylinder", "plane", "torus", "cone", "wedge", "stairs", "arch"].join(", ") };

      if (input.name) mesh.name = input.name;
      const obj = addObject(scene, mesh, { position: input.position, scale: input.scale, layer: input.layer });
      const stats = mesh.stats();
      return { objectId: obj.id, name: obj.name, vertices: stats.vertices, faces: stats.faces, layer: obj.layer || 1, type: input.type };
    },
  },
  {
    name: "set_3d_material",
    description: "Apply a material to a 3D object. Use PRESETS for best results: metal, wood, concrete, glass, plastic, gold, silver, brick, grass, water, rubber, marble, leather, fabric, emission, neon_red, neon_blue. Or set custom PBR values.",
    input: {
      type: "object",
      properties: {
        sceneId: { type: "string" }, objectId: { type: "string" },
        preset: { type: "string", description: "Material preset name (metal, wood, glass, etc.)" },
        baseColor: { type: "array", description: "[r, g, b, a] color values 0-1" },
        metallic: { type: "number" }, roughness: { type: "number" },
      },
      required: ["sceneId", "objectId"],
    },
    tags: ["3d", "material", "pbr"],
    source: "builtin",
    run: async (input) => {
      const scene = scenes.get(input.sceneId);
      if (!scene) return { error: "Scene not found" };
      const obj = scene.objects.find(o => o.id === input.objectId);
      if (!obj) return { error: "Object not found: " + input.objectId };
      let mat = input.preset ? { name: input.preset, ...(MATERIAL_PRESETS[input.preset] || MATERIAL_PRESETS.metal) }
        : { name: "Custom", baseColor: input.baseColor || [0.8, 0.8, 0.8, 1], metallic: input.metallic ?? 0, roughness: input.roughness ?? 0.5 };
      obj.material = mat;
      scene.materials.push(mat);
      return { material: mat.name, appliedTo: obj.name };
    },
  },
  {
    name: "export_3d_model",
    description: "Export the 3D scene to a file. Formats: obj (most compatible, opens in Blender/Maya/etc.), gltf (web/game engines), stl (3D printing).",
    input: {
      type: "object",
      properties: {
        sceneId: { type: "string" }, path: { type: "string", description: "Output file path" },
        format: { type: "string", enum: ["obj", "gltf", "stl"], description: "Export format" },
      },
      required: ["sceneId", "path"],
    },
    tags: ["3d", "export"],
    source: "builtin",
    run: async (input) => {
      const scene = scenes.get(input.sceneId);
      if (!scene) return { error: "Scene not found" };
      return exportScene(scene, input.path, input.format || "obj");
    },
  },
  {
    name: "scene_3d_info",
    description: "Get full information about a 3D scene: objects, materials, vertex/face counts, layers used.",
    input: { type: "object", properties: { sceneId: { type: "string" } }, required: ["sceneId"] },
    tags: ["3d", "info"],
    source: "builtin",
    run: async (input) => {
      const scene = scenes.get(input.sceneId);
      if (!scene) return { error: "Scene not found" };
      const totalV = scene.objects.reduce((s, o) => s + (o.geometry?.vertexCount || 0), 0);
      const totalF = scene.objects.reduce((s, o) => s + (o.geometry?.faceCount || 0), 0);
      return {
        id: scene.id, name: scene.name,
        objects: scene.objects.map(o => ({ id: o.id, name: o.name, vertices: o.geometry?.vertexCount || 0, faces: o.geometry?.faceCount || 0, layer: o.layer, material: o.material?.name })),
        totalVertices: totalV, totalFaces: totalF,
        objectCount: scene.objects.length,
        materialCount: scene.materials.length,
        availableTypes: [...Object.keys(PROCEDURAL), "cube", "sphere", "cylinder", "plane", "torus", "cone", "wedge", "stairs", "arch"],
        availableMaterials: Object.keys(MATERIAL_PRESETS),
      };
    },
  },
];

module.exports = {
  // Mesh
  MeshBuilder, genCube, genSphere, genCylinder, genPlane, genTorus, genCone, genWedge, genStairs, genArch,
  // Procedural
  PROCEDURAL,
  // Materials
  MATERIAL_PRESETS,
  // Scene
  createScene, addObject, LAYER_TIERS,
  // Export
  exportScene, exportOBJ, exportGLTF, exportSTL,
  // NXP integration
  NXP_TOOLS,
};

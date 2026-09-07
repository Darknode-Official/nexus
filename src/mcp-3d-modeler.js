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

  bookshelf(params) {
    const p = { w: 1, h: 2, d: 0.3, shelves: 4, thickness: 0.03, ...params };
    const m = new MeshBuilder("Bookshelf");
    m.merge(genCube(p.thickness, p.h, p.d), [-p.w/2 + p.thickness/2, p.h/2, 0]);
    m.merge(genCube(p.thickness, p.h, p.d), [p.w/2 - p.thickness/2, p.h/2, 0]);
    m.merge(genCube(p.w, p.thickness, p.d), [0, p.h - p.thickness/2, 0]);
    m.merge(genCube(p.w, p.thickness, p.d), [0, p.thickness/2, 0]);
    const gap = (p.h - p.thickness * 2) / p.shelves;
    for (let i = 1; i < p.shelves; i++) m.merge(genCube(p.w - p.thickness * 2, p.thickness, p.d), [0, p.thickness + gap * i, 0]);
    m.merge(genCube(p.w, p.h, p.thickness * 0.5), [0, p.h/2, -p.d/2 + p.thickness * 0.25]);
    return m;
  },

  barrel(params) {
    const p = { r: 0.35, h: 1, segments: 16, bulge: 1.15, ...params };
    const m = new MeshBuilder("Barrel");
    const rings = 8;
    for (let ri = 0; ri <= rings; ri++) {
      const t = ri / rings, y = t * p.h - p.h/2;
      const bulgeF = 1 + (p.bulge - 1) * Math.sin(t * PI);
      const rr = p.r * bulgeF;
      for (let si = 0; si <= p.segments; si++) {
        const a = TAU * si / p.segments;
        m.vertices.push([Math.cos(a) * rr, y, Math.sin(a) * rr]);
      }
    }
    for (let ri = 0; ri < rings; ri++) for (let si = 0; si < p.segments; si++) {
      const a = ri * (p.segments + 1) + si; m.addQuad(a, a + p.segments + 1, a + p.segments + 2, a + 1);
    }
    m.merge(genCylinder(p.r * 0.95, p.r * 0.95, 0.02, p.segments), [0, p.h/2 - 0.01, 0]);
    m.merge(genCylinder(p.r * 0.95, p.r * 0.95, 0.02, p.segments), [0, -p.h/2 + 0.01, 0]);
    return m;
  },

  crate(params) {
    const p = { w: 0.6, h: 0.6, d: 0.6, plankW: 0.08, gap: 0.02, ...params };
    const m = new MeshBuilder("Crate");
    m.merge(genCube(p.w, p.h, p.d), [0, p.h/2, 0]);
    const n = Math.floor(p.w / (p.plankW + p.gap));
    for (let i = 0; i < n; i++) {
      const x = -p.w/2 + p.plankW/2 + i * (p.plankW + p.gap);
      m.merge(genCube(p.plankW * 0.8, p.h + 0.01, 0.01), [x, p.h/2, p.d/2 + 0.005]);
      m.merge(genCube(p.plankW * 0.8, p.h + 0.01, 0.01), [x, p.h/2, -p.d/2 - 0.005]);
    }
    return m;
  },

  bench(params) {
    const p = { seatW: 1.5, seatD: 0.4, seatH: 0.04, legH: 0.45, legW: 0.06, armH: 0.25, ...params };
    const m = new MeshBuilder("Bench");
    m.merge(genCube(p.seatW, p.seatH, p.seatD), [0, p.legH + p.seatH/2, 0]);
    const lx = p.seatW/2 - p.legW * 1.5, lz = p.seatD/2 - p.legW;
    for (const [x, z] of [[-lx, -lz], [-lx, lz], [lx, -lz], [lx, lz]])
      m.merge(genCube(p.legW, p.legH, p.legW), [x, p.legH/2, z]);
    const backY = p.legH + p.seatH;
    m.merge(genCube(p.seatW, p.seatH, p.legW), [0, backY + p.armH * 0.4, -lz]);
    m.merge(genCube(p.seatW, p.seatH, p.legW), [0, backY + p.armH * 0.8, -lz]);
    m.merge(genCube(p.legW, p.armH, p.legW), [-lx, backY + p.armH/2, -lz]);
    m.merge(genCube(p.legW, p.armH, p.legW), [lx, backY + p.armH/2, -lz]);
    m.merge(genCube(p.legW, p.seatH, p.seatD), [-lx, backY + p.seatH/2, 0]);
    m.merge(genCube(p.legW, p.seatH, p.seatD), [lx, backY + p.seatH/2, 0]);
    return m;
  },

  bridge(params) {
    const p = { span: 8, w: 3, deckH: 0.2, railH: 1, archR: 2, ...params };
    const m = new MeshBuilder("Bridge");
    m.merge(genCube(p.span, p.deckH, p.w), [0, 0, 0]);
    const posts = Math.floor(p.span / 1.5);
    for (let i = 0; i <= posts; i++) {
      const x = -p.span/2 + (p.span / posts) * i;
      m.merge(genCube(0.08, p.railH, 0.08), [x, p.railH/2, -p.w/2 + 0.04]);
      m.merge(genCube(0.08, p.railH, 0.08), [x, p.railH/2, p.w/2 - 0.04]);
    }
    m.merge(genCube(p.span, 0.06, 0.06), [0, p.railH, -p.w/2 + 0.04]);
    m.merge(genCube(p.span, 0.06, 0.06), [0, p.railH, p.w/2 - 0.04]);
    m.merge(genArch(p.archR, 0.4, 0, 12), [0, -p.deckH, 0]);
    return m;
  },

  tower(params) {
    const p = { floors: 5, baseR: 2, topR: 1.5, floorH: 3, segments: 12, ...params };
    const m = new MeshBuilder("Tower");
    const totalH = p.floors * p.floorH;
    m.merge(genCylinder(p.topR, p.baseR, totalH, p.segments), [0, totalH/2, 0]);
    for (let i = 0; i <= p.floors; i++) {
      const t = i / p.floors, y = t * totalH, r = p.baseR + (p.topR - p.baseR) * t;
      m.merge(genCylinder(r + 0.15, r + 0.15, 0.15, p.segments), [0, y, 0]);
    }
    m.merge(genCone(p.topR * 0.9, p.floorH * 0.8, p.segments), [0, totalH + p.floorH * 0.4, 0]);
    return m;
  },

  house(params) {
    const p = { w: 8, d: 6, wallH: 3, roofH: 2, roofOverhang: 0.5, ...params };
    const m = new MeshBuilder("House");
    m.merge(genCube(p.w, p.wallH, p.d), [0, p.wallH/2, 0]);
    const roof = new MeshBuilder("Roof");
    const hw = p.w/2 + p.roofOverhang, hd = p.d/2 + p.roofOverhang;
    roof.addVertices([[-hw, 0, -hd], [hw, 0, -hd], [hw, 0, hd], [-hw, 0, hd], [0, p.roofH, -hd], [0, p.roofH, hd]]);
    roof.addTri(0, 4, 1).addTri(2, 5, 3).addQuad(0, 3, 5, 4).addQuad(1, 4, 5, 2).addQuad(0, 1, 2, 3);
    m.merge(roof, [0, p.wallH, 0]);
    m.merge(genCube(1.2, 2.2, 0.15), [0, 1.1, -p.d/2 - 0.07]);
    m.merge(genStairs(2, 1.8, 0.3, 0.5), [0, 0, -p.d/2 - 0.5]);
    const nWin = Math.floor((p.w - 3) / 2);
    for (let i = 0; i < nWin; i++) {
      const wx = -p.w/2 + 1.5 + i * 2;
      m.merge(genCube(0.9, 1.2, 0.1), [wx, p.wallH * 0.55, -p.d/2 - 0.05]);
      m.merge(genCube(0.9, 1.2, 0.1), [wx, p.wallH * 0.55, p.d/2 + 0.05]);
    }
    return m;
  },

  boat(params) {
    const p = { length: 4, w: 1.5, h: 0.6, mastH: 3, ...params };
    const m = new MeshBuilder("Boat");
    const hull = new MeshBuilder("Hull");
    const seg = 12;
    for (let i = 0; i <= seg; i++) {
      const t = i / seg, x = (t - 0.5) * p.length;
      const wf = Math.sin(t * PI) * p.w / 2;
      hull.vertices.push([x, 0, -wf], [x, 0, wf], [x, -p.h * Math.sin(t * PI) * 0.5, 0]);
    }
    for (let i = 0; i < seg; i++) {
      const b = i * 3;
      hull.addTri(b, b + 3, b + 5).addTri(b, b + 5, b + 2);
      hull.addTri(b + 1, b + 2, b + 5).addTri(b + 1, b + 5, b + 4);
    }
    m.merge(hull);
    m.merge(genCylinder(0.03, 0.04, p.mastH, 8), [0, p.mastH/2, 0]);
    const sailH = p.mastH * 0.6;
    m.merge(genPlane(p.length * 0.4, sailH, 1, 4), [p.length * 0.05, p.mastH * 0.55, 0.01]);
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
  const allNodes = [
    ...scene.objects.map(obj => ({ name: obj.name, translation: obj.position, scale: obj.scale })),
    ...scene.lights.map(l => ({ name: l.name, translation: l.position, extensions: { KHR_lights_punctual: { light: scene.lights.indexOf(l) } } })),
    ...scene.cameras.map(c => ({ name: c.name, translation: c.position, camera: scene.cameras.indexOf(c) })),
  ];
  const gltf = {
    asset: { version: "2.0", generator: "Nexus 3D Modeler v3.0" },
    scenes: [{ name: scene.name, nodes: allNodes.map((_, i) => i) }],
    nodes: allNodes,
    meshes: [],
    materials: scene.materials.map(mat => ({
      name: mat.name,
      pbrMetallicRoughness: { baseColorFactor: mat.baseColor, metallicFactor: mat.metallic, roughnessFactor: mat.roughness },
      ...(mat.emissive ? { emissiveFactor: mat.emissive } : {}),
    })),
  };
  if (scene.lights.length) {
    gltf.extensions = { KHR_lights_punctual: { lights: scene.lights.map(l => ({
      name: l.name, type: l.type === "directional" ? "directional" : l.type === "spot" ? "spot" : "point",
      color: l.color, intensity: l.intensity, ...(l.range ? { range: l.range } : {}),
      ...(l.type === "spot" ? { spot: { innerConeAngle: (l.innerAngle || 25) * PI / 180, outerConeAngle: (l.outerAngle || 45) * PI / 180 } } : {}),
    })) } };
    gltf.extensionsUsed = ["KHR_lights_punctual"];
  }
  if (scene.cameras.length) {
    gltf.cameras = scene.cameras.map(c => c.type === "orthographic"
      ? { type: "orthographic", orthographic: { xmag: c.orthoScale, ymag: c.orthoScale, znear: c.near, zfar: c.far } }
      : { type: "perspective", perspective: { yfov: (c.fov || 50) * PI / 180, znear: c.near, zfar: c.far } });
  }
  return JSON.stringify(gltf, null, 2);
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

// ================= LIGHTING SYSTEM =================

const LIGHT_TYPES = {
  point: { type: "point", intensity: 1, color: [1, 1, 1], range: 10 },
  directional: { type: "directional", intensity: 1, color: [1, 1, 1], direction: [0, -1, -0.5] },
  spot: { type: "spot", intensity: 2, color: [1, 1, 1], range: 15, innerAngle: 25, outerAngle: 45 },
  ambient: { type: "ambient", intensity: 0.3, color: [1, 1, 1] },
};

const LIGHTING_PRESETS = {
  studio: [
    { ...LIGHT_TYPES.point, position: [3, 5, 3], intensity: 1.2, name: "Key" },
    { ...LIGHT_TYPES.point, position: [-3, 3, 2], intensity: 0.6, color: [0.8, 0.85, 1], name: "Fill" },
    { ...LIGHT_TYPES.point, position: [0, 4, -3], intensity: 0.4, name: "Rim" },
    { ...LIGHT_TYPES.ambient, intensity: 0.15, name: "Ambient" },
  ],
  outdoor: [
    { ...LIGHT_TYPES.directional, direction: [-0.5, -1, -0.3], intensity: 1.5, color: [1, 0.98, 0.9], name: "Sun" },
    { ...LIGHT_TYPES.ambient, intensity: 0.4, color: [0.7, 0.8, 1], name: "Sky" },
  ],
  sunset: [
    { ...LIGHT_TYPES.directional, direction: [-1, -0.3, 0], intensity: 1.2, color: [1, 0.6, 0.3], name: "Sun" },
    { ...LIGHT_TYPES.ambient, intensity: 0.2, color: [0.4, 0.3, 0.5], name: "Sky" },
    { ...LIGHT_TYPES.point, position: [0, 0.5, 0], intensity: 0.1, color: [1, 0.7, 0.4], name: "Bounce" },
  ],
  dramatic: [
    { ...LIGHT_TYPES.spot, position: [0, 8, 0], intensity: 3, color: [1, 0.95, 0.85], innerAngle: 15, outerAngle: 30, name: "Spotlight" },
    { ...LIGHT_TYPES.ambient, intensity: 0.05, name: "Ambient" },
  ],
  night: [
    { ...LIGHT_TYPES.ambient, intensity: 0.02, color: [0.15, 0.15, 0.3], name: "Moonlight" },
    { ...LIGHT_TYPES.directional, direction: [0.2, -1, 0.3], intensity: 0.15, color: [0.6, 0.7, 1], name: "Moon" },
  ],
};

function addLight(scene, opts) {
  const light = {
    id: "light_" + crypto.randomBytes(4).toString("hex"),
    name: opts.name || opts.type || "Light",
    type: opts.type || "point",
    position: opts.position || [0, 5, 0],
    direction: opts.direction || [0, -1, 0],
    color: opts.color || [1, 1, 1],
    intensity: opts.intensity ?? 1,
    range: opts.range || 10,
    innerAngle: opts.innerAngle,
    outerAngle: opts.outerAngle,
    castShadow: opts.castShadow !== false,
    shadowBias: opts.shadowBias || 0.001,
  };
  scene.lights.push(light);
  return light;
}

function addCamera(scene, opts) {
  opts = opts || {};
  const cam = {
    id: "cam_" + crypto.randomBytes(4).toString("hex"),
    name: opts.name || "Camera",
    type: opts.type || "perspective",
    position: opts.position || [0, 3, 8],
    target: opts.target || [0, 0, 0],
    fov: opts.fov || 50,
    near: opts.near || 0.1,
    far: opts.far || 1000,
    orthoScale: opts.orthoScale || 5,
  };
  scene.cameras.push(cam);
  return cam;
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
    description: "Generate a 3D object and add it to a scene. HIGH-LEVEL types (recommended): chair, table, building, tree, car, sword, terrain, wall, column, fence, lamp, bookshelf, barrel, crate, bench, bridge, tower, house, boat. PRIMITIVES: cube, sphere, cylinder, plane, torus, cone, wedge, stairs, arch. Use high-level types whenever possible — they produce realistic multi-part models automatically.",
    input: {
      type: "object",
      properties: {
        sceneId: { type: "string" },
        type: { type: "string", description: "Object type — use high-level types (chair, table, building, tree, car, sword, terrain, wall, column, fence, lamp, bookshelf, barrel, crate, bench, bridge, tower, house, boat) for realistic results, or primitives (cube, sphere, cylinder, plane, torus, cone, wedge, stairs, arch) for custom shapes" },
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
        availableLightingPresets: Object.keys(LIGHTING_PRESETS),
      };
    },
  },
  {
    name: "add_3d_light",
    description: "Add a light to a 3D scene. Types: point, directional, spot, ambient. Or use a PRESET for instant pro lighting: studio (3-point), outdoor (sun+sky), sunset, dramatic (spotlight), night (moonlight).",
    input: {
      type: "object",
      properties: {
        sceneId: { type: "string" },
        preset: { type: "string", description: "Lighting preset (studio, outdoor, sunset, dramatic, night) — adds multiple lights at once" },
        type: { type: "string", description: "Light type: point, directional, spot, ambient" },
        position: { type: "array", description: "[x, y, z] position" },
        color: { type: "array", description: "[r, g, b] color 0-1" },
        intensity: { type: "number", description: "Light intensity (default 1)" },
        castShadow: { type: "boolean", description: "Whether this light casts shadows (default true)" },
        name: { type: "string" },
      },
      required: ["sceneId"],
    },
    tags: ["3d", "light", "scene"],
    source: "builtin",
    run: async (input) => {
      const scene = scenes.get(input.sceneId);
      if (!scene) return { error: "Scene not found" };
      if (input.preset) {
        const preset = LIGHTING_PRESETS[input.preset];
        if (!preset) return { error: "Unknown preset: " + input.preset + ". Available: " + Object.keys(LIGHTING_PRESETS).join(", ") };
        const added = [];
        for (const lp of preset) { const l = addLight(scene, lp); added.push({ id: l.id, name: l.name, type: l.type }); }
        return { preset: input.preset, lightsAdded: added.length, lights: added };
      }
      const light = addLight(scene, input);
      return { lightId: light.id, name: light.name, type: light.type, intensity: light.intensity };
    },
  },
  {
    name: "add_3d_camera",
    description: "Add a camera to a 3D scene. Position the camera and point it at a target. Types: perspective (realistic depth), orthographic (flat/isometric).",
    input: {
      type: "object",
      properties: {
        sceneId: { type: "string" },
        position: { type: "array", description: "[x, y, z] camera position" },
        target: { type: "array", description: "[x, y, z] what the camera looks at" },
        fov: { type: "number", description: "Field of view in degrees (default 50)" },
        type: { type: "string", description: "perspective or orthographic" },
        name: { type: "string" },
      },
      required: ["sceneId"],
    },
    tags: ["3d", "camera", "scene"],
    source: "builtin",
    run: async (input) => {
      const scene = scenes.get(input.sceneId);
      if (!scene) return { error: "Scene not found" };
      const cam = addCamera(scene, input);
      return { cameraId: cam.id, name: cam.name, type: cam.type, position: cam.position, target: cam.target, fov: cam.fov };
    },
  },
  {
    name: "create_3d_mesh",
    description: "Create a COMPLETELY CUSTOM 3D mesh from raw vertices and faces. Use this when presets aren't enough — the AI defines every vertex and face for a truly unique model. Vertices are [x,y,z] arrays. Faces are arrays of vertex indices (0-based). You can build ANY shape: organic curves, complex architecture, abstract art, custom furniture, game props, sculptures.",
    input: {
      type: "object",
      properties: {
        sceneId: { type: "string" },
        name: { type: "string", description: "Name for this custom mesh" },
        vertices: { type: "array", description: "Array of [x,y,z] vertex positions", items: { type: "array" } },
        faces: { type: "array", description: "Array of face index arrays (triangles [a,b,c] or quads [a,b,c,d])", items: { type: "array" } },
        position: { type: "array", description: "[x,y,z] position in scene" },
        scale: { type: "array", description: "[x,y,z] scale" },
        material: { type: "string", description: "Material preset name (metal, wood, glass, etc.)" },
      },
      required: ["sceneId", "vertices", "faces"],
    },
    tags: ["3d", "mesh", "custom", "freeform"],
    source: "builtin",
    run: async (input) => {
      const scene = scenes.get(input.sceneId);
      if (!scene) return { error: "Scene not found" };
      if (!Array.isArray(input.vertices) || input.vertices.length < 3) return { error: "Need at least 3 vertices" };
      if (!Array.isArray(input.faces) || !input.faces.length) return { error: "Need at least 1 face" };
      const m = new MeshBuilder(input.name || "Custom");
      m.addVertices(input.vertices.map(v => [v[0] || 0, v[1] || 0, v[2] || 0]));
      for (const f of input.faces) { if (Array.isArray(f) && f.length >= 3) m.addFace(f); }
      const obj = addObject(scene, m, { position: input.position, scale: input.scale });
      if (input.material && MATERIAL_PRESETS[input.material]) {
        const mat = { name: input.material, ...MATERIAL_PRESETS[input.material] };
        obj.material = mat; scene.materials.push(mat);
      }
      return { objectId: obj.id, name: obj.name, vertices: m.vertices.length, faces: m.faces.length };
    },
  },
  {
    name: "transform_3d_object",
    description: "Move, rotate, scale, duplicate, or mirror an existing object in the scene. Use for arranging objects, creating patterns, building arrays of repeated elements, or adjusting positions after creation.",
    input: {
      type: "object",
      properties: {
        sceneId: { type: "string" },
        objectId: { type: "string" },
        action: { type: "string", description: "move, rotate, scale, duplicate, mirror, delete" },
        position: { type: "array", description: "[x,y,z] — for move: new position; for duplicate: offset" },
        rotation: { type: "array", description: "[rx,ry,rz] rotation in degrees" },
        scale: { type: "array", description: "[sx,sy,sz] scale factor" },
        axis: { type: "string", description: "For mirror: x, y, or z" },
        count: { type: "integer", description: "For duplicate: number of copies (array pattern)" },
        spacing: { type: "array", description: "For duplicate+count: [dx,dy,dz] between each copy" },
      },
      required: ["sceneId", "objectId", "action"],
    },
    tags: ["3d", "transform", "modify"],
    source: "builtin",
    run: async (input) => {
      const scene = scenes.get(input.sceneId);
      if (!scene) return { error: "Scene not found" };
      const obj = scene.objects.find(o => o.id === input.objectId);
      if (!obj) return { error: "Object not found: " + input.objectId };
      if (input.action === "move") {
        obj.position = input.position || obj.position;
        return { action: "moved", objectId: obj.id, position: obj.position };
      }
      if (input.action === "rotate") {
        obj.rotation = input.rotation || obj.rotation;
        return { action: "rotated", objectId: obj.id, rotation: obj.rotation };
      }
      if (input.action === "scale") {
        obj.scale = input.scale || obj.scale;
        return { action: "scaled", objectId: obj.id, scale: obj.scale };
      }
      if (input.action === "delete") {
        scene.objects = scene.objects.filter(o => o.id !== input.objectId);
        return { action: "deleted", objectId: input.objectId };
      }
      if (input.action === "mirror") {
        const ax = { x: 0, y: 1, z: 2 }[input.axis || "x"] || 0;
        const g = obj.geometry; if (!g) return { error: "No geometry to mirror" };
        const m2 = new MeshBuilder(obj.name + "_mirror");
        for (const v of g.vertices) { const mv = [...v]; mv[ax] = -mv[ax]; m2.vertices.push(mv); }
        for (const f of g.faces) m2.faces.push([...f].reverse());
        const pos = [...obj.position]; pos[ax] = -pos[ax];
        const newObj = addObject(scene, m2, { position: pos, scale: [...obj.scale], material: obj.material });
        return { action: "mirrored", objectId: newObj.id, axis: input.axis || "x" };
      }
      if (input.action === "duplicate") {
        const n = input.count || 1;
        const sp = input.spacing || input.position || [1, 0, 0];
        const created = [];
        for (let i = 0; i < n; i++) {
          const pos = [obj.position[0] + sp[0] * (i + 1), obj.position[1] + sp[1] * (i + 1), obj.position[2] + sp[2] * (i + 1)];
          const m2 = new MeshBuilder(obj.name + "_copy" + (i + 1));
          m2.vertices = obj.geometry.vertices.map(v => [...v]);
          m2.faces = obj.geometry.faces.map(f => [...f]);
          const newObj = addObject(scene, m2, { position: pos, scale: [...obj.scale], material: obj.material });
          created.push(newObj.id);
        }
        return { action: "duplicated", copies: created.length, objectIds: created };
      }
      return { error: "Unknown action: " + input.action + ". Use: move, rotate, scale, duplicate, mirror, delete" };
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
  // Lighting
  LIGHT_TYPES, LIGHTING_PRESETS, addLight,
  // Camera
  addCamera,
  // Scene
  createScene, addObject, LAYER_TIERS,
  // Export
  exportScene, exportOBJ, exportGLTF, exportSTL,
  // NXP integration
  NXP_TOOLS,
};

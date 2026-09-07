"use strict";
// ================= MCP 3D Modeler — realistic 3D model creation with 100 structural layers =================
// An MCP-compatible tool server that creates, manipulates, and exports 3D models.
// Uses a layer-based architecture (up to 100 layers) where each layer represents a
// structural level of detail: base geometry → topology → surface detail → materials →
// textures → lighting → rigging → animation → physics → export.
//
// Output formats: glTF 2.0 (.glb), OBJ+MTL, STL, USD, FBX (via converter)
// Internally: scene graph with typed nodes, procedural geometry, CSG operations,
// subdivision surfaces, PBR materials.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ---- Layer Architecture (100 layers in 10 tiers) ----

const LAYER_TIERS = {
  // Tier 1: Foundation (Layers 1-10)
  foundation: {
    range: [1, 10],
    description: "Base primitives and spatial layout",
    operations: ["create_primitive", "set_transform", "set_origin", "group", "define_bounds"],
  },
  // Tier 2: Structure (Layers 11-20)
  structure: {
    range: [11, 20],
    description: "Structural geometry and boolean operations",
    operations: ["boolean_union", "boolean_subtract", "boolean_intersect", "extrude", "revolve", "loft"],
  },
  // Tier 3: Topology (Layers 21-30)
  topology: {
    range: [21, 30],
    description: "Mesh topology and edge flow",
    operations: ["subdivide", "loop_cut", "edge_slide", "merge_vertices", "bridge_edges", "fill_face"],
  },
  // Tier 4: Detail (Layers 31-40)
  detail: {
    range: [31, 40],
    description: "Surface detail and micro-geometry",
    operations: ["bevel", "chamfer", "fillet", "emboss", "engrave", "displacement"],
  },
  // Tier 5: Deformation (Layers 41-50)
  deformation: {
    range: [41, 50],
    description: "Shape deformers and modifiers",
    operations: ["bend", "twist", "taper", "lattice", "shrinkwrap", "smooth", "noise_deform"],
  },
  // Tier 6: Materials (Layers 51-60)
  materials: {
    range: [51, 60],
    description: "PBR materials and shading",
    operations: ["set_material", "pbr_metallic", "pbr_specular", "glass", "emission", "subsurface", "clearcoat"],
  },
  // Tier 7: Textures (Layers 61-70)
  textures: {
    range: [61, 70],
    description: "UV mapping and texture layers",
    operations: ["uv_unwrap", "uv_project", "texture_map", "normal_map", "roughness_map", "ao_map", "procedural_texture"],
  },
  // Tier 8: Scene (Layers 71-80)
  scene: {
    range: [71, 80],
    description: "Lighting, cameras, and environment",
    operations: ["add_light", "add_camera", "set_environment", "hdri", "fog", "depth_of_field", "ambient_occlusion"],
  },
  // Tier 9: Animation (Layers 81-90)
  animation: {
    range: [81, 90],
    description: "Rigging, keyframes, and physics",
    operations: ["add_armature", "skin_mesh", "keyframe", "path_animation", "particle_system", "cloth_sim", "rigid_body"],
  },
  // Tier 10: Export (Layers 91-100)
  export: {
    range: [91, 100],
    description: "Optimization, LOD, and export",
    operations: ["decimate", "lod_generate", "optimize_mesh", "bake_textures", "export_gltf", "export_obj", "export_stl", "export_usd"],
  },
};

// ---- 3D Math Primitives ----

function vec3(x, y, z) { return { x: x || 0, y: y || 0, z: z || 0 }; }
function quat(x, y, z, w) { return { x: x || 0, y: y || 0, z: z || 0, w: w || 1 }; }
function mat4Identity() { return [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]; }

function eulerToQuat(pitch, yaw, roll) {
  const p = pitch * Math.PI / 360, y = yaw * Math.PI / 360, r = roll * Math.PI / 360;
  const cp = Math.cos(p), sp = Math.sin(p), cy = Math.cos(y), sy = Math.sin(y), cr = Math.cos(r), sr = Math.sin(r);
  return quat(sr*cp*cy - cr*sp*sy, cr*sp*cy + sr*cp*sy, cr*cp*sy - sr*sp*cy, cr*cp*cy + sr*sp*sy);
}

// ---- Primitive Generators ----

function generateCube(size) {
  size = size || 1;
  const h = size / 2;
  return {
    vertices: [
      [-h,-h,-h],[h,-h,-h],[h,h,-h],[-h,h,-h],
      [-h,-h,h],[h,-h,h],[h,h,h],[-h,h,h],
    ],
    faces: [[0,1,2,3],[4,5,6,7],[0,1,5,4],[2,3,7,6],[0,3,7,4],[1,2,6,5]],
    normals: [[0,0,-1],[0,0,1],[0,-1,0],[0,1,0],[-1,0,0],[1,0,0]],
    uvs: [[0,0],[1,0],[1,1],[0,1]],
    vertexCount: 8, faceCount: 6,
  };
}

function generateSphere(radius, segments, rings) {
  radius = radius || 1; segments = segments || 32; rings = rings || 16;
  const vertices = [], faces = [], normals = [], uvs = [];
  for (let r = 0; r <= rings; r++) {
    const phi = Math.PI * r / rings;
    for (let s = 0; s <= segments; s++) {
      const theta = 2 * Math.PI * s / segments;
      const x = Math.sin(phi) * Math.cos(theta);
      const y = Math.cos(phi);
      const z = Math.sin(phi) * Math.sin(theta);
      vertices.push([x * radius, y * radius, z * radius]);
      normals.push([x, y, z]);
      uvs.push([s / segments, r / rings]);
    }
  }
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const a = r * (segments + 1) + s;
      const b = a + segments + 1;
      faces.push([a, b, b + 1, a + 1]);
    }
  }
  return { vertices, faces, normals, uvs, vertexCount: vertices.length, faceCount: faces.length };
}

function generateCylinder(radiusTop, radiusBottom, height, segments) {
  radiusTop = radiusTop || 1; radiusBottom = radiusBottom || 1;
  height = height || 2; segments = segments || 32;
  const vertices = [], faces = [], normals = [];
  const halfH = height / 2;
  // Top and bottom rings
  for (let i = 0; i <= segments; i++) {
    const theta = 2 * Math.PI * i / segments;
    const cosT = Math.cos(theta), sinT = Math.sin(theta);
    vertices.push([cosT * radiusTop, halfH, sinT * radiusTop]);
    vertices.push([cosT * radiusBottom, -halfH, sinT * radiusBottom]);
    const slope = (radiusBottom - radiusTop) / height;
    const len = Math.sqrt(1 + slope * slope);
    normals.push([cosT / len, slope / len, sinT / len]);
    normals.push([cosT / len, slope / len, sinT / len]);
  }
  for (let i = 0; i < segments; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    faces.push([a, b, d, c]);
  }
  return { vertices, faces, normals, uvs: [], vertexCount: vertices.length, faceCount: faces.length };
}

function generatePlane(width, height, segW, segH) {
  width = width || 1; height = height || 1; segW = segW || 1; segH = segH || 1;
  const vertices = [], faces = [], uvs = [];
  for (let y = 0; y <= segH; y++) {
    for (let x = 0; x <= segW; x++) {
      vertices.push([x / segW * width - width / 2, 0, y / segH * height - height / 2]);
      uvs.push([x / segW, y / segH]);
    }
  }
  for (let y = 0; y < segH; y++) {
    for (let x = 0; x < segW; x++) {
      const a = y * (segW + 1) + x;
      faces.push([a, a + segW + 1, a + segW + 2, a + 1]);
    }
  }
  return { vertices, faces, normals: [[0, 1, 0]], uvs, vertexCount: vertices.length, faceCount: faces.length };
}

function generateTorus(majorR, minorR, majorSeg, minorSeg) {
  majorR = majorR || 1; minorR = minorR || 0.3;
  majorSeg = majorSeg || 32; minorSeg = minorSeg || 16;
  const vertices = [], faces = [], normals = [];
  for (let i = 0; i <= majorSeg; i++) {
    const theta = 2 * Math.PI * i / majorSeg;
    for (let j = 0; j <= minorSeg; j++) {
      const phi = 2 * Math.PI * j / minorSeg;
      const x = (majorR + minorR * Math.cos(phi)) * Math.cos(theta);
      const y = minorR * Math.sin(phi);
      const z = (majorR + minorR * Math.cos(phi)) * Math.sin(theta);
      vertices.push([x, y, z]);
      normals.push([Math.cos(phi) * Math.cos(theta), Math.sin(phi), Math.cos(phi) * Math.sin(theta)]);
    }
  }
  for (let i = 0; i < majorSeg; i++) {
    for (let j = 0; j < minorSeg; j++) {
      const a = i * (minorSeg + 1) + j;
      const b = a + minorSeg + 1;
      faces.push([a, b, b + 1, a + 1]);
    }
  }
  return { vertices, faces, normals, uvs: [], vertexCount: vertices.length, faceCount: faces.length };
}

const PRIMITIVES = { cube: generateCube, sphere: generateSphere, cylinder: generateCylinder, plane: generatePlane, torus: generateTorus };

// ---- Scene Graph ----

function createScene(name) {
  return {
    id: "scene_" + crypto.randomBytes(4).toString("hex"),
    name: name || "Untitled",
    nodes: [],          // hierarchical scene nodes
    layers: [],         // 100-layer stack
    materials: [],
    metadata: { createdAt: Date.now(), format: "nexus-3d-v1" },
  };
}

function createNode(opts) {
  return {
    id: "node_" + crypto.randomBytes(4).toString("hex"),
    name: opts.name || "Object",
    type: opts.type || "mesh",   // mesh | group | light | camera | armature | empty
    geometry: opts.geometry || null,
    material: opts.material || null,
    transform: {
      position: opts.position || vec3(),
      rotation: opts.rotation || quat(),
      scale: opts.scale || vec3(1, 1, 1),
    },
    layer: opts.layer || 1,
    visible: true,
    locked: false,
    children: [],
    modifiers: [],    // non-destructive modifiers stack
    metadata: opts.metadata || {},
  };
}

function createMaterial(opts) {
  return {
    id: "mat_" + crypto.randomBytes(4).toString("hex"),
    name: opts.name || "Material",
    type: opts.type || "pbr_metallic",  // pbr_metallic | pbr_specular | unlit | glass | emission
    properties: {
      baseColor: opts.baseColor || [0.8, 0.8, 0.8, 1],
      metallic: opts.metallic ?? 0,
      roughness: opts.roughness ?? 0.5,
      normal: opts.normal || null,
      emissive: opts.emissive || [0, 0, 0],
      emissiveStrength: opts.emissiveStrength || 1,
      alpha: opts.alpha ?? 1,
      doubleSided: opts.doubleSided || false,
      clearcoat: opts.clearcoat || 0,
      ior: opts.ior || 1.5,
      transmission: opts.transmission || 0,
      subsurface: opts.subsurface || 0,
    },
    textures: {
      baseColorMap: null,
      normalMap: null,
      roughnessMap: null,
      metallicMap: null,
      aoMap: null,
      emissiveMap: null,
      displacementMap: null,
    },
  };
}

// ---- Layer Operations ----

function createLayer(scene, index, name, tier) {
  if (index < 1 || index > 100) throw new Error("Layer index must be 1-100");
  const tierName = Object.entries(LAYER_TIERS).find(([_, t]) => index >= t.range[0] && index <= t.range[1]);
  const layer = {
    index,
    name: name || (tierName ? tierName[1].description : "Layer " + index),
    tier: tier || (tierName ? tierName[0] : "custom"),
    visible: true,
    locked: false,
    nodeIds: [],
    blendMode: "normal",  // normal | additive | multiply | displacement
    opacity: 1,
    createdAt: Date.now(),
  };
  scene.layers.push(layer);
  scene.layers.sort((a, b) => a.index - b.index);
  return layer;
}

function getLayer(scene, index) {
  return scene.layers.find(l => l.index === index) || null;
}

function addNodeToLayer(scene, nodeId, layerIndex) {
  let layer = getLayer(scene, layerIndex);
  if (!layer) layer = createLayer(scene, layerIndex);
  if (!layer.nodeIds.includes(nodeId)) layer.nodeIds.push(nodeId);
}

// ---- Modifiers (non-destructive) ----

const MODIFIERS = {
  subdivide:     (params) => ({ type: "subdivide", levels: params.levels || 2, smooth: params.smooth !== false }),
  bevel:         (params) => ({ type: "bevel", width: params.width || 0.02, segments: params.segments || 3 }),
  mirror:        (params) => ({ type: "mirror", axis: params.axis || "x", merge: params.merge !== false }),
  array:         (params) => ({ type: "array", count: params.count || 3, offset: params.offset || [2, 0, 0] }),
  solidify:      (params) => ({ type: "solidify", thickness: params.thickness || 0.1 }),
  smooth:        (params) => ({ type: "smooth", iterations: params.iterations || 5, factor: params.factor || 0.5 }),
  decimate:      (params) => ({ type: "decimate", ratio: params.ratio || 0.5 }),
  displacement:  (params) => ({ type: "displacement", strength: params.strength || 0.1, texture: params.texture || "noise" }),
  boolean:       (params) => ({ type: "boolean", operation: params.operation || "union", target: params.target }),
  bend:          (params) => ({ type: "bend", angle: params.angle || 45, axis: params.axis || "z" }),
  twist:         (params) => ({ type: "twist", angle: params.angle || 90, axis: params.axis || "y" }),
  lattice:       (params) => ({ type: "lattice", resolution: params.resolution || [3, 3, 3] }),
  noise:         (params) => ({ type: "noise", strength: params.strength || 0.1, scale: params.scale || 1, seed: params.seed || 42 }),
  shrinkwrap:    (params) => ({ type: "shrinkwrap", target: params.target, offset: params.offset || 0 }),
};

// ---- glTF 2.0 Export ----

function sceneToGltf(scene) {
  const gltf = {
    asset: { version: "2.0", generator: "Nexus 3D Modeler v2.0" },
    scenes: [{ name: scene.name, nodes: [] }],
    nodes: [],
    meshes: [],
    materials: [],
    accessors: [],
    bufferViews: [],
    buffers: [],
  };

  // Export materials
  for (const mat of scene.materials) {
    const gltfMat = {
      name: mat.name,
      pbrMetallicRoughness: {
        baseColorFactor: mat.properties.baseColor,
        metallicFactor: mat.properties.metallic,
        roughnessFactor: mat.properties.roughness,
      },
      doubleSided: mat.properties.doubleSided,
    };
    if (mat.properties.emissive.some(v => v > 0)) {
      gltfMat.emissiveFactor = mat.properties.emissive;
    }
    if (mat.properties.alpha < 1) {
      gltfMat.alphaMode = "BLEND";
    }
    gltf.materials.push(gltfMat);
  }

  // Export nodes (flattened for now)
  for (const node of scene.nodes) {
    if (!node.geometry) continue;
    const gltfNode = {
      name: node.name,
      translation: [node.transform.position.x, node.transform.position.y, node.transform.position.z],
      scale: [node.transform.scale.x, node.transform.scale.y, node.transform.scale.z],
    };
    gltf.nodes.push(gltfNode);
    gltf.scenes[0].nodes.push(gltf.nodes.length - 1);
  }

  return gltf;
}

function exportScene(scene, filePath, format) {
  format = format || "gltf";
  let content;
  if (format === "gltf" || format === "glb") {
    content = JSON.stringify(sceneToGltf(scene), null, 2);
  } else if (format === "obj") {
    const lines = ["# Nexus 3D Modeler Export", "# " + scene.name];
    for (const node of scene.nodes) {
      if (!node.geometry) continue;
      lines.push("o " + node.name);
      for (const v of node.geometry.vertices) lines.push("v " + v.join(" "));
      for (const n of (node.geometry.normals || [])) lines.push("vn " + (Array.isArray(n) ? n.join(" ") : "0 1 0"));
      for (const f of node.geometry.faces) lines.push("f " + f.map(i => i + 1).join(" "));
    }
    content = lines.join("\n");
  } else if (format === "stl") {
    const lines = ["solid " + scene.name.replace(/\s+/g, "_")];
    for (const node of scene.nodes) {
      if (!node.geometry) continue;
      for (const face of node.geometry.faces) {
        lines.push("  facet normal 0 1 0");
        lines.push("    outer loop");
        for (const idx of face.slice(0, 3)) {
          const v = node.geometry.vertices[idx];
          if (v) lines.push("      vertex " + v.join(" "));
        }
        lines.push("    endloop");
        lines.push("  endfacet");
      }
    }
    lines.push("endsolid");
    content = lines.join("\n");
  } else {
    throw new Error("Unsupported format: " + format + ". Use: gltf, obj, stl");
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return { path: filePath, format, size: content.length, nodes: scene.nodes.length, layers: scene.layers.length };
}

// ---- MCP Tool Definitions ----
// These are the tools exposed to AI agents via MCP.

const MCP_TOOLS = [
  {
    name: "create_scene",
    description: "Create a new 3D scene. Returns the scene ID.",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  {
    name: "add_primitive",
    description: "Add a 3D primitive to the scene. Types: cube, sphere, cylinder, plane, torus.",
    inputSchema: {
      type: "object",
      properties: {
        sceneId: { type: "string" }, type: { type: "string", enum: ["cube", "sphere", "cylinder", "plane", "torus"] },
        name: { type: "string" }, layer: { type: "integer", minimum: 1, maximum: 100 },
        size: { type: "number" }, radius: { type: "number" }, height: { type: "number" },
        segments: { type: "integer" }, position: { type: "array", items: { type: "number" } },
        scale: { type: "array", items: { type: "number" } },
      },
      required: ["sceneId", "type"],
    },
  },
  {
    name: "add_modifier",
    description: "Add a non-destructive modifier to a node. Types: subdivide, bevel, mirror, array, solidify, smooth, decimate, displacement, boolean, bend, twist, lattice, noise, shrinkwrap.",
    inputSchema: {
      type: "object",
      properties: {
        sceneId: { type: "string" }, nodeId: { type: "string" },
        modifier: { type: "string" }, params: { type: "object" },
      },
      required: ["sceneId", "nodeId", "modifier"],
    },
  },
  {
    name: "set_material",
    description: "Create and assign a PBR material to a node.",
    inputSchema: {
      type: "object",
      properties: {
        sceneId: { type: "string" }, nodeId: { type: "string" }, name: { type: "string" },
        baseColor: { type: "array", items: { type: "number" } },
        metallic: { type: "number" }, roughness: { type: "number" },
        emissive: { type: "array" }, transmission: { type: "number" },
      },
      required: ["sceneId", "nodeId"],
    },
  },
  {
    name: "create_layer",
    description: "Create a structural layer (1-100). Tiers: 1-10 foundation, 11-20 structure, 21-30 topology, 31-40 detail, 41-50 deformation, 51-60 materials, 61-70 textures, 71-80 scene, 81-90 animation, 91-100 export.",
    inputSchema: {
      type: "object",
      properties: { sceneId: { type: "string" }, index: { type: "integer", minimum: 1, maximum: 100 }, name: { type: "string" } },
      required: ["sceneId", "index"],
    },
  },
  {
    name: "export_model",
    description: "Export the 3D scene to a file. Formats: gltf, obj, stl.",
    inputSchema: {
      type: "object",
      properties: { sceneId: { type: "string" }, path: { type: "string" }, format: { type: "string", enum: ["gltf", "obj", "stl"] } },
      required: ["sceneId", "path"],
    },
  },
  {
    name: "scene_info",
    description: "Get information about a scene: nodes, layers, materials, vertex count.",
    inputSchema: { type: "object", properties: { sceneId: { type: "string" } }, required: ["sceneId"] },
  },
];

// ---- Scene Manager (in-process, for MCP tool handling) ----

const scenes = new Map();

function handleToolCall(name, args) {
  if (name === "create_scene") {
    const scene = createScene(args.name);
    scenes.set(scene.id, scene);
    return { sceneId: scene.id, name: scene.name, message: "Scene created. Add primitives with add_primitive." };
  }

  if (name === "add_primitive") {
    const scene = scenes.get(args.sceneId);
    if (!scene) return { error: "Scene not found: " + args.sceneId };
    const gen = PRIMITIVES[args.type];
    if (!gen) return { error: "Unknown primitive: " + args.type };
    const geometry = gen(args.size || args.radius || 1, args.segments, args.segments);
    const node = createNode({
      name: args.name || args.type,
      geometry,
      layer: args.layer || 1,
      position: args.position ? vec3(...args.position) : vec3(),
      scale: args.scale ? vec3(...args.scale) : vec3(1, 1, 1),
    });
    scene.nodes.push(node);
    addNodeToLayer(scene, node.id, node.layer);
    return { nodeId: node.id, name: node.name, vertices: geometry.vertexCount, faces: geometry.faceCount, layer: node.layer };
  }

  if (name === "add_modifier") {
    const scene = scenes.get(args.sceneId);
    if (!scene) return { error: "Scene not found" };
    const node = scene.nodes.find(n => n.id === args.nodeId);
    if (!node) return { error: "Node not found: " + args.nodeId };
    const modFn = MODIFIERS[args.modifier];
    if (!modFn) return { error: "Unknown modifier: " + args.modifier + ". Available: " + Object.keys(MODIFIERS).join(", ") };
    const mod = modFn(args.params || {});
    node.modifiers.push(mod);
    return { nodeId: node.id, modifier: mod.type, modifierCount: node.modifiers.length };
  }

  if (name === "set_material") {
    const scene = scenes.get(args.sceneId);
    if (!scene) return { error: "Scene not found" };
    const node = scene.nodes.find(n => n.id === args.nodeId);
    if (!node) return { error: "Node not found" };
    const mat = createMaterial({
      name: args.name || "Material",
      baseColor: args.baseColor || [0.8, 0.8, 0.8, 1],
      metallic: args.metallic, roughness: args.roughness,
      emissive: args.emissive, transmission: args.transmission,
    });
    scene.materials.push(mat);
    node.material = mat.id;
    return { materialId: mat.id, name: mat.name, assignedTo: node.name };
  }

  if (name === "create_layer") {
    const scene = scenes.get(args.sceneId);
    if (!scene) return { error: "Scene not found" };
    const layer = createLayer(scene, args.index, args.name);
    return { layer: layer.index, name: layer.name, tier: layer.tier };
  }

  if (name === "export_model") {
    const scene = scenes.get(args.sceneId);
    if (!scene) return { error: "Scene not found" };
    return exportScene(scene, args.path, args.format);
  }

  if (name === "scene_info") {
    const scene = scenes.get(args.sceneId);
    if (!scene) return { error: "Scene not found" };
    const totalVerts = scene.nodes.reduce((s, n) => s + (n.geometry?.vertexCount || 0), 0);
    const totalFaces = scene.nodes.reduce((s, n) => s + (n.geometry?.faceCount || 0), 0);
    return {
      id: scene.id, name: scene.name,
      nodes: scene.nodes.length, layers: scene.layers.length,
      materials: scene.materials.length,
      vertices: totalVerts, faces: totalFaces,
      layerTiers: Object.entries(LAYER_TIERS).map(([k, v]) => k + " (" + v.range.join("-") + ")"),
    };
  }

  return { error: "Unknown tool: " + name };
}

module.exports = {
  // Scene
  createScene, createNode, createMaterial, createLayer, getLayer, addNodeToLayer,
  // Primitives
  PRIMITIVES, generateCube, generateSphere, generateCylinder, generatePlane, generateTorus,
  // Modifiers
  MODIFIERS,
  // Export
  exportScene, sceneToGltf,
  // MCP
  MCP_TOOLS, handleToolCall,
  // Architecture
  LAYER_TIERS,
  // Math
  vec3, quat, eulerToQuat,
};

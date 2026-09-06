"use strict";
// ================= Workspace Intelligence — auto-detect project type, stack, conventions =================
// Scans a project directory and builds a rich profile: language, framework, package manager,
// test runner, linter, CI, Docker, monorepo structure, entry points, and coding conventions.
// This lets every other system (planner, context engine, code gen) adapt to the project
// automatically — no manual configuration needed.

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

function run(cmd, cwd) {
  try { return execSync(cmd, { cwd, encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }).trim(); }
  catch (_) { return ""; }
}
function exists(cwd, ...parts) { try { return fs.existsSync(path.join(cwd, ...parts)); } catch (_) { return false; } }
function readJSON(cwd, file) { try { return JSON.parse(fs.readFileSync(path.join(cwd, file), "utf8")); } catch (_) { return null; } }

// ---- Detectors ----

function detectLanguages(cwd) {
  const exts = {};
  const out = run("find . -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' -not -path '*/build/*' -not -path '*/__pycache__/*' -name '*.?*' 2>/dev/null | head -500", cwd);
  for (const f of out.split("\n").filter(Boolean)) {
    const ext = (f.match(/\.([a-z0-9]+)$/i) || [])[1];
    if (ext) exts[ext.toLowerCase()] = (exts[ext.toLowerCase()] || 0) + 1;
  }
  const langMap = { js: "javascript", ts: "typescript", py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", c: "c", cpp: "cpp", cs: "csharp", php: "php", swift: "swift", kt: "kotlin", sh: "shell", jsx: "javascript", tsx: "typescript" };
  const langs = [];
  for (const [ext, count] of Object.entries(exts).sort((a, b) => b[1] - a[1])) {
    if (langMap[ext]) langs.push({ language: langMap[ext], ext, count });
  }
  return langs;
}

function detectFramework(cwd) {
  const pkg = readJSON(cwd, "package.json");
  const deps = pkg ? { ...pkg.dependencies, ...pkg.devDependencies } : {};
  // Node frameworks
  if (deps.next) return { name: "Next.js", type: "fullstack", runtime: "node" };
  if (deps.nuxt) return { name: "Nuxt", type: "fullstack", runtime: "node" };
  if (deps.svelte || deps["@sveltejs/kit"]) return { name: "SvelteKit", type: "fullstack", runtime: "node" };
  if (deps.react) return { name: "React", type: "frontend", runtime: "node" };
  if (deps.vue) return { name: "Vue", type: "frontend", runtime: "node" };
  if (deps.angular || deps["@angular/core"]) return { name: "Angular", type: "frontend", runtime: "node" };
  if (deps.express) return { name: "Express", type: "backend", runtime: "node" };
  if (deps.fastify) return { name: "Fastify", type: "backend", runtime: "node" };
  if (deps.hono) return { name: "Hono", type: "backend", runtime: "node" };
  if (deps.electron) return { name: "Electron", type: "desktop", runtime: "node" };
  // Python frameworks
  if (exists(cwd, "manage.py")) return { name: "Django", type: "backend", runtime: "python" };
  if (exists(cwd, "app.py") || exists(cwd, "wsgi.py")) {
    const appContent = run("head -20 app.py 2>/dev/null", cwd);
    if (/flask/i.test(appContent)) return { name: "Flask", type: "backend", runtime: "python" };
    if (/fastapi/i.test(appContent)) return { name: "FastAPI", type: "backend", runtime: "python" };
  }
  // Go
  if (exists(cwd, "go.mod")) return { name: "Go module", type: "backend", runtime: "go" };
  // Rust
  if (exists(cwd, "Cargo.toml")) return { name: "Cargo", type: "library", runtime: "rust" };
  return null;
}

function detectPackageManager(cwd) {
  if (exists(cwd, "bun.lockb") || exists(cwd, "bun.lock")) return "bun";
  if (exists(cwd, "pnpm-lock.yaml")) return "pnpm";
  if (exists(cwd, "yarn.lock")) return "yarn";
  if (exists(cwd, "package-lock.json")) return "npm";
  if (exists(cwd, "Pipfile.lock")) return "pipenv";
  if (exists(cwd, "poetry.lock")) return "poetry";
  if (exists(cwd, "uv.lock")) return "uv";
  if (exists(cwd, "requirements.txt")) return "pip";
  if (exists(cwd, "go.sum")) return "go";
  if (exists(cwd, "Cargo.lock")) return "cargo";
  if (exists(cwd, "Gemfile.lock")) return "bundler";
  return null;
}

function detectTestRunner(cwd) {
  const pkg = readJSON(cwd, "package.json");
  const deps = pkg ? { ...pkg.dependencies, ...pkg.devDependencies } : {};
  if (deps.vitest) return { runner: "vitest", cmd: "npx vitest" };
  if (deps.jest) return { runner: "jest", cmd: "npx jest" };
  if (deps.mocha) return { runner: "mocha", cmd: "npx mocha" };
  if (pkg?.scripts?.test) return { runner: "npm test", cmd: "npm test" };
  if (exists(cwd, "pytest.ini") || exists(cwd, "conftest.py") || exists(cwd, "pyproject.toml")) return { runner: "pytest", cmd: "pytest" };
  if (run("grep -rq 'node:test' src/ 2>/dev/null && echo yes", cwd)) return { runner: "node:test", cmd: "node --test" };
  return null;
}

function detectLinter(cwd) {
  const linters = [];
  if (exists(cwd, ".eslintrc.json") || exists(cwd, ".eslintrc.js") || exists(cwd, "eslint.config.js") || exists(cwd, "eslint.config.mjs")) linters.push("eslint");
  if (exists(cwd, "biome.json") || exists(cwd, "biome.jsonc")) linters.push("biome");
  if (exists(cwd, ".prettierrc") || exists(cwd, ".prettierrc.json") || exists(cwd, "prettier.config.js")) linters.push("prettier");
  if (exists(cwd, "ruff.toml") || exists(cwd, ".ruff.toml")) linters.push("ruff");
  if (exists(cwd, ".flake8") || exists(cwd, "setup.cfg")) linters.push("flake8");
  if (exists(cwd, "mypy.ini") || exists(cwd, ".mypy.ini")) linters.push("mypy");
  if (exists(cwd, ".golangci.yml")) linters.push("golangci-lint");
  if (exists(cwd, "clippy.toml")) linters.push("clippy");
  return linters;
}

function detectCI(cwd) {
  const ci = [];
  if (exists(cwd, ".github/workflows")) ci.push("github-actions");
  if (exists(cwd, ".gitlab-ci.yml")) ci.push("gitlab-ci");
  if (exists(cwd, "Jenkinsfile")) ci.push("jenkins");
  if (exists(cwd, ".circleci")) ci.push("circleci");
  if (exists(cwd, ".travis.yml")) ci.push("travis");
  if (exists(cwd, "render.yaml")) ci.push("render");
  if (exists(cwd, "vercel.json") || exists(cwd, ".vercel")) ci.push("vercel");
  if (exists(cwd, "netlify.toml")) ci.push("netlify");
  return ci;
}

function detectInfra(cwd) {
  const infra = [];
  if (exists(cwd, "Dockerfile") || exists(cwd, "docker-compose.yml") || exists(cwd, "docker-compose.yaml")) infra.push("docker");
  if (exists(cwd, "kubernetes") || exists(cwd, "k8s")) infra.push("kubernetes");
  if (exists(cwd, "terraform")) infra.push("terraform");
  if (exists(cwd, "serverless.yml")) infra.push("serverless");
  if (exists(cwd, "fly.toml")) infra.push("fly.io");
  if (exists(cwd, "railway.json") || exists(cwd, "railway.toml")) infra.push("railway");
  return infra;
}

function detectMonorepo(cwd) {
  const pkg = readJSON(cwd, "package.json");
  if (pkg?.workspaces) return { type: "npm-workspaces", packages: pkg.workspaces };
  if (exists(cwd, "pnpm-workspace.yaml")) return { type: "pnpm-workspaces" };
  if (exists(cwd, "lerna.json")) return { type: "lerna" };
  if (exists(cwd, "nx.json")) return { type: "nx" };
  if (exists(cwd, "turbo.json")) return { type: "turborepo" };
  return null;
}

function detectConventions(cwd) {
  const conventions = {};
  // Indentation
  const sample = run("find . -name '*.js' -o -name '*.ts' -o -name '*.py' | head -5 | xargs head -30 2>/dev/null", cwd);
  if (sample) {
    const tabLines = (sample.match(/^\t/gm) || []).length;
    const spaceLines = (sample.match(/^  /gm) || []).length;
    conventions.indent = tabLines > spaceLines ? "tabs" : "spaces";
    if (conventions.indent === "spaces") {
      const four = (sample.match(/^    \S/gm) || []).length;
      const two = (sample.match(/^  \S/gm) || []).length;
      conventions.indentSize = four > two ? 4 : 2;
    }
  }
  // Semicolons (JS/TS)
  const jsSample = run("find . -name '*.js' -not -path '*/node_modules/*' | head -3 | xargs tail -20 2>/dev/null", cwd);
  if (jsSample) {
    const semi = (jsSample.match(/;\s*$/gm) || []).length;
    const noSemi = (jsSample.match(/[^;{}\s]\s*$/gm) || []).length;
    if (semi + noSemi > 5) conventions.semicolons = semi > noSemi;
  }
  // Quotes
  if (jsSample) {
    const single = (jsSample.match(/'/g) || []).length;
    const double = (jsSample.match(/"/g) || []).length;
    conventions.quotes = single > double ? "single" : "double";
  }
  // Module system
  const pkg = readJSON(cwd, "package.json");
  if (pkg?.type === "module") conventions.modules = "esm";
  else if (sample && /require\s*\(/.test(sample)) conventions.modules = "commonjs";
  else if (sample && /\bimport\s/.test(sample)) conventions.modules = "esm";
  return conventions;
}

// ---- Main scan ----

function scanWorkspace(cwd) {
  const profile = {
    root: cwd,
    name: path.basename(cwd),
    languages: detectLanguages(cwd),
    primaryLanguage: null,
    framework: detectFramework(cwd),
    packageManager: detectPackageManager(cwd),
    testRunner: detectTestRunner(cwd),
    linters: detectLinter(cwd),
    ci: detectCI(cwd),
    infra: detectInfra(cwd),
    monorepo: detectMonorepo(cwd),
    conventions: detectConventions(cwd),
    hasGit: exists(cwd, ".git"),
    hasReadme: exists(cwd, "README.md"),
    hasLicense: exists(cwd, "LICENSE") || exists(cwd, "LICENSE.md"),
    scannedAt: Date.now(),
  };
  if (profile.languages.length) profile.primaryLanguage = profile.languages[0].language;
  return profile;
}

function workspaceSummary(profile) {
  const parts = [profile.name];
  if (profile.primaryLanguage) parts.push(profile.primaryLanguage);
  if (profile.framework) parts.push(profile.framework.name);
  if (profile.packageManager) parts.push(profile.packageManager);
  if (profile.testRunner) parts.push("tests:" + profile.testRunner.runner);
  if (profile.linters.length) parts.push("lint:" + profile.linters.join("+"));
  if (profile.ci.length) parts.push("ci:" + profile.ci.join("+"));
  if (profile.infra.length) parts.push(profile.infra.join("+"));
  if (profile.monorepo) parts.push("monorepo:" + profile.monorepo.type);
  return parts.join(" · ");
}

module.exports = { scanWorkspace, workspaceSummary, detectLanguages, detectFramework, detectPackageManager, detectTestRunner, detectLinter, detectCI, detectInfra, detectMonorepo, detectConventions };

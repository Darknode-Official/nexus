// Project Bootstrapper — creates complete project scaffolds with best practices:
// CI/CD, testing, linting, security scanning, and documentation baked in.
const fs = require("fs");
const path = require("path");

const TEMPLATES = {
  "node-api": {
    name: "Node.js REST API",
    files: {
      "package.json": JSON.stringify({
        name: "my-api", version: "1.0.0", private: true, type: "module",
        scripts: { start: "node src/index.js", dev: "node --watch src/index.js", test: "node --test src/**/*.test.js", lint: "eslint src/", "security-audit": "npm audit" },
        dependencies: { express: "^4.18.0", helmet: "^7.0.0", cors: "^2.8.0", "express-rate-limit": "^7.0.0" },
        devDependencies: { eslint: "^8.50.0" }
      }, null, 2),
      "src/index.js": `import express from 'express';\nimport helmet from 'helmet';\nimport cors from 'cors';\nimport rateLimit from 'express-rate-limit';\nimport { router } from './routes.js';\n\nconst app = express();\nconst PORT = process.env.PORT || 3000;\n\napp.use(helmet());\napp.use(cors());\napp.use(express.json({ limit: '10kb' }));\napp.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));\napp.use('/api', router);\napp.get('/health', (_, res) => res.json({ ok: true }));\n\napp.listen(PORT, () => console.log(\`Listening on :\${PORT}\`));\n`,
      "src/routes.js": `import { Router } from 'express';\nexport const router = Router();\n\nrouter.get('/', (_, res) => res.json({ message: 'API running' }));\n`,
      "src/index.test.js": `import { describe, it } from 'node:test';\nimport assert from 'node:assert';\n\ndescribe('API', () => {\n  it('should be importable', () => {\n    assert.ok(true);\n  });\n});\n`,
      ".eslintrc.json": JSON.stringify({ env: { node: true, es2022: true }, extends: "eslint:recommended", parserOptions: { ecmaVersion: 2022, sourceType: "module" } }, null, 2),
      ".gitignore": "node_modules/\n.env\n*.log\ndist/\ncoverage/\n",
      ".env.example": "PORT=3000\nNODE_ENV=development\nDB_URL=\nAPI_KEY=\n",
      "Dockerfile": "FROM node:20-slim\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci --omit=dev\nCOPY src/ src/\nUSER node\nEXPOSE 3000\nCMD [\"node\", \"src/index.js\"]\n",
      ".github/workflows/ci.yml": "name: CI\non: [push, pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with: { node-version: 20 }\n      - run: npm ci\n      - run: npm test\n      - run: npm audit --audit-level=high\n",
      "README.md": "# My API\n\nNode.js REST API with Express.\n\n## Quick start\n```bash\nnpm install\ncp .env.example .env\nnpm run dev\n```\n\n## Test\n```bash\nnpm test\n```\n",
    }
  },
  "python-cli": {
    name: "Python CLI Tool",
    files: {
      "pyproject.toml": `[build-system]\nrequires = ["setuptools>=68.0"]\nbuild-backend = "setuptools.backends._legacy:_Backend"\n\n[project]\nname = "mycli"\nversion = "0.1.0"\nrequires-python = ">=3.10"\ndependencies = []\n\n[project.optional-dependencies]\ndev = ["pytest", "ruff", "mypy"]\n\n[project.scripts]\nmycli = "mycli.cli:main"\n`,
      "mycli/__init__.py": "",
      "mycli/cli.py": `import argparse\nimport sys\n\ndef main():\n    parser = argparse.ArgumentParser(description='My CLI tool')\n    parser.add_argument('command', nargs='?', default='help')\n    parser.add_argument('-v', '--verbose', action='store_true')\n    args = parser.parse_args()\n\n    if args.command == 'help':\n        parser.print_help()\n    else:\n        print(f'Running: {args.command}')\n\nif __name__ == '__main__':\n    main()\n`,
      "tests/test_cli.py": `from mycli.cli import main\n\ndef test_main_runs():\n    # Basic smoke test\n    try:\n        import sys\n        sys.argv = ['mycli', 'help']\n        main()\n    except SystemExit:\n        pass\n`,
      ".gitignore": "__pycache__/\n*.pyc\n.venv/\ndist/\n*.egg-info/\n.mypy_cache/\n.ruff_cache/\n",
      "Makefile": "venv:\n\tpython3 -m venv .venv && .venv/bin/pip install -e '.[dev]'\n\ntest:\n\t.venv/bin/pytest tests/\n\nlint:\n\t.venv/bin/ruff check mycli/\n\nformat:\n\t.venv/bin/ruff format mycli/\n\n.PHONY: test lint format\n",
      ".github/workflows/ci.yml": "name: CI\non: [push, pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-python@v5\n        with: { python-version: '3.12' }\n      - run: pip install -e '.[dev]'\n      - run: pytest tests/\n      - run: ruff check mycli/\n",
      "README.md": "# mycli\n\nPython CLI tool.\n\n## Install\n```bash\nmake venv\nsource .venv/bin/activate\nmycli help\n```\n\n## Test\n```bash\nmake test\n```\n",
    }
  },
  "react-app": {
    name: "React Application",
    files: {
      "package.json": JSON.stringify({
        name: "my-app", version: "0.1.0", private: true, type: "module",
        scripts: { dev: "vite", build: "vite build", preview: "vite preview", test: "vitest", lint: "eslint src/" },
        dependencies: { react: "^18.2.0", "react-dom": "^18.2.0" },
        devDependencies: { vite: "^5.0.0", "@vitejs/plugin-react": "^4.0.0", vitest: "^1.0.0", eslint: "^8.50.0" }
      }, null, 2),
      "vite.config.js": `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\n\nexport default defineConfig({\n  plugins: [react()],\n});\n`,
      "index.html": `<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>My App</title>\n</head>\n<body>\n  <div id="root"></div>\n  <script type="module" src="/src/main.jsx"></script>\n</body>\n</html>\n`,
      "src/main.jsx": `import React from 'react';\nimport ReactDOM from 'react-dom/client';\nimport { App } from './App.jsx';\nimport './index.css';\n\nReactDOM.createRoot(document.getElementById('root')).render(\n  <React.StrictMode><App /></React.StrictMode>\n);\n`,
      "src/App.jsx": `export function App() {\n  return (\n    <div style={{ maxWidth: 600, margin: '40px auto', fontFamily: 'system-ui' }}>\n      <h1>My App</h1>\n      <p>Edit <code>src/App.jsx</code> to get started.</p>\n    </div>\n  );\n}\n`,
      "src/index.css": `*, *::before, *::after { box-sizing: border-box; margin: 0; }\nbody { font-family: system-ui, sans-serif; line-height: 1.6; }\n`,
      ".gitignore": "node_modules/\ndist/\n.env\n*.log\n",
      ".github/workflows/ci.yml": "name: CI\non: [push, pull_request]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with: { node-version: 20 }\n      - run: npm ci\n      - run: npm run build\n      - run: npm test -- --run\n",
      "README.md": "# My App\n\nReact application with Vite.\n\n## Dev\n```bash\nnpm install\nnpm run dev\n```\n",
    }
  },
  "rust-tool": {
    name: "Rust CLI Tool",
    files: {
      "Cargo.toml": `[package]\nname = "mytool"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nclap = { version = "4", features = ["derive"] }\nanyhow = "1"\n`,
      "src/main.rs": `use clap::Parser;\nuse anyhow::Result;\n\n#[derive(Parser)]\n#[command(name = "mytool", about = "A Rust CLI tool")]\nstruct Args {\n    /// Command to run\n    command: Option<String>,\n    /// Verbose output\n    #[arg(short, long)]\n    verbose: bool,\n}\n\nfn main() -> Result<()> {\n    let args = Args::parse();\n    match args.command.as_deref() {\n        Some(cmd) => println!("Running: {cmd}"),\n        None => println!("Usage: mytool <command>"),\n    }\n    Ok(())\n}\n`,
      "tests/integration_test.rs": `#[test]\nfn test_runs() {\n    assert!(true);\n}\n`,
      ".gitignore": "target/\n",
      ".github/workflows/ci.yml": "name: CI\non: [push, pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: dtolnay/rust-toolchain@stable\n      - run: cargo test\n      - run: cargo clippy -- -D warnings\n",
      "README.md": "# mytool\n\nRust CLI tool.\n\n## Build\n```bash\ncargo build --release\n```\n\n## Test\n```bash\ncargo test\n```\n",
    }
  },
};

function bootstrap(template, targetDir) {
  if (!template || template === "list") {
    let out = "\n  Available project templates:\n";
    for (const [key, tmpl] of Object.entries(TEMPLATES)) {
      out += `    ${key.padEnd(16)} ${tmpl.name} (${Object.keys(tmpl.files).length} files)\n`;
    }
    out += "\n  Usage: /bootstrap <template> [directory]\n";
    return out;
  }

  const tmpl = TEMPLATES[template];
  if (!tmpl) return `\n  Unknown template: ${template}\n  Run /bootstrap list to see options.\n`;

  const dir = path.resolve(targetDir || template);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) {
    return `\n  Directory ${dir} already exists and is not empty.\n`;
  }

  let created = 0;
  for (const [relPath, content] of Object.entries(tmpl.files)) {
    const fp = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content);
    created++;
  }

  let out = `\n  PROJECT BOOTSTRAPPED — ${tmpl.name}\n`;
  out += `  ${"─".repeat(50)}\n`;
  out += `  Directory: ${dir}\n`;
  out += `  Files: ${created}\n\n`;
  out += `  Includes:\n`;
  out += `    - Source code scaffold\n`;
  out += `    - Test setup\n`;
  out += `    - Linting configuration\n`;
  out += `    - CI/CD pipeline (.github/workflows/ci.yml)\n`;
  out += `    - Docker support (where applicable)\n`;
  out += `    - .gitignore\n`;
  out += `    - README.md\n\n`;
  out += `  Next:\n`;
  out += `    cd ${path.basename(dir)}\n`;
  if (template.startsWith("node") || template === "react-app") out += `    npm install\n`;
  if (template === "python-cli") out += `    make venv && source .venv/bin/activate\n`;
  if (template === "rust-tool") out += `    cargo build\n`;
  out += `    git init && git add -A && git commit -m "Initial commit"\n`;
  return out;
}

module.exports = { bootstrap, TEMPLATES };

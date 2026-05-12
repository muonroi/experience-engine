'use strict';
/**
 * source-meta-enrich.js — Caller-side language/framework detection for hooks.
 *
 * Self-contained, zero npm dependencies, safe to ship in thin-client installs.
 * Mirrors a subset of src/utils.js (detectContext, detectFrameworkFromProject,
 * extractProjectPath) so interceptors can enrich sourceMeta without pulling
 * in the full local brain code path.
 *
 * The repo contains ZERO hardcoded org/framework names by design (matches
 * the existing `org.repoPatterns` convention in src/utils.js). Specific
 * org frameworks are configured via ~/.experience/config.json:
 *
 *   {
 *     "org": {
 *       "name": "<orgName>",
 *       "repoPatterns": ["..."],
 *       "frameworkPackages": {
 *         "<frameworkLabel>": {
 *           "nuget": ["<prefix>", ...],
 *           "npm":   ["<prefix>", ...]
 *         },
 *         ...
 *       }
 *     }
 *   }
 *
 * When no `frameworkPackages` is configured, .NET projects detect as the
 * generic 'dotnet' label and JS/TS projects fall back to the built-in
 * generic PKG_DEP_FW table (next/nest/react/...).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const LANG_MAP = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript React',
  '.js': 'JavaScript', '.jsx': 'JavaScript React',
  '.cs': 'C#', '.fs': 'F#',
  '.py': 'Python', '.rb': 'Ruby',
  '.rs': 'Rust', '.go': 'Go',
  '.java': 'Java', '.kt': 'Kotlin',
  '.swift': 'Swift', '.cpp': 'C++', '.c': 'C',
  '.lua': 'Lua', '.sh': 'Shell', '.bash': 'Shell',
  '.ps1': 'PowerShell', '.psm1': 'PowerShell',
  '.sql': 'SQL', '.graphql': 'GraphQL',
  '.html': 'HTML', '.css': 'CSS', '.scss': 'SCSS',
  '.yaml': 'YAML', '.yml': 'YAML', '.json': 'JSON',
  '.xml': 'XML', '.proto': 'Protobuf',
  '.dockerfile': 'Docker', '.tf': 'Terraform',
};

function detectContext(filePath) {
  if (!filePath) return null;
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('.');
  if (parts.length < 2) return null;
  const ext = '.' + parts.pop().toLowerCase();
  return LANG_MAP[ext] || null;
}

const FW_CACHE = new Map();
const FW_CACHE_MAX = 256;

const FW_MARKERS = [
  { ext: '.csproj', framework: 'dotnet' },
  { ext: '.fsproj', framework: 'dotnet' },
  { ext: '.sln', framework: 'dotnet' },
  { file: 'Cargo.toml', framework: 'rust' },
  { file: 'go.mod', framework: 'go' },
  { file: 'pyproject.toml', framework: 'python' },
  { file: 'requirements.txt', framework: 'python' },
  { file: 'pom.xml', framework: 'java' },
  { file: 'build.gradle', framework: 'java' },
  { file: 'build.gradle.kts', framework: 'java' },
  { file: 'Gemfile', framework: 'ruby' },
];

const PKG_DEP_FW = [
  { dep: 'next', framework: 'next' },
  { dep: '@nestjs/core', framework: 'nest' },
  { dep: 'nuxt', framework: 'nuxt' },
  { dep: 'react-native', framework: 'react-native' },
  { dep: 'expo', framework: 'expo' },
  { dep: 'react', framework: 'react' },
  { dep: 'vue', framework: 'vue' },
  { dep: 'svelte', framework: 'svelte' },
  { dep: 'electron', framework: 'electron' },
];

const CSPROJ_READ_CAP = 64 * 1024; // bound .csproj reads to keep hot path cheap

// Config loader (cached, fail-open). Returns {} when config absent so the
// engine runs in generic mode without surfacing errors to the agent.
let _configCache = null;
function _loadConfig() {
  if (_configCache !== null) return _configCache;
  try {
    const cfgPath = path.join(os.homedir(), '.experience', 'config.json');
    _configCache = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) || {};
  } catch { _configCache = {}; }
  return _configCache;
}

function _normalizeFrameworkPackages(input) {
  // Accept either:
  //   { "<framework>": { nuget: [...], npm: [...] } }
  // and ignore malformed entries silently.
  if (!input || typeof input !== 'object') return {};
  const out = {};
  for (const [name, defs] of Object.entries(input)) {
    if (!name || typeof name !== 'string' || !defs || typeof defs !== 'object') continue;
    const nuget = Array.isArray(defs.nuget) ? defs.nuget.filter(s => typeof s === 'string' && s.length) : [];
    const npm = Array.isArray(defs.npm) ? defs.npm.filter(s => typeof s === 'string' && s.length) : [];
    if (nuget.length || npm.length) out[name] = { nuget, npm };
  }
  return out;
}

function _matchPackageToFramework(packages, channel, pkgName) {
  // channel: 'nuget' | 'npm'.  pkgName: the dep identifier to test.
  for (const [framework, defs] of Object.entries(packages)) {
    const patterns = defs[channel] || [];
    for (const prefix of patterns) {
      if (pkgName.startsWith(prefix)) return framework;
    }
  }
  return null;
}

function _extractCsprojIncludes(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const size = Math.min(stat.size, CSPROJ_READ_CAP);
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, 0);
      const text = buf.toString('utf8');
      const out = [];
      // Match Include="..." (PackageReference, ProjectReference, Reference)
      const re = /\bInclude\s*=\s*["']([^"']+)["']/gi;
      let m;
      while ((m = re.exec(text)) !== null) out.push(m[1]);
      return out;
    } finally { fs.closeSync(fd); }
  } catch { return []; }
}

function scanDirForFramework(dir, packages) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return null; }

  const fileNames = [];
  for (const e of entries) if (e.isFile()) fileNames.push(e.name);
  const fileNameSet = new Set(fileNames);

  // .NET: detect marker, then refine by scanning Include="..." patterns
  // against the configured frameworkPackages.nuget list.
  const dotnetMarkers = fileNames.filter(n => /\.(cs|fs)proj$|\.sln$/i.test(n)).slice(0, 4);
  if (dotnetMarkers.length > 0) {
    if (Object.keys(packages).length > 0) {
      for (const m of dotnetMarkers) {
        const includes = _extractCsprojIncludes(`${dir}/${m}`);
        for (const inc of includes) {
          // Strip leading path segments so a ProjectReference like
          //   ..\..\Foo.Bar\Foo.Bar.csproj  is matched against "Foo.Bar"
          const stripped = inc.replace(/^.*[\/\\]/, '');
          const matched = _matchPackageToFramework(packages, 'nuget', stripped);
          if (matched) return matched;
        }
      }
    }
    return 'dotnet';
  }

  for (const m of FW_MARKERS) {
    if (m.ext) continue;
    if (m.file && fileNameSet.has(m.file)) return m.framework;
  }

  if (fileNameSet.has('package.json')) {
    try {
      const pkg = JSON.parse(fs.readFileSync(`${dir}/package.json`, 'utf8'));
      const deps = Object.assign({}, pkg.dependencies || {}, pkg.devDependencies || {});
      // Org-configured framework packages take precedence over the built-in
      // generic table — a consumer that happens to also use react still
      // classifies under the org's framework label.
      if (Object.keys(packages).length > 0) {
        for (const depName of Object.keys(deps)) {
          const matched = _matchPackageToFramework(packages, 'npm', depName);
          if (matched) return matched;
        }
      }
      for (const { dep, framework } of PKG_DEP_FW) {
        if (deps[dep]) return framework;
      }
      return null;
    } catch { return null; }
  }
  return null;
}

function _resolvePackages(opts) {
  if (opts && opts.frameworkPackages !== undefined) {
    return _normalizeFrameworkPackages(opts.frameworkPackages);
  }
  const cfg = _loadConfig();
  return _normalizeFrameworkPackages(cfg && cfg.org && cfg.org.frameworkPackages);
}

function detectFrameworkFromProject(filePath, opts) {
  if (!filePath) return null;
  const packages = _resolvePackages(opts);
  // Cache key includes packages signature so tests injecting different
  // patterns do not collide with each other or with the config-loaded form.
  const sig = (opts && opts.frameworkPackages !== undefined)
    ? JSON.stringify(packages) + '::'
    : '';
  let dir = path.dirname(filePath.replace(/\\/g, '/'));
  for (let i = 0; i < 8; i++) {
    if (!dir || dir === '/' || dir === '.' || /^[A-Za-z]:\/?$/.test(dir)) break;
    const key = sig + dir;
    if (FW_CACHE.has(key)) return FW_CACHE.get(key);
    const fw = scanDirForFramework(dir, packages);
    if (fw) {
      if (FW_CACHE.size >= FW_CACHE_MAX) FW_CACHE.clear();
      FW_CACHE.set(key, fw);
      return fw;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function extractFilePath(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return null;
  const raw = toolInput.file_path || toolInput.path || '';
  if (raw && typeof raw === 'string') return raw.replace(/\\/g, '/');
  return null;
}

function enrichSourceMeta(toolInput, opts) {
  const out = {};
  const filePath = extractFilePath(toolInput);
  if (!filePath) return out;
  const lang = detectContext(filePath);
  const framework = detectFrameworkFromProject(filePath, opts);
  if (lang) out.lang = lang;
  if (framework) out.framework = framework;
  return out;
}

// Exposed for tests so config cache can be cleared between cases.
function _resetCachesForTesting() {
  FW_CACHE.clear();
  _configCache = null;
}

module.exports = { enrichSourceMeta, detectContext, detectFrameworkFromProject, _resetCachesForTesting };

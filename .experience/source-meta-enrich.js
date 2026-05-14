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
  { dep: '@angular/core', framework: 'angular' },
  { dep: 'react-native', framework: 'react-native' },
  { dep: 'expo', framework: 'expo' },
  { dep: 'astro', framework: 'astro' },
  { dep: 'solid-js', framework: 'solid' },
  { dep: '@remix-run/react', framework: 'remix' },
  { dep: 'react', framework: 'react' },
  { dep: 'vue', framework: 'vue' },
  { dep: 'svelte', framework: 'svelte' },
  { dep: 'electron', framework: 'electron' },
];

// Conventional source-root directory names. When the project root has no
// markers, descend into one of these before walking up. Many monorepo /
// next.js / dotnet repos put the actual project under `src/` or `apps/`.
const _COMMON_SRC_DIRS = ['src', 'apps', 'packages', 'app', 'server', 'client', 'web'];

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

function _readBoundedText(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const size = Math.min(stat.size, CSPROJ_READ_CAP);
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, 0);
      return buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}

function _extractCsprojIncludes(filePath) {
  const text = _readBoundedText(filePath);
  if (!text) return [];
  const out = [];
  // Match Include="..." (PackageReference, ProjectReference, Reference)
  const re = /\bInclude\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

// Solution files (.sln) reference projects via lines like:
//   Project("{GUID}") = "Name", "path\Name.csproj", "{GUID}"
// _extractCsprojIncludes' Include="..." regex misses these, so a separate
// substring scan covers .sln (also harmlessly catches any matching text in
// .csproj if a consumer ever calls this on one).
function _slnReferencesPrefix(filePath, prefix) {
  const text = _readBoundedText(filePath);
  return !!(text && text.includes(prefix));
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
  const hasCsprojHere = dotnetMarkers.some(n => /\.(cs|fs)proj$/i.test(n));
  if (dotnetMarkers.length > 0) {
    // Monorepo guard: when the directory has only a .sln (no .csproj/.fsproj
    // at THIS level) alongside a package.json, defer to the npm side first.
    // Hybrid TS+.NET workspaces (e.g. UI engines that ship a Blazor host)
    // would otherwise always classify as .NET despite the .sln being a
    // build-tooling artifact, not the work surface. The .sln scan still
    // runs below if the npm side yields no match.
    const npmFirst = !hasCsprojHere && fileNameSet.has('package.json') && Object.keys(packages).length > 0;
    if (npmFirst) {
      try {
        const pkg = JSON.parse(fs.readFileSync(`${dir}/package.json`, 'utf8'));
        const deps = Object.assign({}, pkg.dependencies || {}, pkg.devDependencies || {}, pkg.peerDependencies || {});
        for (const depName of Object.keys(deps)) {
          const matched = _matchPackageToFramework(packages, 'npm', depName);
          if (matched) return matched;
        }
      } catch { /* fall through to .sln scan */ }
    }
    if (Object.keys(packages).length > 0) {
      for (const m of dotnetMarkers) {
        const filePath = `${dir}/${m}`;
        // .csproj/.fsproj: structured Include="..." parsing.
        const includes = _extractCsprojIncludes(filePath);
        for (const inc of includes) {
          // Strip leading path segments so a ProjectReference like
          //   ..\..\Foo.Bar\Foo.Bar.csproj  is matched against "Foo.Bar"
          const stripped = inc.replace(/^.*[\/\\]/, '');
          const matched = _matchPackageToFramework(packages, 'nuget', stripped);
          if (matched) return matched;
        }
        // .sln: fall back to substring scan against configured nuget prefixes,
        // since Solution files reference projects via Project("{...}") = "Name",
        // not Include="..." attributes.
        if (/\.sln$/i.test(m)) {
          for (const [framework, defs] of Object.entries(packages)) {
            for (const prefix of (defs.nuget || [])) {
              if (_slnReferencesPrefix(filePath, prefix)) return framework;
            }
          }
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
      const deps = Object.assign({}, pkg.dependencies || {}, pkg.devDependencies || {}, pkg.peerDependencies || {});
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
  // Accept either a file path or a directory path. stop-extractor.js passes
  // the session's cwd (a directory) — taking path.dirname() of that walks
  // one level above the project root and misses package.json/.csproj.
  const normalized = filePath.replace(/\\/g, '/');
  let dir;
  try {
    dir = fs.statSync(normalized).isDirectory() ? normalized : path.dirname(normalized);
  } catch {
    dir = path.dirname(normalized);
  }
  for (let i = 0; i < 8; i++) {
    if (!dir || dir === '/' || dir === '.' || /^[A-Za-z]:\/?$/.test(dir)) break;
    const key = sig + dir;
    if (FW_CACHE.has(key)) return FW_CACHE.get(key);
    let fw = scanDirForFramework(dir, packages);
    // Descend one level into conventional source dirs when the current level
    // has no markers. Real-world repos commonly hold the actual project under
    // src/, apps/, packages/, etc.; without this fallback, a stop-hook that
    // only knows the repo root would yield no framework hint at all.
    if (!fw) {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        const subdirNames = new Set();
        for (const e of entries) if (e.isDirectory()) subdirNames.add(e.name);
        for (const name of _COMMON_SRC_DIRS) {
          if (!subdirNames.has(name)) continue;
          const sub = scanDirForFramework(`${dir}/${name}`, packages);
          if (sub) { fw = sub; break; }
        }
      } catch { /* ignore */ }
    }
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

// Map framework label → default language. Used by the cwd fallback path when
// no concrete file ext is available (Bash hooks, UserPromptSubmit). The lang
// is a best-effort default per ecosystem; the scope filter remains opt-in on
// the caller side so a wrong guess still passes through `is_empty`/`any`.
const _FW_DEFAULT_LANG = {
  dotnet: 'C#',
  rust: 'Rust',
  go: 'Go',
  python: 'Python',
  java: 'Java',
  ruby: 'Ruby',
  next: 'TypeScript', nest: 'TypeScript', nuxt: 'TypeScript',
  angular: 'TypeScript', react: 'TypeScript',
  'react-native': 'TypeScript', expo: 'TypeScript',
  astro: 'TypeScript', solid: 'TypeScript', remix: 'TypeScript',
  vue: 'TypeScript', svelte: 'TypeScript', electron: 'TypeScript',
};

// Direct cwd → lang detection for the case where framework is unknown but
// the repo has language-specific markers. tsconfig.json wins over
// package.json so plain JS projects don't get misclassified as TS.
function detectLangFromCwd(cwd) {
  if (!cwd || typeof cwd !== 'string') return null;
  try {
    if (fs.existsSync(path.join(cwd, 'tsconfig.json'))) return 'TypeScript';
    if (fs.existsSync(path.join(cwd, 'package.json'))) return 'JavaScript';
    for (const m of FW_MARKERS) {
      if (m.file && fs.existsSync(path.join(cwd, m.file))) {
        return _FW_DEFAULT_LANG[m.framework] || null;
      }
    }
    const entries = fs.readdirSync(cwd);
    if (entries.some(n => /\.(cs|fs)proj$|\.sln$/i.test(n))) return 'C#';
  } catch { /* swallow — fail-open */ }
  return null;
}

function enrichSourceMeta(toolInput, opts, cwd) {
  const out = {};
  const filePath = extractFilePath(toolInput);
  if (filePath) {
    const lang = detectContext(filePath);
    const framework = detectFrameworkFromProject(filePath, opts);
    if (lang) out.lang = lang;
    if (framework) out.framework = framework;
    return out;
  }
  // CWD fallback: Bash/shell commands and UserPromptSubmit have no file_path.
  // Without scope hints the Qdrant pre-filter and post-filter are both
  // bypassed (experience-core.js#applyScopeFilter returns points unchanged
  // when filePath is null) — cross-language hints then bleed into the top-K.
  if (cwd && typeof cwd === 'string') {
    const framework = detectFrameworkFromProject(cwd, opts);
    const lang = detectLangFromCwd(cwd) || (framework ? _FW_DEFAULT_LANG[framework] : null) || null;
    if (lang) out.lang = lang;
    if (framework) out.framework = framework;
  }
  return out;
}

// Exposed for tests so config cache can be cleared between cases.
function _resetCachesForTesting() {
  FW_CACHE.clear();
  _configCache = null;
}

module.exports = { enrichSourceMeta, detectContext, detectFrameworkFromProject, _resetCachesForTesting };

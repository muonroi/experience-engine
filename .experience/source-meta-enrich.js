'use strict';
/**
 * source-meta-enrich.js — Caller-side language/framework detection for hooks.
 *
 * Self-contained, zero npm dependencies, safe to ship in thin-client installs.
 * Mirrors a subset of src/utils.js (detectContext, detectFrameworkFromProject,
 * extractProjectPath) so interceptors can enrich sourceMeta without pulling
 * in the full local brain code path.
 *
 * Keep this file pure: no Qdrant, no remote, no config. fs + path only.
 */

const fs = require('fs');
const path = require('path');

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

// muonroi-building-block consumer detection
const MUONROI_NPM_SCOPE = '@muonroi/';
const MUONROI_FRAMEWORK = 'muonroi-building-block';
const CSPROJ_READ_CAP = 64 * 1024; // 64KB cap on .csproj reads — large enough for any real project

function _csprojReferencesMuonroi(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const size = Math.min(stat.size, CSPROJ_READ_CAP);
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, 0);
      const text = buf.toString('utf8');
      // Match <PackageReference Include="Muonroi.*"> (any quote style, any whitespace).
      // Also catches <ProjectReference Include="...\Muonroi.*\..."/> as a fallback.
      return /Include\s*=\s*["'][^"']*Muonroi\./i.test(text);
    } finally { fs.closeSync(fd); }
  } catch { return false; }
}

function scanDirForFramework(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return null; }

  const fileNames = [];
  for (const e of entries) if (e.isFile()) fileNames.push(e.name);
  const fileNameSet = new Set(fileNames);

  // .NET: detect marker file, then refine by scanning for Muonroi.* PackageReference.
  const dotnetMarker = fileNames.find(n => {
    const lower = n.toLowerCase();
    return lower.endsWith('.csproj') || lower.endsWith('.fsproj') || lower.endsWith('.sln');
  });
  if (dotnetMarker) {
    // Scan up to 4 marker files in this dir (covers most multi-project dirs).
    const markers = fileNames
      .filter(n => /\.(cs|fs)proj$|\.sln$/i.test(n))
      .slice(0, 4);
    for (const m of markers) {
      if (_csprojReferencesMuonroi(`${dir}/${m}`)) return MUONROI_FRAMEWORK;
    }
    return 'dotnet';
  }

  for (const m of FW_MARKERS) {
    if (m.ext) continue; // .NET ext handled above
    if (m.file && fileNameSet.has(m.file)) return m.framework;
  }

  if (fileNameSet.has('package.json')) {
    try {
      const pkg = JSON.parse(fs.readFileSync(`${dir}/package.json`, 'utf8'));
      const deps = Object.assign({}, pkg.dependencies || {}, pkg.devDependencies || {});
      // Muonroi consumer detection takes precedence over generic next/nest/react.
      // A muonroi-cli that happens to use react still classifies as BB consumer.
      for (const depName of Object.keys(deps)) {
        if (depName.startsWith(MUONROI_NPM_SCOPE)) return MUONROI_FRAMEWORK;
      }
      for (const { dep, framework } of PKG_DEP_FW) {
        if (deps[dep]) return framework;
      }
      return null;
    } catch { return null; }
  }
  return null;
}

function detectFrameworkFromProject(filePath) {
  if (!filePath) return null;
  let dir = path.dirname(filePath.replace(/\\/g, '/'));
  for (let i = 0; i < 8; i++) {
    if (!dir || dir === '/' || dir === '.' || /^[A-Za-z]:\/?$/.test(dir)) break;
    if (FW_CACHE.has(dir)) return FW_CACHE.get(dir);
    const fw = scanDirForFramework(dir);
    if (fw) {
      if (FW_CACHE.size >= FW_CACHE_MAX) FW_CACHE.clear();
      FW_CACHE.set(dir, fw);
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

function enrichSourceMeta(toolInput) {
  const out = {};
  const filePath = extractFilePath(toolInput);
  if (!filePath) return out;
  const lang = detectContext(filePath);
  const framework = detectFrameworkFromProject(filePath);
  if (lang) out.lang = lang;
  if (framework) out.framework = framework;
  return out;
}

module.exports = { enrichSourceMeta, detectContext, detectFrameworkFromProject };

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

function scanDirForFramework(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return null; }

  const fileNames = new Set();
  for (const e of entries) if (e.isFile()) fileNames.add(e.name);

  for (const m of FW_MARKERS) {
    if (m.ext) {
      for (const n of fileNames) {
        if (n.toLowerCase().endsWith(m.ext)) return m.framework;
      }
    } else if (m.file && fileNames.has(m.file)) {
      return m.framework;
    }
  }

  if (fileNames.has('package.json')) {
    try {
      const pkg = JSON.parse(fs.readFileSync(`${dir}/package.json`, 'utf8'));
      const deps = Object.assign({}, pkg.dependencies || {}, pkg.devDependencies || {});
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

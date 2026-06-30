/**
 * sync-utils.js — Environment Handshake, IDE Buffer Sync, and Git-Diff State Preservation.
 * Phase 4 & Phase 5 Hybrid Split-Agent Upgrade.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const BUFFER_SYNC_FILE = path.join(os.homedir(), '.experience', 'tmp', 'ide-buffers.json');

// --- 1. Environment Handshake ---

function detectEnvironment() {
  const platform = process.platform;
  const isWindows = platform === 'win32';
  const wslDistro = process.env.WSL_DISTRO_NAME;
  
  let hostOS = isWindows ? 'Windows' : 'Unix';
  if (wslDistro) {
    hostOS = `WSL (${wslDistro})`;
  }
  
  // Detect shell type
  let shellType = 'Unix/Bash';
  if (isWindows) {
    if (process.env.PSModulePath || process.env.POWERSHELL_DISTRIBUTION_CHANNEL) {
      shellType = 'Windows/PowerShell';
    } else {
      shellType = 'Windows/CommandPrompt';
    }
  } else {
    const shellEnv = process.env.SHELL || '';
    if (shellEnv.includes('zsh')) {
      shellType = 'Unix/Zsh';
    } else if (shellEnv.includes('bash')) {
      shellType = 'Unix/Bash';
    } else {
      shellType = 'Unix/Bash';
    }
  }

  // Active paths
  const activePaths = [];
  if (process.env.PATH) {
    const paths = process.env.PATH.split(path.delimiter);
    if (paths.length > 0) {
      activePaths.push(paths[0]);
    }
  }
  try {
    activePaths.push(process.cwd());
  } catch {}

  return {
    hostOS,
    shellType,
    activePaths: [...new Set(activePaths)]
  };
}

function injectEnvironmentContext(systemPrompt) {
  if (typeof systemPrompt !== 'string') return systemPrompt;
  
  // Check if it already has environment specifications
  const hasEnvSpec = /client host OS|Windows\/PowerShell|Unix\/Bash|shell type/i.test(systemPrompt);
  if (hasEnvSpec) {
    return systemPrompt;
  }
  
  const env = detectEnvironment();
  const envString = `\n[Client Environment] OS: ${env.hostOS}, Shell: ${env.shellType}, Active Paths: ${env.activePaths.join(', ')}`;
  
  return systemPrompt + envString;
}

// --- 2. IDE Buffer Sync ---

function getIDEBuffers() {
  try {
    if (fs.existsSync(BUFFER_SYNC_FILE)) {
      return JSON.parse(fs.readFileSync(BUFFER_SYNC_FILE, 'utf8')) || {};
    }
  } catch (e) {}
  return {};
}

function saveIDEBuffers(buffers) {
  try {
    fs.mkdirSync(path.dirname(BUFFER_SYNC_FILE), { recursive: true });
    fs.writeFileSync(BUFFER_SYNC_FILE, JSON.stringify(buffers, null, 2), 'utf8');
    return true;
  } catch (e) {
    return false;
  }
}

function syncIDEBuffers(buffers) {
  if (!buffers || typeof buffers !== 'object') return false;
  const current = getIDEBuffers();
  for (const [file, content] of Object.entries(buffers)) {
    current[file] = {
      content: String(content),
      ts: new Date().toISOString()
    };
  }
  return saveIDEBuffers(current);
}

function readBufferOrDisk(filePath, encoding = 'utf8') {
  try {
    const buffers = getIDEBuffers();
    const resolvedPath = path.resolve(filePath);
    const normalizedPath = resolvedPath.replace(/\\/g, '/');
    
    for (const key of Object.keys(buffers)) {
      const normalizedKey = path.resolve(key).replace(/\\/g, '/');
      if (normalizedKey === normalizedPath) {
        const buffer = buffers[key];
        const ts = new Date(buffer.ts || 0).getTime();
        // Check if buffer is fresh (less than 15 minutes old)
        if (buffer && typeof buffer.content === 'string' && Date.now() - ts < 15 * 60 * 1000) {
          return buffer.content;
        }
      }
    }
  } catch (err) {
    // Fail-open to disk read
  }
  return fs.readFileSync(filePath, encoding);
}

// --- 3. Git-Diff State Preservation ---

function getDirtyGitDiff(cwd) {
  try {
    const projectDir = cwd || process.cwd();
    // Run git diff and git diff --cached
    const diff = execSync('git diff', { cwd: projectDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 });
    const cachedDiff = execSync('git diff --cached', { cwd: projectDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 });
    
    let combined = (diff || '').trim() + '\n' + (cachedDiff || '').trim();
    combined = combined.trim();
    
    if (!combined) return null;
    
    // Limit diff size to e.g. 10000 characters
    if (combined.length > 10000) {
      combined = combined.slice(0, 10000) + '\n\n[Diff truncated...]';
    }
    return combined;
  } catch (e) {
    return null;
  }
}

module.exports = {
  detectEnvironment,
  injectEnvironmentContext,
  getIDEBuffers,
  syncIDEBuffers,
  readBufferOrDisk,
  getDirtyGitDiff
};

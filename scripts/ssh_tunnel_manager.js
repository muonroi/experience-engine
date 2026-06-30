#!/usr/bin/env node
'use strict';

/**
 * ssh_tunnel_manager.js
 * 
 * Local connection helper to launch, verify, and maintain the SSH tunnel 
 * from the local machine to the remote Experience Engine VPS.
 * 
 * Functions like a native Node.js replacement for 'autossh'.
 * Works on Windows and Linux.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');

// --- Configuration ---
const CONFIG = {
  sshHost: process.env.EXP_SSH_HOST || '72.61.127.154',
  sshUser: process.env.EXP_SSH_USER || 'phila',
  sshKey: process.env.EXP_SSH_KEY || 'C:/Users/phila/.ssh/muonroi_vps_rsa',
  
  // Port Forwarding Settings
  ports: [
    { local: 11434, remote: 11434, label: 'Ollama API', testPath: '/api/tags' },
    { local: 6333, remote: 6333, label: 'Qdrant Database', testPath: '/' }
  ],
  
  // Health & Monitoring
  checkIntervalMs: parseInt(process.env.EXP_TUNNEL_CHECK_INTERVAL || '15000', 10),
  maxConsecutiveFailures: parseInt(process.env.EXP_TUNNEL_MAX_FAILURES || '3', 10),
  reconnectDelayMs: 5000,
};

let sshProcess = null;
let healthCheckTimer = null;
let consecutiveFailures = 0;
let isExiting = false;

// Format logger
function log(msg) {
  const ts = new Date().toISOString();
  console.log(`\x1b[36m[${ts}] [TunnelManager]\x1b[0m ${msg}`);
}

function logError(msg) {
  const ts = new Date().toISOString();
  console.error(`\x1b[31m[${ts}] [TunnelManager] [ERROR]\x1b[0m ${msg}`);
}

// 1. Verify SSH Key Existence
function verifySSHKey() {
  const resolvedKeyPath = path.resolve(CONFIG.sshKey);
  log(`Verifying SSH key: ${resolvedKeyPath}`);
  if (!fs.existsSync(resolvedKeyPath)) {
    logError(`SSH key not found at: ${resolvedKeyPath}`);
    logError(`Please ensure the key is placed in that directory, or override using EXP_SSH_KEY env variable.`);
    return false;
  }
  
  // Check permissions (read-only for owner is recommended)
  try {
    const stats = fs.statSync(resolvedKeyPath);
    if (process.platform !== 'win32') {
      const mode = stats.mode & 0o777;
      if (mode > 0o600) {
        log(`[Warning] SSH private key permissions are too open (${mode.toString(8)}). Recommended: 600`);
      }
    }
  } catch (err) {
    logError(`Error reading SSH key metadata: ${err.message}`);
  }
  return true;
}

// 2. Check if a local port is already in use
function checkPortInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolve(true);
      } else {
        resolve(false);
      }
    });
    server.once('listening', () => {
      server.close();
      resolve(false);
    });
    server.listen(port, '127.0.0.1');
  });
}

// 3. Perform HTTP health check to verified forwarded port
async function checkServiceHealth(port, testPath) {
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 3000); // 3-second timeout

    const res = await fetch(`http://127.0.0.1:${port}${testPath}`, {
      signal: controller.signal
    });
    clearTimeout(id);
    
    // We consider it healthy if we get any HTTP status (e.g. 200 or 404/405/etc).
    // The fact that a server responds on this local port shows the tunnel is active and connecting.
    return res.status >= 200 && res.status < 500;
  } catch (err) {
    return false;
  }
}

// 4. Start SSH Tunnel
async function startTunnel() {
  if (isExiting) return;
  
  log('Checking local port status before launching...');
  for (const config of CONFIG.ports) {
    const inUse = await checkPortInUse(config.local);
    if (inUse) {
      log(`Local port ${config.local} (${config.label}) is already in use.`);
      log(`Attempting to run health check on existing occupant...`);
      const healthy = await checkServiceHealth(config.local, config.testPath);
      if (healthy) {
        log(`Existing service on port ${config.local} is responding. An active tunnel may already be running.`);
      } else {
        log(`Existing service on port ${config.local} is not responding. Port is hung or occupied by another app.`);
      }
    }
  }

  // Construct SSH args
  const sshArgs = [
    '-i', CONFIG.sshKey,
    '-N', // Do not execute remote command, forward ports only
    '-o', 'ServerAliveInterval=60',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'StrictHostKeyChecking=accept-new'
  ];

  // Add Local Forwarding rules
  for (const config of CONFIG.ports) {
    sshArgs.push('-L', `${config.local}:127.0.0.1:${config.remote}`);
  }

  // Add Host target
  sshArgs.push(`${CONFIG.sshUser}@${CONFIG.sshHost}`);

  log(`Spawning SSH tunnel: ssh ${sshArgs.join(' ')}`);
  
  sshProcess = spawn('ssh', sshArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false
  });

  sshProcess.stdout.on('data', (data) => {
    log(`[ssh stdout] ${data.toString().trim()}`);
  });

  sshProcess.stderr.on('data', (data) => {
    const errText = data.toString().trim();
    // Exclude noise messages
    if (!errText.includes('Warning: Permanently added')) {
      log(`[ssh stderr] ${errText}`);
    }
  });

  sshProcess.on('close', (code) => {
    sshProcess = null;
    logError(`SSH tunnel process exited with code ${code}`);
    
    if (!isExiting) {
      log(`Reconnecting in ${CONFIG.reconnectDelayMs / 1000}s...`);
      setTimeout(startTunnel, CONFIG.reconnectDelayMs);
    }
  });

  sshProcess.on('error', (err) => {
    logError(`Failed to start SSH process: ${err.message}`);
    logError('Make sure OpenSSH client is installed and "ssh" is in your system PATH.');
  });

  // Reset failure count on new launch
  consecutiveFailures = 0;
  startHealthChecks();
}

// 5. Active Health Check Loop
function startHealthChecks() {
  if (healthCheckTimer) clearInterval(healthCheckTimer);

  healthCheckTimer = setInterval(async () => {
    if (isExiting || !sshProcess) return;

    let allHealthy = true;
    for (const config of CONFIG.ports) {
      const healthy = await checkServiceHealth(config.local, config.testPath);
      if (!healthy) {
        logError(`Health check failed for ${config.label} on local port ${config.local}`);
        allHealthy = false;
      }
    }

    if (allHealthy) {
      if (consecutiveFailures > 0) {
        log(`Tunnel has recovered health.`);
      }
      consecutiveFailures = 0;
    } else {
      consecutiveFailures++;
      log(`Consecutive health failures: ${consecutiveFailures}/${CONFIG.maxConsecutiveFailures}`);
      
      if (consecutiveFailures >= CONFIG.maxConsecutiveFailures) {
        logError(`Max failures reached. Force-restarting SSH tunnel...`);
        killTunnel();
      }
    }
  }, CONFIG.checkIntervalMs);
}

// Kill SSH process cleanly
function killTunnel() {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }
  if (sshProcess) {
    log('Terminating SSH process...');
    sshProcess.kill('SIGTERM');
    // Set a timeout to force kill if it doesn't close
    const procToKill = sshProcess;
    setTimeout(() => {
      try {
        procToKill.kill('SIGKILL');
      } catch (e) {}
    }, 2000);
    sshProcess = null;
  }
}

// Graceful Cleanup
function cleanupAndExit() {
  if (isExiting) return;
  isExiting = true;
  log('Shutting down SSH tunnel manager...');
  killTunnel();
  setTimeout(() => {
    process.exit(0);
  }, 500);
}

// Register signals
process.on('SIGINT', cleanupAndExit);
process.on('SIGTERM', cleanupAndExit);
process.on('exit', () => {
  if (sshProcess) {
    try {
      sshProcess.kill('SIGKILL');
    } catch(e) {}
  }
});

// Run Manager
async function run() {
  log('Starting local SSH Tunnel Manager...');
  if (!verifySSHKey()) {
    logError('SSH Key validation failed. Exiting.');
    process.exit(1);
  }
  
  await startTunnel();
}

run().catch((err) => {
  logError(`Unhandled error in tunnel manager: ${err.message}`);
  process.exit(1);
});

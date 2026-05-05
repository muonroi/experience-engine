#!/usr/bin/env node
/**
 * config-encrypt.js — Encrypt/decrypt sensitive fields in ~/.experience/config.json
 * Zero npm dependencies. Uses Node.js built-in crypto (AES-256-GCM).
 *
 * Usage:
 *   node scripts/config-encrypt.js encrypt          # Encrypts API keys in config
 *   node scripts/config-encrypt.js decrypt          # Decrypts for display (stdout only)
 *   node scripts/config-encrypt.js rotate           # Re-encrypt with new key
 *   node scripts/config-encrypt.js status           # Show which fields are encrypted
 *
 * Key storage: ~/.experience/.config-key (chmod 600, created on first encrypt)
 * Encrypted values are prefixed with "enc:" so the engine can detect them at runtime.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_PATH = path.join(os.homedir(), '.experience', 'config.json');
const KEY_PATH = path.join(os.homedir(), '.experience', '.config-key');
const ALGO = 'aes-256-gcm';
const ENC_PREFIX = 'enc:';

const SENSITIVE_FIELDS = [
  'qdrantKey',
  'embedKey',
  'brainKey',
  'serverAuthToken',
  'serverReadAuthToken',
  'server.authToken',
  'server.readAuthToken',
];

function getOrCreateKey() {
  if (fs.existsSync(KEY_PATH)) {
    return Buffer.from(fs.readFileSync(KEY_PATH, 'utf8').trim(), 'hex');
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(KEY_PATH, key.toString('hex'), { mode: 0o600 });
  console.log('Created encryption key:', KEY_PATH);
  return key;
}

function encrypt(text, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENC_PREFIX + Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decrypt(encValue, key) {
  if (!encValue.startsWith(ENC_PREFIX)) return encValue;
  const buf = Buffer.from(encValue.slice(ENC_PREFIX.length), 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

function getNestedValue(obj, dotPath) {
  return dotPath.split('.').reduce((o, k) => o?.[k], obj);
}

function setNestedValue(obj, dotPath, value) {
  const keys = dotPath.split('.');
  let target = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!target[keys[i]] || typeof target[keys[i]] !== 'object') target[keys[i]] = {};
    target = target[keys[i]];
  }
  target[keys[keys.length - 1]] = value;
}

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

const command = process.argv[2] || 'status';

if (command === 'status') {
  const config = loadConfig();
  console.log('Config:', CONFIG_PATH);
  console.log('Key:', fs.existsSync(KEY_PATH) ? KEY_PATH + ' (exists)' : 'not created yet');
  console.log('');
  for (const field of SENSITIVE_FIELDS) {
    const value = getNestedValue(config, field);
    if (!value) continue;
    const encrypted = String(value).startsWith(ENC_PREFIX);
    console.log(`  ${field}: ${encrypted ? 'ENCRYPTED' : 'PLAINTEXT ⚠️'}`);
  }
}

else if (command === 'encrypt') {
  const key = getOrCreateKey();
  const config = loadConfig();
  let count = 0;
  for (const field of SENSITIVE_FIELDS) {
    const value = getNestedValue(config, field);
    if (!value || String(value).startsWith(ENC_PREFIX)) continue;
    setNestedValue(config, field, encrypt(String(value), key));
    count++;
  }
  if (count > 0) {
    saveConfig(config);
    console.log(`Encrypted ${count} field(s) in ${CONFIG_PATH}`);
  } else {
    console.log('All sensitive fields already encrypted (or empty).');
  }
}

else if (command === 'decrypt') {
  if (!fs.existsSync(KEY_PATH)) { console.error('No encryption key found.'); process.exit(1); }
  const key = Buffer.from(fs.readFileSync(KEY_PATH, 'utf8').trim(), 'hex');
  const config = loadConfig();
  for (const field of SENSITIVE_FIELDS) {
    const value = getNestedValue(config, field);
    if (!value || !String(value).startsWith(ENC_PREFIX)) continue;
    try {
      const decrypted = decrypt(String(value), key);
      console.log(`${field}: ${decrypted.slice(0, 4)}${'*'.repeat(Math.max(0, decrypted.length - 4))}`);
    } catch (e) {
      console.log(`${field}: DECRYPT FAILED (${e.message})`);
    }
  }
}

else if (command === 'rotate') {
  if (!fs.existsSync(KEY_PATH)) { console.error('No existing key to rotate from.'); process.exit(1); }
  const oldKey = Buffer.from(fs.readFileSync(KEY_PATH, 'utf8').trim(), 'hex');
  const config = loadConfig();
  // Decrypt all with old key
  for (const field of SENSITIVE_FIELDS) {
    const value = getNestedValue(config, field);
    if (!value || !String(value).startsWith(ENC_PREFIX)) continue;
    setNestedValue(config, field, decrypt(String(value), oldKey));
  }
  // Generate new key
  fs.unlinkSync(KEY_PATH);
  const newKey = getOrCreateKey();
  // Re-encrypt with new key
  let count = 0;
  for (const field of SENSITIVE_FIELDS) {
    const value = getNestedValue(config, field);
    if (!value || String(value).startsWith(ENC_PREFIX)) continue;
    setNestedValue(config, field, encrypt(String(value), newKey));
    count++;
  }
  saveConfig(config);
  console.log(`Rotated key and re-encrypted ${count} field(s).`);
}

else {
  console.log('Usage: node scripts/config-encrypt.js [encrypt|decrypt|rotate|status]');
}

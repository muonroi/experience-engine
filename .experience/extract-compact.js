#!/usr/bin/env node
'use strict';

const MAX_TRANSCRIPT_CHARS = 12_000;
const MAX_LINE_CHARS = 280;
const MAX_DUPLICATE_LINES = 2;
const ERROR_PATTERN = /error|fail|exception|fatal|denied|timeout|unauthorized|not found|Bash exit [1-9]/i;

function trimLine(line) {
  return String(line || '').replace(/\s+/g, ' ').trim().slice(0, MAX_LINE_CHARS);
}

function isImportantLine(line) {
  return (
    /^User:/.test(line) ||
    /^Assistant:/.test(line) ||
    /^ToolCall /.test(line) ||
    ERROR_PATTERN.test(line)
  );
}

function dedupeLines(lines) {
  const counts = new Map();
  const deduped = [];
  let previous = null;

  for (const rawLine of lines) {
    const line = trimLine(rawLine);
    if (!line) continue;
    if (line === previous) continue;
    const seen = counts.get(line) || 0;
    if (seen >= MAX_DUPLICATE_LINES) continue;
    counts.set(line, seen + 1);
    deduped.push(line);
    previous = line;
  }
  return deduped;
}

function fitRecentLines(lines, maxChars = MAX_TRANSCRIPT_CHARS) {
  const picked = [];
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const delta = (picked.length > 0 ? 1 : 0) + line.length;
    if (total + delta > maxChars) break;
    picked.push(line);
    total += delta;
  }
  return picked.reverse();
}

function compactTranscript(transcript, maxChars = MAX_TRANSCRIPT_CHARS) {
  const lines = dedupeLines(String(transcript || '').split('\n'));
  const joined = lines.join('\n');
  if (joined.length <= maxChars) return joined;

  const important = lines.filter(isImportantLine);
  const unimportant = lines.filter((line) => !isImportantLine(line));

  const selected = fitRecentLines(important, maxChars);
  let selectedText = selected.join('\n');
  if (selectedText.length >= maxChars) return selectedText.slice(-maxChars);

  const remainingBudget = maxChars - selectedText.length - (selected.length > 0 ? 1 : 0);
  const filler = fitRecentLines(unimportant, remainingBudget);
  const merged = [];
  const keep = new Set([...selected, ...filler]);
  for (const line of lines) {
    if (keep.has(line)) merged.push(line);
  }
  const mergedText = merged.join('\n');
  if (mergedText.length <= maxChars) return mergedText;
  return mergedText.slice(-maxChars);
}

function compactExtractBody(body) {
  if (!body || typeof body !== 'object') return body;
  if (typeof body.transcript === 'string' && body.transcript) {
    return { ...body, transcript: compactTranscript(body.transcript) };
  }
  return body;
}

module.exports = {
  MAX_TRANSCRIPT_CHARS,
  compactTranscript,
  compactExtractBody,
};

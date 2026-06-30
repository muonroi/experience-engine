#!/usr/bin/env node
/**
 * register-hooks.js — idempotent agent hook registration
 *
 * Patches per-agent settings files to wire up Experience Engine interceptors.
 * Shared by `setup.sh` (initial install, full registration) and
 * `sync-install.sh` (upgrade, only re-patch agents already wired).
 *
 * Env vars (required):
 *   EXP_INTERCEPTOR         absolute path to interceptor.js
 *   EXP_INTERCEPTOR_POST    absolute path to interceptor-post.js
 *   EXP_INTERCEPTOR_PROMPT  absolute path to interceptor-prompt.js
 *   EXP_STOP                absolute path to stop-extractor.js
 *
 * Env vars (optional):
 *   EXP_INTERCEPTOR_SESSION absolute path to interceptor-session.js (SessionStart)
 *   EXP_INTERCEPTOR_BATCH   absolute path to posttool-batch-hook.js (PostToolBatch,
 *                           Claude Code only)
 *   EXP_SELECTED_AGENTS     csv subset: claude,gemini,codex,opencode,antigravity
 *                           empty → all agents
 *   EXP_REGISTER_MODE       'full' (default) — patch any agent in selected list
 *                           'existing-only' — only patch agents whose settings
 *                                             file already contains an
 *                                             interceptor hook (used by
 *                                             sync-install.sh during upgrade
 *                                             to avoid auto-wiring agents the
 *                                             user never opted in to).
 *
 * Exit code 0 always. Errors per-agent are logged but never abort the run.
 */

'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const home = os.homedir();
const interceptor = process.env.EXP_INTERCEPTOR;
const interceptorPost = process.env.EXP_INTERCEPTOR_POST;
const interceptorPrompt = process.env.EXP_INTERCEPTOR_PROMPT;
// SessionStart hook (Project Brief). Optional + backward-compatible: older
// setup scripts and existing-only upgrades may not pass it, so callers without
// it simply skip SessionStart wiring rather than failing.
const interceptorSession = process.env.EXP_INTERCEPTOR_SESSION;
// PostToolBatch hook (batch-level reflection hints). Optional + backward-
// compatible: callers that don't pass it simply skip PostToolBatch wiring.
const interceptorBatch = process.env.EXP_INTERCEPTOR_BATCH;
const stop = process.env.EXP_STOP;
const selected = (process.env.EXP_SELECTED_AGENTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const mode = (process.env.EXP_REGISTER_MODE || 'full').trim().toLowerCase();

if (!interceptor || !interceptorPost || !interceptorPrompt || !stop) {
  console.error('[register-hooks] Missing required env var. Need EXP_INTERCEPTOR, EXP_INTERCEPTOR_POST, EXP_INTERCEPTOR_PROMPT, EXP_STOP.');
  process.exit(0); // soft-fail — never break callers
}

function hasInterceptorHook(cfg) {
  if (!cfg || typeof cfg !== 'object' || !cfg.hooks) return false;
  for (const list of Object.values(cfg.hooks)) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const hooks = Array.isArray(entry?.hooks) ? entry.hooks : (Array.isArray(entry) ? entry : []);
      for (const h of hooks) {
        const cmd = String(h?.command || '');
        if (/interceptor|stop-extractor/.test(cmd)) return true;
      }
      // Some agents (OpenCode) flatten the entry; also scan top-level.
      const cmd = String(entry?.command || '');
      if (/interceptor|stop-extractor/.test(cmd)) return true;
    }
  }
  return false;
}

const AGENTS = [
  {
    key: 'claude',
    name: 'Claude Code',
    file: path.join(home, '.claude', 'settings.json'),
    patch(cfg) {
      if (!cfg.hooks) cfg.hooks = {};
      cfg.hooks.PreToolUse = cfg.hooks.PreToolUse || [];
      if (!cfg.hooks.PreToolUse.some(h => (h.hooks||[]).some(e => e.command?.includes('interceptor')))) {
        cfg.hooks.PreToolUse.unshift({ matcher: 'Edit|Write|Bash', hooks: [{ type:'command', command:`node "${interceptor}"`, timeout:5 }] });
      }
      cfg.hooks.PostToolUse = cfg.hooks.PostToolUse || [];
      if (!cfg.hooks.PostToolUse.some(h => (h.hooks||[]).some(e => e.command?.includes('interceptor-post')))) {
        cfg.hooks.PostToolUse.push({ matcher: 'Edit|Write|Bash', hooks: [{ type:'command', command:`node "${interceptorPost}"`, timeout:5 }] });
      }
      // UserPromptSubmit hook injects long-form guidance (multi-paragraph
      // recipe text) at message start. PreToolUse still emits per-tool
      // hints via additionalContext (supported since Claude CLI v2.1.9 —
      // anthropics/claude-code#15345 implemented). Both channels together
      // give the agent both prompt-start context and per-tool hints.
      cfg.hooks.UserPromptSubmit = cfg.hooks.UserPromptSubmit || [];
      if (!cfg.hooks.UserPromptSubmit.some(h => (h.hooks||[]).some(e => e.command?.includes('interceptor-prompt')))) {
        cfg.hooks.UserPromptSubmit.push({ hooks: [{ type:'command', command:`node "${interceptorPrompt}"`, timeout:5 }] });
      }
      // SessionStart hook injects the breadth-first Project Brief once per
      // session (the index of what the engine knows about this repo). Only
      // wired when the caller provided the script path — keeps older callers
      // and thin-clients working unchanged.
      if (interceptorSession) {
        cfg.hooks.SessionStart = cfg.hooks.SessionStart || [];
        if (!cfg.hooks.SessionStart.some(h => (h.hooks||[]).some(e => e.command?.includes('interceptor-session')))) {
          cfg.hooks.SessionStart.push({ hooks: [{ type:'command', command:`node "${interceptorSession}"`, timeout:5 }] });
        }
      }
      // PostToolBatch fires after a batch of parallel tool calls resolves —
      // aggregate-level reflection hints that only emerge across the whole
      // batch. Claude Code-specific event; only wired when the path is provided.
      if (interceptorBatch) {
        cfg.hooks.PostToolBatch = cfg.hooks.PostToolBatch || [];
        if (!cfg.hooks.PostToolBatch.some(h => (h.hooks||[]).some(e => e.command?.includes('posttool-batch-hook')))) {
          cfg.hooks.PostToolBatch.push({ hooks: [{ type:'command', command:`node "${interceptorBatch}"`, timeout:5 }] });
        }
      }
      cfg.hooks.Stop = cfg.hooks.Stop || [];
      if (!cfg.hooks.Stop.some(h => (h.hooks||[]).some(e => e.command?.includes('stop-extractor')))) {
        cfg.hooks.Stop.push({ hooks: [{ type:'command', command:`node "${stop}"`, timeout:90 }] });
      }
    }
  },
  {
    key: 'gemini',
    name: 'Gemini CLI',
    file: path.join(home, '.gemini', 'settings.json'),
    patch(cfg) {
      if (!cfg.hooks) cfg.hooks = {};
      cfg.hooks.BeforeTool = cfg.hooks.BeforeTool || [];
      if (!cfg.hooks.BeforeTool.some(h => (h.hooks||[]).some(e => e.command?.includes('interceptor')))) {
        cfg.hooks.BeforeTool.unshift({ matcher:'write_file|replace|replace_in_file|shell|execute_command', hooks:[{ name:'experience', type:'command', command:`node "${interceptor}"`, timeout:5000 }] });
      }
      // Gemini's SessionStart is documented as the channel for loading project
      // memories (injected as the first turn in history). Same hookSpecificOutput
      // .additionalContext shape the session hook already emits. Timeout in ms.
      if (interceptorSession) {
        cfg.hooks.SessionStart = cfg.hooks.SessionStart || [];
        if (!cfg.hooks.SessionStart.some(h => (h.hooks||[]).some(e => e.command?.includes('interceptor-session')))) {
          cfg.hooks.SessionStart.push({ hooks:[{ name:'experience-session', type:'command', command:`node "${interceptorSession}"`, timeout:5000 }] });
        }
      }
      cfg.hooks.AfterAgent = cfg.hooks.AfterAgent || [];
      if (!cfg.hooks.AfterAgent.some(h => (h.hooks||[]).some(e => e.command?.includes('stop-extractor')))) {
        cfg.hooks.AfterAgent.push({ hooks:[{ name:'experience-extractor', type:'command', command:`node "${stop}"`, timeout:90000 }] });
      }
      if (cfg.hooks.AfterResponse) {
        cfg.hooks.AfterResponse = cfg.hooks.AfterResponse.filter(h => !(h.hooks||[]).some(e => e.command?.includes('stop-extractor')));
        if (cfg.hooks.AfterResponse.length === 0) delete cfg.hooks.AfterResponse;
      }
    }
  },
  {
    key: 'codex',
    name: 'Codex CLI',
    file: path.join(home, '.codex', 'hooks.json'),
    patch(cfg) {
      if (!cfg.hooks) cfg.hooks = {};
      cfg.hooks.PreToolUse = cfg.hooks.PreToolUse || [];
      if (!cfg.hooks.PreToolUse.some(h => (h.hooks||[]).some(e => e.command?.includes('interceptor')))) {
        cfg.hooks.PreToolUse.push({ matcher:'Bash', hooks:[{ type:'command', command:`node "${interceptor}"`, timeout:5 }] });
      }
      for (const entry of cfg.hooks.PreToolUse) {
        if (entry.matcher === '.*' && (entry.hooks||[]).some(e => e.command?.includes('interceptor'))) {
          entry.matcher = 'Bash';
        }
      }
      cfg.hooks.PostToolUse = cfg.hooks.PostToolUse || [];
      if (!cfg.hooks.PostToolUse.some(h => (h.hooks||[]).some(e => e.command?.includes('interceptor-post')))) {
        cfg.hooks.PostToolUse.push({ matcher:'Bash', hooks:[{ type:'command', command:`node "${interceptorPost}"`, timeout:5 }] });
      }
      cfg.hooks.UserPromptSubmit = cfg.hooks.UserPromptSubmit || [];
      if (!cfg.hooks.UserPromptSubmit.some(h => (h.hooks||[]).some(e => e.command?.includes('interceptor-prompt')))) {
        cfg.hooks.UserPromptSubmit.push({ hooks:[{ type:'command', command:`node "${interceptorPrompt}"`, timeout:5 }] });
      }
      // Codex has a native SessionStart hook (thread-start scope) supporting the
      // same hookSpecificOutput.additionalContext injection as Claude. No matcher
      // → fires on all sources; the brief's TTL cache prevents per-source spam.
      if (interceptorSession) {
        cfg.hooks.SessionStart = cfg.hooks.SessionStart || [];
        if (!cfg.hooks.SessionStart.some(h => (h.hooks||[]).some(e => e.command?.includes('interceptor-session')))) {
          cfg.hooks.SessionStart.push({ hooks:[{ type:'command', command:`node "${interceptorSession}"`, timeout:5 }] });
        }
      }
      cfg.hooks.Stop = cfg.hooks.Stop || [];
      if (!cfg.hooks.Stop.some(h => (h.hooks||[]).some(e => e.command?.includes('stop-extractor')))) {
        cfg.hooks.Stop.push({ hooks:[{ type:'command', command:`node "${stop}"`, timeout:90 }] });
      }
      // Enable hooks feature in config.toml
      const tomlPath = path.join(home, '.codex', 'config.toml');
      try {
        let toml = '';
        try { toml = fs.readFileSync(tomlPath, 'utf8'); } catch {}
        if (!toml.includes('codex_hooks')) {
          toml += (toml && !toml.endsWith('\n') ? '\n' : '') + '[features]\ncodex_hooks = true\n';
          fs.writeFileSync(tomlPath, toml);
        }
      } catch {}
    }
  },
  {
    key: 'opencode',
    name: 'OpenCode',
    file: path.join(home, '.config', 'opencode', 'config.json'),
    patch(cfg) {
      if (!cfg.hooks) cfg.hooks = {};
      cfg.hooks.before_tool = cfg.hooks.before_tool || [];
      if (!cfg.hooks.before_tool.some(h => h.command?.includes('interceptor'))) {
        cfg.hooks.before_tool.push({ command:`node "${interceptor}"`, timeout:5 });
      }
      cfg.hooks.after_response = cfg.hooks.after_response || [];
      if (!cfg.hooks.after_response.some(h => h.command?.includes('stop-extractor'))) {
        cfg.hooks.after_response.push({ command:`node "${stop}"`, timeout:90 });
      }
    }
  },
  {
    key: 'antigravity',
    name: 'Google Antigravity CLI',
    file: path.join(home, '.antigravity', 'hooks.json'),
    patch(cfg) {
      if (!cfg.hooks) cfg.hooks = {};
      const drop = (arr, needle) => (arr || []).filter(h => !(h.hooks || []).some(e => e.command?.includes(needle)));
      cfg.hooks.PreToolUse = drop(cfg.hooks.PreToolUse, 'interceptor');
      cfg.hooks.PreToolUse.push({ matcher:'*', hooks:[{ type:'command', command:`node ${interceptor} --runtime=antigravity`, timeout:5 }] });

      cfg.hooks.PostToolUse = drop(cfg.hooks.PostToolUse, 'interceptor-post');
      cfg.hooks.PostToolUse.push({ matcher:'*', hooks:[{ type:'command', command:`node ${interceptorPost} --runtime=antigravity`, timeout:5 }] });

      cfg.hooks.UserPromptSubmit = drop(cfg.hooks.UserPromptSubmit, 'interceptor-prompt');
      cfg.hooks.UserPromptSubmit.push({ hooks:[{ type:'command', command:`node ${interceptorPrompt} --runtime=antigravity`, timeout:5 }] });

      if (interceptorSession) {
        cfg.hooks.SessionStart = drop(cfg.hooks.SessionStart, 'interceptor-session');
        cfg.hooks.SessionStart.push({ hooks:[{ type:'command', command:`node ${interceptorSession} --runtime=antigravity`, timeout:5 }] });
      }

      cfg.hooks.Stop = drop(cfg.hooks.Stop, 'stop-extractor');
      cfg.hooks.Stop.push({ hooks:[{ type:'command', command:`node ${stop} --runtime=antigravity`, timeout:90 }] });
    }
  },
  {
    key: 'antigravity-ide',
    name: 'Google Antigravity IDE',
    file: path.join(home, '.gemini', 'config', 'hooks.json'),
    patch(cfg) {
      if (!cfg.hooks) cfg.hooks = {};
      const drop = (arr, needle) => (arr || []).filter(h => !(h.hooks || []).some(e => e.command?.includes(needle)));
      cfg.hooks.PreToolUse = drop(cfg.hooks.PreToolUse, 'interceptor');
      cfg.hooks.PreToolUse.push({ matcher:'*', hooks:[{ type:'command', command:`node ${interceptor} --runtime=antigravity`, timeout:5 }] });

      cfg.hooks.PostToolUse = drop(cfg.hooks.PostToolUse, 'interceptor-post');
      cfg.hooks.PostToolUse.push({ matcher:'*', hooks:[{ type:'command', command:`node ${interceptorPost} --runtime=antigravity`, timeout:5 }] });

      cfg.hooks.UserPromptSubmit = drop(cfg.hooks.UserPromptSubmit, 'interceptor-prompt');
      cfg.hooks.UserPromptSubmit.push({ hooks:[{ type:'command', command:`node ${interceptorPrompt} --runtime=antigravity`, timeout:5 }] });

      if (interceptorSession) {
        cfg.hooks.SessionStart = drop(cfg.hooks.SessionStart, 'interceptor-session');
        cfg.hooks.SessionStart.push({ hooks:[{ type:'command', command:`node ${interceptorSession} --runtime=antigravity`, timeout:5 }] });
      }

      cfg.hooks.Stop = drop(cfg.hooks.Stop, 'stop-extractor');
      cfg.hooks.Stop.push({ hooks:[{ type:'command', command:`node ${stop} --runtime=antigravity`, timeout:90 }] });
    }
  },
  {
    key: 'muonroi-cli',
    name: 'Muonroi CLI',
    file: path.join(home, '.muonroi-cli', 'user-settings.json'),
    patch(cfg) {
      if (!cfg.hooks) cfg.hooks = {};
      const drop = (arr, needle) => (arr || []).filter(h => !(h.hooks || []).some(e => e.command?.includes(needle)));
      cfg.hooks.PreToolUse = drop(cfg.hooks.PreToolUse, 'interceptor');
      cfg.hooks.PreToolUse.push({ matcher:'*', hooks:[{ type:'command', command:`node ${interceptor} --runtime=muonroi-cli`, timeout:5 }] });

      cfg.hooks.PostToolUse = drop(cfg.hooks.PostToolUse, 'interceptor-post');
      cfg.hooks.PostToolUse.push({ matcher:'*', hooks:[{ type:'command', command:`node ${interceptorPost} --runtime=muonroi-cli`, timeout:5 }] });

      cfg.hooks.UserPromptSubmit = drop(cfg.hooks.UserPromptSubmit, 'interceptor-prompt');
      cfg.hooks.UserPromptSubmit.push({ hooks:[{ type:'command', command:`node ${interceptorPrompt} --runtime=muonroi-cli`, timeout:5 }] });

      if (interceptorSession) {
        cfg.hooks.SessionStart = drop(cfg.hooks.SessionStart, 'interceptor-session');
        cfg.hooks.SessionStart.push({ hooks:[{ type:'command', command:`node ${interceptorSession} --runtime=muonroi-cli`, timeout:5 }] });
      }

      cfg.hooks.Stop = drop(cfg.hooks.Stop, 'stop-extractor');
      cfg.hooks.Stop.push({ hooks:[{ type:'command', command:`node ${stop} --runtime=muonroi-cli`, timeout:90 }] });
    }
  }
];

for (const agent of AGENTS) {
  if (selected.length > 0 && !selected.includes(agent.key)) {
    continue;
  }
  try {
    let cfg = {};
    let exists = false;
    try {
      cfg = JSON.parse(fs.readFileSync(agent.file, 'utf8'));
      exists = true;
    } catch {}

    if (mode === 'existing-only') {
      // Upgrade mode: only re-patch if the agent's config file already exists
      // AND has an interceptor hook somewhere. This prevents auto-wiring
      // an agent the user has never opted in to during initial setup.
      if (!exists || !hasInterceptorHook(cfg)) {
        continue;
      }
    }

    agent.patch(cfg);
    fs.mkdirSync(path.dirname(agent.file), { recursive: true });
    fs.writeFileSync(agent.file, JSON.stringify(cfg, null, 2));
    console.log('  ' + agent.name);
  } catch (e) {
    console.log('  ' + agent.name + ': ' + e.message);
  }
}

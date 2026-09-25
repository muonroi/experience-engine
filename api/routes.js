'use strict';

// The route table is the single source of truth for what the server serves.
// docs/openapi.yaml is checked against it by tests/openapi-routes.test.js.
//
// access:
//   public — no rate limit, no auth (liveness / diagnostics)
//   read   — GET; full token or server.readAuthToken
//   write  — full token (server.authToken)
// With no token configured every route is open.

const { handleHealth, handleMetrics, handleVersion } = require('./handlers/health');
const {
  handleIntercept, handlePostToolBatch, handlePostTool, handlePromptStale,
  handleExtract, handleIngestPoint, handleEvolve,
} = require('./handlers/hooks');
const {
  handleStats, handleProjects, handleGates, handleGraph, handleProjectBrief,
  handleTimeline, handleUser, handleHintStats,
} = require('./handlers/observability');
const {
  handleShare, handleImport, handleFeedback, handleSearch, handleRecall, handleImportMemory,
} = require('./handlers/knowledge');
const { handlePilContext } = require('./handlers/pil');
const {
  handleRouteTask, handleRouteModel, handleRouteFeedback, handleSyncBuffers,
  handleBrainProxy, handlePhaseOutcome, handleWorkflowEvent,
} = require('./handlers/routing');

const ROUTES = [
  { method: 'GET', path: '/health', access: 'public', handler: handleHealth },
  { method: 'GET', path: '/metrics', access: 'public', handler: handleMetrics },
  { method: 'GET', path: '/api/version', access: 'public', handler: handleVersion },

  { method: 'GET', path: '/api/stats', access: 'read', handler: handleStats },
  { method: 'GET', path: '/api/projects', access: 'read', handler: handleProjects },
  { method: 'GET', path: '/api/gates', access: 'read', handler: handleGates },
  { method: 'GET', path: '/api/project-brief', access: 'read', handler: handleProjectBrief },
  { method: 'GET', path: '/api/graph', access: 'write', handler: handleGraph },
  { method: 'GET', path: '/api/timeline', access: 'write', handler: handleTimeline },
  { method: 'GET', path: '/api/user', access: 'write', handler: handleUser },
  { method: 'GET', path: '/api/hint-stats', access: 'write', handler: handleHintStats },

  { method: 'POST', path: '/api/intercept', access: 'write', handler: handleIntercept },
  { method: 'POST', path: '/api/posttool-batch', access: 'write', handler: handlePostToolBatch },
  { method: 'POST', path: '/api/posttool', access: 'write', handler: handlePostTool },
  { method: 'POST', path: '/api/prompt-stale', access: 'write', handler: handlePromptStale },
  { method: 'POST', path: '/api/extract', access: 'write', handler: handleExtract },
  { method: 'POST', path: '/api/ingest-point', access: 'write', handler: handleIngestPoint },
  { method: 'POST', path: '/api/evolve', access: 'write', handler: handleEvolve },
  { method: 'POST', path: '/api/principles/share', access: 'write', handler: handleShare },
  { method: 'POST', path: '/api/principles/import', access: 'write', handler: handleImport },
  { method: 'POST', path: '/api/feedback', access: 'write', handler: handleFeedback },
  { method: 'POST', path: '/api/route-task', access: 'write', handler: handleRouteTask },
  { method: 'POST', path: '/api/route-model', access: 'write', handler: handleRouteModel },
  { method: 'POST', path: '/api/route-feedback', access: 'write', handler: handleRouteFeedback },
  { method: 'POST', path: '/api/sync-buffers', access: 'write', handler: handleSyncBuffers },
  { method: 'POST', path: '/api/brain', access: 'write', handler: handleBrainProxy },
  { method: 'POST', path: '/api/search', access: 'write', handler: handleSearch },
  { method: 'POST', path: '/api/recall', access: 'write', handler: handleRecall },
  { method: 'POST', path: '/api/import-memory', access: 'write', handler: handleImportMemory },
  { method: 'POST', path: '/api/pil-context', access: 'write', handler: handlePilContext },
  { method: 'POST', path: '/api/phase-outcome', access: 'write', handler: handlePhaseOutcome },
  { method: 'POST', path: '/api/workflow-event', access: 'write', handler: handleWorkflowEvent },
  { method: 'POST', path: '/api/project-brief', access: 'write', handler: handleProjectBrief },
];

function findRoute(method, pathname) {
  return ROUTES.find(r => r.method === method && r.path === pathname) || null;
}

module.exports = { ROUTES, findRoute };

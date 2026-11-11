'use strict';
const path = require('node:path');

function normalizeClientPath(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || /[\u0000-\u001f]/.test(value)) return null;
  if (/^[a-z]:[\\/]/i.test(value) || /^[\\/]{2}[^\\/]/.test(value)) {
    return path.win32.normalize(value).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
  }
  if (value.startsWith('/') || value.startsWith('~/')) return path.posix.normalize(value).replace(/\/$/, '');
  return null;
}

/** An authenticated client assertion, equivalent in authority to explicit project_slug. */
function resolveRepositoryContext(repository, cwd, patterns = []) {
  if (!repository || typeof repository !== 'object' || Array.isArray(repository)) throw new Error('repository must contain root and project');
  const { root, project } = repository;
  if (typeof project !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(project) || ['any','all'].includes(project.toLowerCase())) throw new Error('repository.project must be a concrete project');
  const normalizedRoot = normalizeClientPath(root), normalizedCwd = normalizeClientPath(cwd);
  if (!normalizedRoot || !normalizedCwd || normalizedRoot === '~' || /^[a-z]:$/i.test(normalizedRoot) ||
      !(normalizedCwd === normalizedRoot || normalizedCwd.startsWith(normalizedRoot + '/'))) throw new Error('repository.root must be an absolute project path containing cwd');
  const basename = normalizedRoot.split('/').at(-1);
  // Match only the actual root/identity, never an unrelated registered ancestor.
  const alias = (Array.isArray(patterns) ? patterns : []).find(p => typeof p === 'string' &&
    (p.toLowerCase() === basename?.toLowerCase() || p.toLowerCase() === project.toLowerCase()));
  return { root, project: alias || project };
}
module.exports = { resolveRepositoryContext, normalizeClientPath };

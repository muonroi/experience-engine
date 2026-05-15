const fs = require('fs');
const core = fs.readFileSync('.experience/experience-core.js','utf8');
const config = fs.readFileSync('.experience/src/config.js','utf8');
const embedding = fs.readFileSync('.experience/src/embedding.js','utf8');
const qdrant = fs.readFileSync('.experience/src/qdrant.js','utf8');
const utils = fs.readFileSync('.experience/src/utils.js','utf8');

function extractFnNames(code, label) {
  const fns = code.match(/^async function (\w+)|^function (\w+)/gm);
  if (!fns) { console.log(label + ': 0 functions'); return []; }
  const names = fns.map(f => f.replace(/^async function /,'').replace(/^function /,''));
  console.log(label + ': ' + names.length + ' functions');
  return names;
}

const coreFns = extractFnNames(core, 'Core');
const configFns = extractFnNames(config, 'Config');
const embedFns = extractFnNames(embedding, 'Embedding');
const qdrantFns = extractFnNames(qdrant, 'Qdrant');
const utilsFns = extractFnNames(utils, 'Utils');

// Check which core functions are also defined in modules (duplicated)
const allModuleFns = [...configFns, ...embedFns, ...qdrantFns, ...utilsFns];
const dupes = coreFns.filter(fn => allModuleFns.includes(fn));
console.log('\n=== DUPLICATE functions (defined in both core AND module) ===');
dupes.forEach(f => console.log('  ' + f));
console.log('Total duplicates: ' + dupes.length);

// Check which module exports are NOT in core
const moduleExports = {
  config: fs.readFileSync('.experience/src/config.js','utf8').match(/module\.exports = \{([^}]+)\}/)?.[1],
  embedding: fs.readFileSync('.experience/src/embedding.js','utf8').match(/module\.exports = \{([^}]+)\}/)?.[1],
  qdrant: fs.readFileSync('.experience/src/qdrant.js','utf8').match(/module\.exports = \{([^}]+)\}/)?.[1],
  utils: fs.readFileSync('.experience/src/utils.js','utf8').match(/module\.exports = \{([^}]+)\}/)?.[1],
};

console.log('\n=== Module exports ===');
for (const [mod, exports] of Object.entries(moduleExports)) {
  if (exports) {
    const names = exports.split(',').map(s => s.trim().split(':')[0].trim()).filter(Boolean);
    console.log(mod + ' exports: ' + names.length + ' items');
  }
}

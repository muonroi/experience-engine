/**
 * ESLint flat config (ESLint v9+). `npm run lint` covers the whole repo.
 */
'use strict';

module.exports = [
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        // Node.js built-in globals
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        exports: 'writable',
        module: 'readonly',
        require: 'readonly',
        global: 'readonly',
        URL: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        clearImmediate: 'readonly',
        queueMicrotask: 'readonly',
        // ES2022 globals
        fetch: 'readonly',
        structuredClone: 'readonly',
        AbortSignal: 'readonly',
        AbortController: 'readonly',
        Event: 'readonly',
        EventTarget: 'readonly',
        // Test framework
        test: 'readonly',
        describe: 'readonly',
        it: 'readonly',
        before: 'readonly',
        after: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-var': 'error',
      'prefer-const': 'warn',
      'eqeqeq': ['error', 'smart'],
      'no-throw-literal': 'error',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      // A dropped error needs a reason: record it with .experience/src/swallow.js,
      // or leave a comment in the catch saying why it is expected.
      'no-empty': ['error', { allowEmptyCatch: false }],
    },
  },
  {
    files: ['**/*.mjs'],
    languageOptions: { sourceType: 'module' },
  },
  {
    // Test cleanup (rmSync of a temp dir, closing a server) may drop errors.
    files: ['tests/**'],
    rules: { 'no-empty': ['error', { allowEmptyCatch: true }] },
  },
  {
    ignores: ['node_modules/', 'coverage/'],
  },
];

'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveRepositoryContext } = require('../lib/repository-context');
test('repository context supports Windows, POSIX and client-home roots without a registration', () => {
  for (const [root,cwd] of [['D:\\new-repo','d:/new-repo/src'],['/work/new-repo','/work/new-repo/src'],['~/work/new-repo','~/work/new-repo/src']]) {
    assert.equal(resolveRepositoryContext({ root, project:'new-repo' },cwd).project,'new-repo');
  }
});
test('repository context preserves exact configured aliases, never a registered ancestor', () => {
  assert.equal(resolveRepositoryContext({root:'D:/REPO-A',project:'origin'},'D:/REPO-A/src',['repo-a']).project,'repo-a');
  assert.equal(resolveRepositoryContext({root:'D:/repo-a/new-repo',project:'new-repo'},'D:/repo-a/new-repo/src',['repo-a']).project,'new-repo');
});
test('repository context rejects malformed identities, relative roots and path escape', () => {
  for (const repository of [null,[],{}, {root:'D:/repo',project:'any'}, {root:'D:/repo',project:'all'}, {root:'D:/repo',project:'../other'}, {root:'repo',project:'repo'}, {root:'/',project:'repo'}]) {
    assert.throws(()=>resolveRepositoryContext(repository,'D:/repo/src'));
  }
  for (const cwd of ['D:/repo-other/src','E:/repo/src','D:/repo/../other','relative','D:/repo\u0000']) {
    assert.throws(()=>resolveRepositoryContext({root:'D:/repo',project:'repo'},cwd));
  }
});

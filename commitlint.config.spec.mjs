import test from 'node:test';
import assert from 'node:assert/strict';

import config from './commitlint.config.js';

test('commitlint config does not ignore "Initial plan"', () => {
  const ignoreRules = config.ignores ?? [];
  const isIgnored = ignoreRules.some((ignore) => ignore('Initial plan'));

  assert.equal(isIgnored, false);
});

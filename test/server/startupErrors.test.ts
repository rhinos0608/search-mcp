import assert from 'node:assert/strict';
import test from 'node:test';

import { isAddressInUseError } from '../../src/server/startupErrors.js';

test('isAddressInUseError accepts EADDRINUSE errors', () => {
  const err = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });

  assert.equal(isAddressInUseError(err), true);
});

test('isAddressInUseError rejects non-EADDRINUSE errors', () => {
  const err = Object.assign(new Error('permission denied'), { code: 'EACCES' });

  assert.equal(isAddressInUseError(err), false);
});

test('isAddressInUseError rejects non-errors', () => {
  assert.equal(isAddressInUseError({ code: 'EADDRINUSE' }), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpTransportManager } from '../../src/server/mcp-transport.js';
import { createMockRuntime } from '../helpers/mocks.js';

test('getOrCreate: creates new session when no sessionId given', async () => {
  const mgr = new HttpTransportManager(createMockRuntime());
  const result = await mgr.getOrCreate(undefined);
  assert.ok(result !== null);
  assert.equal(result!.isNew, true);
  assert.ok(result!.sessionId.length > 0);
  mgr.closeAll();
});

test('getOrCreate: returns null for unknown sessionId', async () => {
  const mgr = new HttpTransportManager(createMockRuntime());
  const result = await mgr.getOrCreate('nonexistent-session-id');
  assert.equal(result, null);
  mgr.closeAll();
});

test('getOrCreate: returns existing session for known sessionId', async () => {
  const mgr = new HttpTransportManager(createMockRuntime());
  const first = await mgr.getOrCreate(undefined);
  assert.ok(first !== null);
  const second = await mgr.getOrCreate(first!.sessionId);
  assert.equal(second!.isNew, false);
  assert.equal(second!.sessionId, first!.sessionId);
  mgr.closeAll();
});

test('close: removes session', async () => {
  const mgr = new HttpTransportManager(createMockRuntime());
  const s = await mgr.getOrCreate(undefined);
  assert.ok(s !== null);
  await mgr.close(s!.sessionId);
  const again = await mgr.getOrCreate(s!.sessionId);
  assert.equal(again, null);
  mgr.closeAll();
});

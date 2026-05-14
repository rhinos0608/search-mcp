import test from 'node:test';
import assert from 'node:assert/strict';
import { getTailscaleServeCommands, getTailscaleFunnelCommands } from '../../src/server/tailscale.js';

test('serve commands: modern syntax (>= 1.52)', () => {
  const cmds = getTailscaleServeCommands(8050, '1.52.0');
  assert.ok(cmds.some(c => c.includes('tailscale serve')));
  assert.ok(cmds.some(c => c.includes('8050')));
});

test('serve commands: legacy syntax (< 1.52)', () => {
  const cmds = getTailscaleServeCommands(8050, '1.48.0');
  assert.ok(cmds.some(c => c.includes('tailscale serve')));
});

test('serve commands: no version → modern syntax', () => {
  const cmds = getTailscaleServeCommands(8050, undefined);
  assert.ok(cmds.length > 0);
});

test('funnel commands include funnel subcommand', () => {
  const cmds = getTailscaleFunnelCommands(8050, '1.52.0');
  assert.ok(cmds.some(c => c.includes('funnel')));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { demo } from './demo.mjs';
for (const agent of ['claude', 'codex']) test(`${agent}: actual configured command, detached worker and local recall (offline)`, async () => {
  const result = await demo(agent);
  assert.equal(result.realNetworkCalls, 0);
  assert.equal(result.hookConfigRemoved, true);
  assert.equal(result.outboundStubRequests, 1);
});

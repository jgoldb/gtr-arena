/**
 * Quick integration test for the bridge protocol.
 * Sends init/step/reset/close commands and validates responses.
 */

import { spawn } from 'child_process';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bridgePath = path.join(__dirname, 'bridge.ts');

const child = spawn('npx', ['tsx', bridgePath], {
  stdio: ['pipe', 'pipe', 'inherit'],
  shell: true,
});

let buffer = '';
const responses: any[] = [];
let resolveNext: ((data: any) => void) | null = null;

child.stdout!.on('data', (chunk: Buffer) => {
  buffer += chunk.toString();
  let newlineIdx: number;
  while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newlineIdx);
    buffer = buffer.slice(newlineIdx + 1);
    const data = JSON.parse(line);
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r(data);
    } else {
      responses.push(data);
    }
  }
});

function sendCmd(cmd: Record<string, unknown>): Promise<any> {
  return new Promise((resolve) => {
    resolveNext = resolve;
    child.stdin!.write(JSON.stringify(cmd) + '\n');
  });
}

async function run() {
  console.log('=== Bridge Integration Test ===\n');

  // 1. Init
  console.log('1. Init (2 envs, janitor vs janitor)...');
  const initResp = await sendCmd({
    cmd: 'init',
    numEnvs: 2,
    characters: ['janitor', 'janitor'],
    mapId: 'cage',
  });
  console.log(`   obsSize=${initResp.obsSize}, numAbilities=${initResp.numAbilities}, numEnvs=${initResp.numEnvs}`);
  console.log(`   obs shape: [${initResp.obs.length}][${initResp.obs[0].length}][${initResp.obs[0][0].length}]`);
  assert(initResp.obsSize === 57, `Expected obsSize=57, got ${initResp.obsSize}`);
  assert(initResp.numAbilities === 11, `Expected numAbilities=11, got ${initResp.numAbilities}`);
  assert(initResp.numEnvs === 2, `Expected numEnvs=2, got ${initResp.numEnvs}`);
  assert(initResp.obs.length === 2, 'Expected 2 env observations');
  assert(initResp.obs[0].length === 2, 'Expected 2 agent observations per env');
  assert(initResp.obs[0][0].length === 57, 'Expected 57-float observation vector');
  console.log('   PASS\n');

  // 2. Step with random actions
  console.log('2. Step (random actions)...');
  const stepResp = await sendCmd({
    cmd: 'step',
    actions: [
      [[3, 1, 0], [0, 5, 0]],  // env 0: agent0 uses ability 2, moves N; agent1 stands still, moves S
      [[0, 0, 0], [0, 0, 0]],  // env 1: both do nothing
    ],
  });
  console.log(`   obs shape: [${stepResp.obs.length}][${stepResp.obs[0].length}][${stepResp.obs[0][0].length}]`);
  console.log(`   rewards: [${stepResp.rewards.map((r: number[]) => `[${r.map(v => v.toFixed(4))}]`).join(', ')}]`);
  console.log(`   dones: [${stepResp.dones}]`);
  assert(stepResp.obs.length === 2, 'Expected 2 env observations');
  assert(stepResp.rewards.length === 2, 'Expected 2 reward pairs');
  assert(stepResp.dones.length === 2, 'Expected 2 done flags');
  console.log('   PASS\n');

  // 3. Run many steps until at least one env finishes
  console.log('3. Running steps until episode ends...');
  let totalSteps = 0;
  let anyDone = false;
  while (!anyDone && totalSteps < 2000) {
    const actions = [
      [randomAction(), randomAction()],
      [randomAction(), randomAction()],
    ];
    const resp = await sendCmd({ cmd: 'step', actions });
    totalSteps++;
    if (resp.dones.some((d: boolean) => d)) {
      anyDone = true;
      const doneIdx = resp.dones.indexOf(true);
      console.log(`   Episode ended at step ${totalSteps} (env ${doneIdx})`);
      console.log(`   Info: ${JSON.stringify(resp.infos[doneIdx])}`);
      // After auto-reset, obs should be valid initial state
      const postResetObs = resp.obs[doneIdx][0];
      assert(postResetObs.length === 57, 'Post-reset obs should be 57 floats');
      // HP should be full (1.0) after reset
      assert(postResetObs[0] === 1, `Post-reset HP should be 1.0, got ${postResetObs[0]}`);
    }
  }
  assert(anyDone, 'Expected at least one episode to finish within 2000 steps');
  console.log('   PASS\n');

  // 4. Reset
  console.log('4. Reset...');
  const resetResp = await sendCmd({ cmd: 'reset' });
  assert(resetResp.obs.length === 2, 'Expected 2 env observations after reset');
  assert(resetResp.obs[0][0][0] === 1, 'HP should be 1.0 after reset');
  console.log('   PASS\n');

  // 5. Performance test
  console.log('5. Performance test (500 steps, 2 envs)...');
  const t0 = performance.now();
  for (let i = 0; i < 500; i++) {
    await sendCmd({
      cmd: 'step',
      actions: [[randomAction(), randomAction()], [randomAction(), randomAction()]],
    });
  }
  const elapsed = performance.now() - t0;
  const stepsPerSec = (500 * 2) / (elapsed / 1000);
  console.log(`   ${elapsed.toFixed(0)}ms for 500 steps × 2 envs = ${stepsPerSec.toFixed(0)} env-steps/sec`);
  console.log('   PASS\n');

  // 6. Close
  console.log('6. Close...');
  child.stdin!.write(JSON.stringify({ cmd: 'close' }) + '\n');
  await new Promise<void>((resolve) => child.on('exit', () => resolve()));
  console.log('   PASS\n');

  console.log('=== All tests passed ===');
}

function randomAction(): number[] {
  return [
    Math.floor(Math.random() * 12),  // ability 0-11
    Math.floor(Math.random() * 9),   // moveDir 0-8
    Math.random() < 0.05 ? 1 : 0,   // cancelCast
  ];
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`ASSERTION FAILED: ${message}`);
    child.kill();
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('Test failed:', err);
  child.kill();
  process.exit(1);
});

/**
 * Stdin/stdout JSON-lines bridge for Python RL training.
 *
 * Manages N parallel arenas. Python sends actions for both agents,
 * Node responds with observations, rewards, and done flags.
 * Done arenas auto-reset; their response contains the post-reset observation
 * and the terminal observation is stored in `infos`.
 *
 * Protocol (one JSON object per line, each direction):
 *
 *   → {"cmd":"init","numEnvs":16,"characters":["janitor","janitor"],"mapId":"cage"}
 *   ← {"obsSize":57,"numAbilities":11,"numEnvs":16,"obs":[[[57 floats],[57 floats]], ...]}
 *
 *   → {"cmd":"step","actions":[[[ability,dir,cancel],[ability,dir,cancel]], ...]}
 *   ← {"obs":[...],"rewards":[[r0,r1],...],"dones":[...],"infos":[...]}
 *
 *   → {"cmd":"reset"}
 *   ← {"obs":[...]}
 *
 *   → {"cmd":"close"}
 *   (process exits)
 *
 * Action encoding per agent:
 *   [0] ability:    0 = no ability, 1..N = ability slot index (0-based in arena)
 *   [1] moveDir:    0 = stand still, 1-8 = N/NE/E/SE/S/SW/W/NW
 *   [2] cancelCast: 0 = no, 1 = yes
 *
 * Ground-targeted abilities (e.g. Bottle Chuck) default their target
 * to the opponent's current position.
 */

import { HeadlessArena, type AgentAction, type EntityObservation } from './HeadlessArena.js';
import { getCharacterStats, type CharacterId } from '@gtr/shared';
import * as readline from 'readline';

// ── Move direction lookup ────────────────────────────────────────────────

const MOVE_ANGLES: (number | null)[] = [
  null,                //  0: stand still
  0,                   //  1: N  (+Z)
  Math.PI * 0.25,      //  2: NE
  Math.PI * 0.5,       //  3: E  (+X)
  Math.PI * 0.75,      //  4: SE
  Math.PI,             //  5: S  (-Z)
  -Math.PI * 0.75,     //  6: SW
  -Math.PI * 0.5,      //  7: W  (-X)
  -Math.PI * 0.25,     //  8: NW
];

// ── State ────────────────────────────────────────────────────────────────

let arenas: HeadlessArena[] = [];

// ── Helpers ──────────────────────────────────────────────────────────────

function send(data: unknown): void {
  process.stdout.write(JSON.stringify(data) + '\n');
}

function flattenObs(obs: [EntityObservation, EntityObservation]): [number[], number[]] {
  return [
    HeadlessArena.flattenObservation(obs[0]),
    HeadlessArena.flattenObservation(obs[1]),
  ];
}

function decodeAction(raw: number[], opponentPos: { x: number; z: number }): AgentAction {
  const abilityRaw = raw[0] ?? 0;
  const moveDirRaw = raw[1] ?? 0;
  const cancelCastRaw = raw[2] ?? 0;
  return {
    abilityIndex: abilityRaw > 0 ? abilityRaw - 1 : null,
    moveAngle: MOVE_ANGLES[moveDirRaw] ?? null,
    moveSpeed: moveDirRaw > 0 ? 1 : 0,
    cancelCast: cancelCastRaw === 1,
    groundX: opponentPos.x,
    groundZ: opponentPos.z,
  };
}

// ── Commands ─────────────────────────────────────────────────────────────

function handleInit(cmd: Record<string, unknown>): void {
  const numEnvs = (cmd.numEnvs as number) ?? 1;
  const characters = (cmd.characters as [string, string]) ?? ['janitor', 'janitor'];
  const mapId = (cmd.mapId as string) ?? 'cage';
  const tickRate = cmd.tickRate as number | undefined;
  const maxDuration = cmd.maxDuration as number | undefined;

  arenas = [];
  for (let i = 0; i < numEnvs; i++) {
    arenas.push(new HeadlessArena({
      characters: characters as [CharacterId, CharacterId],
      mapId,
      tickRate,
      maxDuration,
    }));
  }

  const allObs = arenas.map(a => flattenObs(a.reset()));
  const obsSize = allObs[0]?.[0]?.length ?? 0;
  const numAbilities = getCharacterStats(characters[0] as CharacterId).abilities.length;

  send({ obsSize, numAbilities, numEnvs, obs: allObs });
}

function handleReset(): void {
  send({ obs: arenas.map(a => flattenObs(a.reset())) });
}

function handleStep(cmd: Record<string, unknown>): void {
  const allActions = cmd.actions as number[][][]; // [numEnvs][2][3]

  const obs: [number[], number[]][] = [];
  const rewards: [number, number][] = [];
  const dones: boolean[] = [];
  const infos: Record<string, unknown>[] = [];

  for (let i = 0; i < arenas.length; i++) {
    const arena = arenas[i];
    const envActions = allActions[i];

    const a0 = decodeAction(envActions[0], arena.entities[1]);
    const a1 = decodeAction(envActions[1], arena.entities[0]);

    const result = arena.step([a0, a1]);
    dones.push(result.done);
    rewards.push([result.rewards[0], result.rewards[1]]);

    if (result.done) {
      const termObs = flattenObs(result.observations);
      const newObs = flattenObs(arena.reset());
      obs.push(newObs);
      infos.push({ terminal_obs: termObs, winner: result.winner, time: result.time });
    } else {
      obs.push(flattenObs(result.observations));
      infos.push({});
    }
  }

  send({ obs, rewards, dones, infos });
}

// ── Main loop ────────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  try {
    const cmd = JSON.parse(line) as Record<string, unknown>;
    switch (cmd.cmd) {
      case 'init':  handleInit(cmd);  break;
      case 'reset': handleReset();    break;
      case 'step':  handleStep(cmd);  break;
      case 'close': process.exit(0);
      default:      send({ error: `Unknown command: ${cmd.cmd}` });
    }
  } catch (err) {
    send({ error: String(err) });
  }
});

rl.on('close', () => process.exit(0));

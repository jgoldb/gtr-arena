/**
 * Test script — runs a simple 1v1 match between two agents
 * using random actions to validate the headless engine works end-to-end.
 */

import { HeadlessArena, type AgentAction } from './HeadlessArena.js';
import { getCharacterStats, type CharacterId } from '@gtr/shared';

function randomAction(characterId: CharacterId): AgentAction {
  const stats = getCharacterStats(characterId);
  const numAbilities = stats.abilities.length;

  // 30% chance to use an ability
  const abilityIndex = Math.random() < 0.3
    ? Math.floor(Math.random() * numAbilities)
    : null;

  // 60% chance to move
  const moveAngle = Math.random() < 0.6
    ? Math.random() * Math.PI * 2 - Math.PI
    : null;

  return {
    abilityIndex,
    moveAngle,
    moveSpeed: moveAngle !== null ? 1 : 0,
    cancelCast: Math.random() < 0.05,
    // Random ground target within reasonable range of origin
    groundX: (Math.random() - 0.5) * 30,
    groundZ: (Math.random() - 0.5) * 30,
  };
}

// ── Run matches ──────────────────────────────────────────────────────────

const MATCH_COUNT = 100;
const matchups: [CharacterId, CharacterId][] = [
  ['janitor', 'janitor'],
  ['janitor', 'crackhead'],
  ['dr-retardo', 'crackhead'],
  ['janitor', 'dr-retardo'],
  ['dr-retardo', 'dr-retardo'],
];
const characters = matchups[Math.floor(Math.random() * matchups.length)];
const results = { team1: 0, team2: 0, draw: 0 };
let totalSteps = 0;

const startTime = performance.now();

for (let i = 0; i < MATCH_COUNT; i++) {
  const arena = new HeadlessArena({ characters, mapId: 'cage' });
  arena.reset();

  let steps = 0;
  while (!arena.isDone) {
    const actions: [AgentAction, AgentAction] = [
      randomAction(characters[0]),
      randomAction(characters[1]),
    ];
    arena.step(actions);
    steps++;
  }

  totalSteps += steps;
  if (arena.matchWinner === 1) results.team1++;
  else if (arena.matchWinner === 2) results.team2++;
  else results.draw++;
}

const elapsed = performance.now() - startTime;

console.log(`\n=== Headless Arena Test ===`);
console.log(`Matchup: ${characters[0]} vs ${characters[1]}`);
console.log(`Map: cage (with collision + LoS)`);
console.log(`Matches: ${MATCH_COUNT}`);
console.log(`Results: Team1=${results.team1} Team2=${results.team2} Draw=${results.draw}`);
console.log(`Total steps: ${totalSteps} (avg ${(totalSteps / MATCH_COUNT).toFixed(0)} per match)`);
console.log(`Wall time: ${elapsed.toFixed(0)}ms (${(totalSteps / elapsed * 1000).toFixed(0)} steps/sec)`);
console.log(`Matches/sec: ${(MATCH_COUNT / elapsed * 1000).toFixed(1)}`);

// Quick observation shape check
const arena = new HeadlessArena({ characters, mapId: 'cage' });
const obs = arena.reset();
const flat = HeadlessArena.flattenObservation(obs[0]);
console.log(`\nObservation vector size: ${flat.length}`);
console.log(`Sample observation:`, flat.map(v => v.toFixed(3)).join(', '));

// ── Scripted opponent test ──────────────────────────────────────────────
console.log(`\n=== Scripted Opponent Test ===`);
const scriptedMatchups: [CharacterId, CharacterId][] = [
  ['janitor', 'janitor'],
  ['crackhead', 'crackhead'],
  ['dr-retardo', 'dr-retardo'],
];
const SCRIPTED_MATCHES = 50;
for (const matchup of scriptedMatchups) {
  const sr = { team1: 0, team2: 0, draw: 0 };
  let ssteps = 0;
  const st0 = performance.now();
  for (let i = 0; i < SCRIPTED_MATCHES; i++) {
    const sa = new HeadlessArena({ characters: matchup, mapId: 'cage', scriptedOpponent: true });
    sa.reset();
    let steps = 0;
    while (!sa.isDone) {
      sa.step([randomAction(matchup[0]), { abilityIndex: null, moveAngle: null, moveSpeed: 0 }]);
      steps++;
    }
    ssteps += steps;
    if (sa.matchWinner === 1) sr.team1++;
    else if (sa.matchWinner === 2) sr.team2++;
    else sr.draw++;
  }
  const se = performance.now() - st0;
  console.log(
    `${matchup[0]} (random) vs ${matchup[1]} (scripted Master): ` +
    `Agent=${sr.team1} NPC=${sr.team2} Draw=${sr.draw} ` +
    `(${(ssteps / SCRIPTED_MATCHES).toFixed(0)} avg steps, ${se.toFixed(0)}ms)`
  );
}

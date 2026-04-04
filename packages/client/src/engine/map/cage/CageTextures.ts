import * as THREE from 'three';

type TexturePair = { map: THREE.CanvasTexture; bumpMap: THREE.CanvasTexture };

/** Procedural wood-plank + steel-band texture for pillars. */
export function createPillarTextures(): TexturePair {
  const W = 512;
  const H = 512;
  const PLANKS = 12;           // number of vertical planks around the barrel
  const BANDS = 3;             // number of steel bands
  const BAND_H = 18;           // band height in pixels
  const GAP = 2;               // dark gap between planks
  const RIVET_R = 4;           // rivet dot radius

  // --- Color map ---
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;

  // Base wood fill
  ctx.fillStyle = '#6b4226';
  ctx.fillRect(0, 0, W, H);

  const plankW = W / PLANKS;

  // Draw each plank with slight color variation and grain
  for (let i = 0; i < PLANKS; i++) {
    const x = i * plankW;

    // Per-plank hue/lightness shift
    const lShift = (Math.sin(i * 3.7) * 12) | 0;
    const r = 107 + lShift;
    const g = 66 + ((lShift * 0.6) | 0);
    const b = 38 + ((lShift * 0.3) | 0);
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(x + GAP, 0, plankW - GAP * 2, H);

    // Wood grain lines
    ctx.strokeStyle = `rgba(40, 22, 10, 0.25)`;
    ctx.lineWidth = 1;
    const grainCount = 6 + ((Math.sin(i * 5.1) * 3) | 0);
    for (let g = 0; g < grainCount; g++) {
      const gx = x + GAP + 2 + (plankW - GAP * 2 - 4) * (g / grainCount);
      ctx.beginPath();
      // Wavy grain line
      for (let y = 0; y < H; y += 4) {
        const wx = gx + Math.sin(y * 0.02 + i * 2 + g) * 1.5;
        y === 0 ? ctx.moveTo(wx, y) : ctx.lineTo(wx, y);
      }
      ctx.stroke();
    }

    // Knots (occasional)
    if (i % 4 === 1) {
      const knotX = x + plankW / 2;
      const knotY = H * (0.3 + Math.sin(i * 2.3) * 0.2);
      const grad = ctx.createRadialGradient(knotX, knotY, 0, knotX, knotY, 8);
      grad.addColorStop(0, 'rgba(30, 15, 5, 0.7)');
      grad.addColorStop(0.6, 'rgba(60, 30, 15, 0.4)');
      grad.addColorStop(1, 'rgba(60, 30, 15, 0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.ellipse(knotX, knotY, 8, 6, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // Dark gap between planks
    ctx.fillStyle = 'rgba(10, 5, 2, 0.9)';
    ctx.fillRect(x, 0, GAP, H);
    ctx.fillRect(x + plankW - GAP, 0, GAP, H);
  }

  // Steel bands
  const bandPositions: number[] = [];
  for (let b = 0; b < BANDS; b++) {
    const by = ((b + 1) / (BANDS + 1)) * H;
    bandPositions.push(by);

    // Band body
    const bandGrad = ctx.createLinearGradient(0, by - BAND_H / 2, 0, by + BAND_H / 2);
    bandGrad.addColorStop(0, '#7a7a82');
    bandGrad.addColorStop(0.3, '#a0a0a8');
    bandGrad.addColorStop(0.5, '#bbbbc4');
    bandGrad.addColorStop(0.7, '#a0a0a8');
    bandGrad.addColorStop(1, '#606068');
    ctx.fillStyle = bandGrad;
    ctx.fillRect(0, by - BAND_H / 2, W, BAND_H);

    // Band edge highlights
    ctx.fillStyle = 'rgba(200, 200, 210, 0.4)';
    ctx.fillRect(0, by - BAND_H / 2, W, 1);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.fillRect(0, by + BAND_H / 2 - 1, W, 1);

    // Rivets on each plank
    for (let i = 0; i < PLANKS; i++) {
      const rx = i * plankW + plankW / 2;
      const rivetGrad = ctx.createRadialGradient(rx - 1, by - 1, 0, rx, by, RIVET_R);
      rivetGrad.addColorStop(0, '#d0d0d8');
      rivetGrad.addColorStop(0.5, '#909098');
      rivetGrad.addColorStop(1, '#505058');
      ctx.fillStyle = rivetGrad;
      ctx.beginPath();
      ctx.arc(rx, by, RIVET_R, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const map = new THREE.CanvasTexture(canvas);
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.RepeatWrapping;

  // --- Bump map (grayscale heightfield) ---
  const bCanvas = document.createElement('canvas');
  bCanvas.width = W;
  bCanvas.height = H;
  const bCtx = bCanvas.getContext('2d')!;

  // Base plank height (lighter = raised)
  bCtx.fillStyle = '#808080';
  bCtx.fillRect(0, 0, W, H);

  // Plank surfaces slightly raised, gaps recessed
  for (let i = 0; i < PLANKS; i++) {
    const x = i * plankW;
    // Plank body — slightly raised
    bCtx.fillStyle = '#999999';
    bCtx.fillRect(x + GAP, 0, plankW - GAP * 2, H);
    // Gaps — recessed
    bCtx.fillStyle = '#333333';
    bCtx.fillRect(x, 0, GAP, H);
    bCtx.fillRect(x + plankW - GAP, 0, GAP, H);

    // Subtle grain bumps
    bCtx.strokeStyle = 'rgba(60, 60, 60, 0.15)';
    bCtx.lineWidth = 1;
    for (let g = 0; g < 4; g++) {
      const gx = x + GAP + 3 + (plankW - GAP * 2 - 6) * (g / 4);
      bCtx.beginPath();
      for (let y = 0; y < H; y += 4) {
        const wx = gx + Math.sin(y * 0.02 + i * 2 + g) * 1.5;
        y === 0 ? bCtx.moveTo(wx, y) : bCtx.lineTo(wx, y);
      }
      bCtx.stroke();
    }
  }

  // Steel bands — raised above planks
  for (const by of bandPositions) {
    bCtx.fillStyle = '#cccccc';
    bCtx.fillRect(0, by - BAND_H / 2, W, BAND_H);
    // Rivets — even more raised
    for (let i = 0; i < PLANKS; i++) {
      const rx = i * plankW + plankW / 2;
      bCtx.fillStyle = '#eeeeee';
      bCtx.beginPath();
      bCtx.arc(rx, by, RIVET_R, 0, Math.PI * 2);
      bCtx.fill();
    }
  }

  const bumpMap = new THREE.CanvasTexture(bCanvas);
  bumpMap.wrapS = THREE.RepeatWrapping;
  bumpMap.wrapT = THREE.RepeatWrapping;

  return { map, bumpMap };
}

/** Procedural dirty, aged arena floor texture. */
export function createFloorTexture(): TexturePair {
  const W = 1024, H = 1024;
  let seed = 77;
  const rng = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d')!;

  // Base aged concrete — mottled, uneven
  ctx.fillStyle = '#a89880';
  ctx.fillRect(0, 0, W, H);

  // Large-scale patchy color variation (organic, no grid)
  for (let i = 0; i < 50; i++) {
    const cx = rng() * W, cy = rng() * H;
    const r = 80 + rng() * 200;
    const shift = -15 + rng() * 30;
    const grad = ctx.createRadialGradient(cx, cy, r * 0.1, cx, cy, r);
    grad.addColorStop(0, `rgba(${(168 + shift) | 0},${(152 + shift * 0.8) | 0},${(128 + shift * 0.6) | 0},0.35)`);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  }

  // Fine aggregate speckle
  for (let i = 0; i < 24000; i++) {
    const bright = rng() > 0.5;
    ctx.fillStyle = bright
      ? `rgba(195,185,165,${(0.03 + rng() * 0.06).toFixed(2)})`
      : `rgba(75,65,50,${(0.03 + rng() * 0.06).toFixed(2)})`;
    ctx.fillRect(rng() * W, rng() * H, 1 + ((rng() * 3) | 0), 1 + ((rng() * 3) | 0));
  }

  // Dirt accumulation patches
  for (let i = 0; i < 60; i++) {
    const cx = rng() * W, cy = rng() * H;
    const rx = 30 + rng() * 100, ry = 25 + rng() * 80;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(rx, ry));
    grad.addColorStop(0, `rgba(45,38,28,${(0.08 + rng() * 0.15).toFixed(2)})`);
    grad.addColorStop(0.6, `rgba(55,45,32,${(0.04 + rng() * 0.08).toFixed(2)})`);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, rng() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }

  // Grime streaks
  ctx.lineWidth = 3;
  for (let i = 0; i < 45; i++) {
    ctx.strokeStyle = `rgba(55,45,30,${(0.06 + rng() * 0.1).toFixed(2)})`;
    const sx = rng() * W, sy = rng() * H;
    ctx.beginPath(); ctx.moveTo(sx, sy);
    for (let j = 0; j < 5; j++) ctx.lineTo(sx + (rng() - 0.5) * 120, sy + (rng() - 0.5) * 120);
    ctx.stroke();
  }

  // Scuff marks (combat wear)
  ctx.lineWidth = 1;
  for (let i = 0; i < 90; i++) {
    ctx.strokeStyle = `rgba(70,58,40,${(0.08 + rng() * 0.14).toFixed(2)})`;
    const sx = rng() * W, sy = rng() * H;
    ctx.beginPath(); ctx.moveTo(sx, sy);
    for (let j = 0; j < 3; j++) ctx.lineTo(sx + (rng() - 0.5) * 70, sy + (rng() - 0.5) * 70);
    ctx.stroke();
  }

  // Stains (blood, oil, water marks)
  for (let i = 0; i < 55; i++) {
    const cx = rng() * W, cy = rng() * H, r = 15 + rng() * 55;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    const t = rng();
    if (t < 0.3) {
      grad.addColorStop(0, `rgba(40,32,22,${(0.1 + rng() * 0.12).toFixed(2)})`);
    } else if (t < 0.55) {
      grad.addColorStop(0, `rgba(90,25,15,${(0.06 + rng() * 0.1).toFixed(2)})`);
    } else if (t < 0.75) {
      grad.addColorStop(0, `rgba(130,120,100,${(0.04 + rng() * 0.06).toFixed(2)})`);
    } else {
      grad.addColorStop(0, `rgba(65,55,42,${(0.08 + rng() * 0.1).toFixed(2)})`);
    }
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  }

  // Cracks
  ctx.lineWidth = 1;
  for (let i = 0; i < 20; i++) {
    ctx.strokeStyle = `rgba(35,28,18,${(0.2 + rng() * 0.2).toFixed(2)})`;
    let cx = rng() * W, cy = rng() * H;
    ctx.beginPath(); ctx.moveTo(cx, cy);
    for (let j = 0; j < 3 + ((rng() * 5) | 0); j++) {
      cx += (rng() - 0.5) * 90; cy += (rng() - 0.5) * 90;
      ctx.lineTo(cx, cy);
    }
    ctx.stroke();
  }

  const map = new THREE.CanvasTexture(canvas);
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.RepeatWrapping;

  // --- Bump map (uneven worn surface, no grid) ---
  const bc = document.createElement('canvas');
  bc.width = W; bc.height = H;
  const bx = bc.getContext('2d')!;
  bx.fillStyle = '#808080';
  bx.fillRect(0, 0, W, H);

  // Gentle height variation patches
  for (let i = 0; i < 60; i++) {
    const cx = rng() * W, cy = rng() * H, r = 50 + rng() * 120;
    const v = (120 + rng() * 20) | 0;
    bx.fillStyle = `rgb(${v},${v},${v})`;
    bx.beginPath(); bx.arc(cx, cy, r, 0, Math.PI * 2); bx.fill();
  }
  // Surface noise
  for (let i = 0; i < 16000; i++) {
    const v = (115 + rng() * 30) | 0;
    bx.fillStyle = `rgb(${v},${v},${v})`;
    bx.fillRect(rng() * W, rng() * H, 1 + ((rng() * 3) | 0), 1 + ((rng() * 3) | 0));
  }
  // Crack depressions
  bx.strokeStyle = '#555555';
  bx.lineWidth = 2;
  for (let i = 0; i < 18; i++) {
    let cx = rng() * W, cy = rng() * H;
    bx.beginPath(); bx.moveTo(cx, cy);
    for (let j = 0; j < 3 + ((rng() * 4) | 0); j++) {
      cx += (rng() - 0.5) * 80; cy += (rng() - 0.5) * 80;
      bx.lineTo(cx, cy);
    }
    bx.stroke();
  }

  const bumpMap = new THREE.CanvasTexture(bc);
  bumpMap.wrapS = THREE.RepeatWrapping;
  bumpMap.wrapT = THREE.RepeatWrapping;

  return { map, bumpMap };
}

/** Brushed/worn metal texture for cage bars. */
export function createCageBarTexture(): TexturePair {
  const W = 128, H = 256;
  let seed = 33;
  const rng = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d')!;

  // Base metal
  ctx.fillStyle = '#8a8a94';
  ctx.fillRect(0, 0, W, H);

  // Vertical brushed streaks
  for (let i = 0; i < 60; i++) {
    const x = rng() * W;
    const w = 1 + rng() * 2;
    const bright = rng() > 0.5;
    ctx.fillStyle = bright
      ? `rgba(160,160,170,${(0.05 + rng() * 0.15).toFixed(2)})`
      : `rgba(60,60,68,${(0.05 + rng() * 0.15).toFixed(2)})`;
    ctx.fillRect(x, 0, w, H);
  }

  // Rust spots
  for (let i = 0; i < 8; i++) {
    const cx = rng() * W, cy = rng() * H, r = 3 + rng() * 8;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    grad.addColorStop(0, `rgba(120,65,30,${(0.15 + rng() * 0.2).toFixed(2)})`);
    grad.addColorStop(0.6, `rgba(100,55,25,${(0.05 + rng() * 0.1).toFixed(2)})`);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  }

  // Pitting/wear dots
  for (let i = 0; i < 40; i++) {
    ctx.fillStyle = `rgba(50,50,55,${(0.1 + rng() * 0.15).toFixed(2)})`;
    ctx.beginPath();
    ctx.arc(rng() * W, rng() * H, 0.5 + rng() * 1.5, 0, Math.PI * 2);
    ctx.fill();
  }

  const map = new THREE.CanvasTexture(canvas);
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.RepeatWrapping;

  // Bump map
  const bc = document.createElement('canvas');
  bc.width = W; bc.height = H;
  const bx = bc.getContext('2d')!;
  bx.fillStyle = '#808080';
  bx.fillRect(0, 0, W, H);

  // Vertical streaks
  for (let i = 0; i < 40; i++) {
    const v = (120 + rng() * 20) | 0;
    bx.fillStyle = `rgb(${v},${v},${v})`;
    bx.fillRect(rng() * W, 0, 1 + ((rng() * 2) | 0), H);
  }
  // Pitting
  for (let i = 0; i < 30; i++) {
    bx.fillStyle = '#606060';
    bx.beginPath();
    bx.arc(rng() * W, rng() * H, 0.5 + rng() * 1.5, 0, Math.PI * 2);
    bx.fill();
  }

  const bumpMap = new THREE.CanvasTexture(bc);
  bumpMap.wrapS = THREE.RepeatWrapping;
  bumpMap.wrapT = THREE.RepeatWrapping;

  return { map, bumpMap };
}

/** Wood-plank + steel-band texture for gates/doors (matches pillar style). */
export function createGateTexture(): TexturePair {
  const W = 512, H = 512;
  const PLANKS = 8;
  const BANDS = 3;
  const BAND_H = 22;
  const GAP = 3;
  const RIVET_R = 5;

  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d')!;

  // Base wood fill (slightly darker than pillars — aged door)
  ctx.fillStyle = '#5a3820';
  ctx.fillRect(0, 0, W, H);

  const plankW = W / PLANKS;

  // Draw each plank with color variation and grain
  for (let i = 0; i < PLANKS; i++) {
    const x = i * plankW;

    // Per-plank hue/lightness shift
    const lShift = (Math.sin(i * 4.3) * 14) | 0;
    const r = 90 + lShift;
    const g = 56 + ((lShift * 0.6) | 0);
    const b = 32 + ((lShift * 0.3) | 0);
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(x + GAP, 0, plankW - GAP * 2, H);

    // Wood grain lines
    ctx.strokeStyle = 'rgba(30, 16, 6, 0.25)';
    ctx.lineWidth = 1;
    const grainCount = 5 + ((Math.sin(i * 5.7) * 3) | 0);
    for (let g2 = 0; g2 < grainCount; g2++) {
      const gx = x + GAP + 2 + (plankW - GAP * 2 - 4) * (g2 / grainCount);
      ctx.beginPath();
      for (let y = 0; y < H; y += 4) {
        const wx = gx + Math.sin(y * 0.018 + i * 2.5 + g2) * 2;
        y === 0 ? ctx.moveTo(wx, y) : ctx.lineTo(wx, y);
      }
      ctx.stroke();
    }

    // Knots
    if (i % 3 === 1) {
      const knotX = x + plankW / 2;
      const knotY = H * (0.25 + Math.sin(i * 2.9) * 0.2);
      const grad = ctx.createRadialGradient(knotX, knotY, 0, knotX, knotY, 10);
      grad.addColorStop(0, 'rgba(25, 12, 4, 0.7)');
      grad.addColorStop(0.6, 'rgba(50, 25, 12, 0.4)');
      grad.addColorStop(1, 'rgba(50, 25, 12, 0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.ellipse(knotX, knotY, 10, 7, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // Dark gap between planks
    ctx.fillStyle = 'rgba(8, 4, 1, 0.9)';
    ctx.fillRect(x, 0, GAP, H);
    ctx.fillRect(x + plankW - GAP, 0, GAP, H);
  }

  // Steel bands
  const bandPositions: number[] = [];
  for (let b = 0; b < BANDS; b++) {
    const by = ((b + 1) / (BANDS + 1)) * H;
    bandPositions.push(by);

    // Band body gradient
    const bandGrad = ctx.createLinearGradient(0, by - BAND_H / 2, 0, by + BAND_H / 2);
    bandGrad.addColorStop(0, '#6a6a72');
    bandGrad.addColorStop(0.3, '#909098');
    bandGrad.addColorStop(0.5, '#aaaaB4');
    bandGrad.addColorStop(0.7, '#909098');
    bandGrad.addColorStop(1, '#505058');
    ctx.fillStyle = bandGrad;
    ctx.fillRect(0, by - BAND_H / 2, W, BAND_H);

    // Band edge highlights
    ctx.fillStyle = 'rgba(190, 190, 200, 0.4)';
    ctx.fillRect(0, by - BAND_H / 2, W, 1);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.fillRect(0, by + BAND_H / 2 - 1, W, 1);

    // Rivets on each plank
    for (let i = 0; i < PLANKS; i++) {
      const rx = i * plankW + plankW / 2;
      const rivetGrad = ctx.createRadialGradient(rx - 1, by - 1, 0, rx, by, RIVET_R);
      rivetGrad.addColorStop(0, '#d0d0d8');
      rivetGrad.addColorStop(0.5, '#909098');
      rivetGrad.addColorStop(1, '#505058');
      ctx.fillStyle = rivetGrad;
      ctx.beginPath();
      ctx.arc(rx, by, RIVET_R, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const map = new THREE.CanvasTexture(canvas);

  // --- Bump map ---
  const bCanvas = document.createElement('canvas');
  bCanvas.width = W; bCanvas.height = H;
  const bCtx = bCanvas.getContext('2d')!;

  bCtx.fillStyle = '#808080';
  bCtx.fillRect(0, 0, W, H);

  // Plank surfaces raised, gaps recessed
  for (let i = 0; i < PLANKS; i++) {
    const x = i * plankW;
    bCtx.fillStyle = '#999999';
    bCtx.fillRect(x + GAP, 0, plankW - GAP * 2, H);
    bCtx.fillStyle = '#333333';
    bCtx.fillRect(x, 0, GAP, H);
    bCtx.fillRect(x + plankW - GAP, 0, GAP, H);

    // Subtle grain bumps
    bCtx.strokeStyle = 'rgba(60, 60, 60, 0.15)';
    bCtx.lineWidth = 1;
    for (let g = 0; g < 4; g++) {
      const gx = x + GAP + 3 + (plankW - GAP * 2 - 6) * (g / 4);
      bCtx.beginPath();
      for (let y = 0; y < H; y += 4) {
        const wx = gx + Math.sin(y * 0.018 + i * 2.5 + g) * 2;
        y === 0 ? bCtx.moveTo(wx, y) : bCtx.lineTo(wx, y);
      }
      bCtx.stroke();
    }
  }

  // Steel bands raised
  for (const by of bandPositions) {
    bCtx.fillStyle = '#cccccc';
    bCtx.fillRect(0, by - BAND_H / 2, W, BAND_H);
    // Rivets even more raised
    for (let i = 0; i < PLANKS; i++) {
      const rx = i * plankW + plankW / 2;
      bCtx.fillStyle = '#eeeeee';
      bCtx.beginPath();
      bCtx.arc(rx, by, RIVET_R, 0, Math.PI * 2);
      bCtx.fill();
    }
  }

  const bumpMap = new THREE.CanvasTexture(bCanvas);

  return { map, bumpMap };
}

/** Machined steel texture for pillar base rings. */
export function createPillarRingTexture(): TexturePair {
  const W = 256, H = 64;
  let seed = 99;
  const rng = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d')!;

  // Base polished steel
  ctx.fillStyle = '#909098';
  ctx.fillRect(0, 0, W, H);

  // Concentric machining marks (horizontal = circumferential on the ring)
  for (let y = 0; y < H; y++) {
    const a = 0.04 + rng() * 0.08;
    ctx.fillStyle = rng() > 0.5
      ? `rgba(170,170,175,${a.toFixed(3)})`
      : `rgba(100,100,105,${a.toFixed(3)})`;
    ctx.fillRect(0, y, W, 1);
  }

  // Edge bevels
  const bevelH = 8;
  const topGrad = ctx.createLinearGradient(0, 0, 0, bevelH);
  topGrad.addColorStop(0, 'rgba(200,200,210,0.35)');
  topGrad.addColorStop(1, 'rgba(200,200,210,0)');
  ctx.fillStyle = topGrad;
  ctx.fillRect(0, 0, W, bevelH);

  const botGrad = ctx.createLinearGradient(0, H - bevelH, 0, H);
  botGrad.addColorStop(0, 'rgba(30,30,35,0)');
  botGrad.addColorStop(1, 'rgba(30,30,35,0.35)');
  ctx.fillStyle = botGrad;
  ctx.fillRect(0, H - bevelH, W, bevelH);

  // Oil/grease stains
  for (let i = 0; i < 6; i++) {
    const cx = rng() * W, cy = rng() * H, r = 5 + rng() * 12;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    grad.addColorStop(0, `rgba(50,45,30,${(0.08 + rng() * 0.12).toFixed(2)})`);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  }

  // Scuff marks
  for (let i = 0; i < 12; i++) {
    ctx.strokeStyle = rng() > 0.5
      ? `rgba(150,150,155,${(0.06 + rng() * 0.1).toFixed(2)})`
      : `rgba(60,60,65,${(0.06 + rng() * 0.1).toFixed(2)})`;
    ctx.lineWidth = 1;
    const sx = rng() * W, sy = rng() * H;
    ctx.beginPath(); ctx.moveTo(sx, sy);
    ctx.lineTo(sx + (rng() - 0.5) * 30, sy + (rng() - 0.5) * 8);
    ctx.stroke();
  }

  const map = new THREE.CanvasTexture(canvas);
  map.wrapS = THREE.RepeatWrapping;

  // Bump map
  const bc = document.createElement('canvas');
  bc.width = W; bc.height = H;
  const bx = bc.getContext('2d')!;
  bx.fillStyle = '#808080';
  bx.fillRect(0, 0, W, H);

  // Machining marks
  for (let y = 0; y < H; y++) {
    const v = (125 + rng() * 10) | 0;
    bx.fillStyle = `rgb(${v},${v},${v})`;
    bx.fillRect(0, y, W, 1);
  }
  // Beveled edges
  bx.fillStyle = '#999999';
  bx.fillRect(0, 0, W, 4);
  bx.fillStyle = '#666666';
  bx.fillRect(0, H - 4, W, 4);

  const bumpMap = new THREE.CanvasTexture(bc);
  bumpMap.wrapS = THREE.RepeatWrapping;

  return { map, bumpMap };
}

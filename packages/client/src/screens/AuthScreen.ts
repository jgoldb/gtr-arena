import { audioSettings } from '../ui/AudioSettings';

export interface AuthResult {
  username: string;
  password: string;
  mode: 'login' | 'register';
}

export class AuthScreen {
  readonly element: HTMLDivElement;
  onMenu?: () => void;
  private onAuth: (result: AuthResult) => void;
  private errorEl: HTMLDivElement;
  private confirmPasswordInput: HTMLInputElement;
  private submitBtn!: HTMLButtonElement;
  private mode: 'login' | 'register' = 'login';
  private animationFrameId: number = 0;
  private loading = false;
  private audioCtx: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private sourceNode: AudioBufferSourceNode | null = null;
  private fadingOut = false;
  private readonly onVisibilityChange = () => this.handleVisibilityChange();
  private readonly onUserGesture = () => this.resumeAudioCtx();
  private readonly onAudioSettingsChange = (s: { masterVolume: number; enableMusic: boolean; musicVolume: number }) => this.handleAudioSettingsChange(s);

  constructor(onAuth: (result: AuthResult) => void) {
    this.onAuth = onAuth;
    this.element = document.createElement('div');
    this.element.style.cssText = `
      position: fixed; inset: 0; z-index: 1000;
      display: flex; align-items: center; justify-content: center; flex-direction: column;
      background: #000;
      overflow: hidden;
    `;

    // ── Inject keyframe animations ──────────────────────────────────
    const styleEl = document.createElement('style');
    styleEl.textContent = `
      @keyframes gtr-banner-glow {
        0%, 100% { text-shadow: 0 0 20px rgba(255,200,50,0.8), 0 0 40px rgba(255,150,0,0.5), 0 0 80px rgba(255,100,0,0.3); }
        50% { text-shadow: 0 0 30px rgba(255,220,80,1), 0 0 60px rgba(255,170,30,0.7), 0 0 120px rgba(255,120,20,0.5), 0 0 160px rgba(200,50,0,0.2); }
      }
      @keyframes gtr-banner-gradient {
        0% { background-position: 0% 50%; }
        50% { background-position: 100% 50%; }
        100% { background-position: 0% 50%; }
      }
      @keyframes gtr-line-sweep {
        0% { transform: translateX(-100%); }
        100% { transform: translateX(100vw); }
      }
      @keyframes gtr-pulse-ring {
        0% { transform: scale(0.8); opacity: 0.6; }
        50% { transform: scale(1.05); opacity: 1; }
        100% { transform: scale(0.8); opacity: 0.6; }
      }
      @keyframes gtr-spark {
        0% { opacity: 1; transform: translateY(0) scale(1); }
        100% { opacity: 0; transform: translateY(-60px) scale(0); }
      }
    `;
    this.element.appendChild(styleEl);

    // ── Animated canvas background (stars + energy streaks) ──────────
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position: absolute; inset: 0; width: 100%; height: 100%;';
    this.element.appendChild(canvas);

    const ctx = canvas.getContext('2d')!;
    const particles: { x: number; y: number; vx: number; vy: number; size: number; color: string; life: number; maxLife: number }[] = [];
    const streaks: { x: number; y: number; vx: number; len: number; color: string; alpha: number }[] = [];

    // Sun position constants (used by cached gradients and animation)
    const sunX = 85, sunY = 85, sunRadius = 30;

    // Cached gradients — static ones created once, size-dependent rebuilt on resize
    let cachedBaseGradient: CanvasGradient;
    let cachedSunIllumGradient: CanvasGradient;
    const cachedSunBodyGradient = ctx.createRadialGradient(sunX - 4, sunY - 4, 0, sunX, sunY, sunRadius);
    cachedSunBodyGradient.addColorStop(0, '#fffff8');
    cachedSunBodyGradient.addColorStop(0.15, '#fff8e0');
    cachedSunBodyGradient.addColorStop(0.5, '#ffdd66');
    cachedSunBodyGradient.addColorStop(0.8, '#ffaa33');
    cachedSunBodyGradient.addColorStop(1, '#ff6600');

    const rebuildCachedGradients = () => {
      cachedBaseGradient = ctx.createRadialGradient(canvas.width / 2, canvas.height / 2, 0, canvas.width / 2, canvas.height / 2, canvas.width * 0.6);
      cachedBaseGradient.addColorStop(0, 'rgba(15, 10, 30, 0.05)');
      cachedBaseGradient.addColorStop(1, 'rgba(0, 0, 0, 0.1)');

      cachedSunIllumGradient = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, Math.max(canvas.width, canvas.height) * 0.7);
      cachedSunIllumGradient.addColorStop(0, 'rgba(255, 200, 100, 0.07)');
      cachedSunIllumGradient.addColorStop(0.15, 'rgba(255, 170, 60, 0.035)');
      cachedSunIllumGradient.addColorStop(0.5, 'rgba(255, 130, 40, 0.01)');
      cachedSunIllumGradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
    };

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      rebuildCachedGradients();
    };
    resize();
    window.addEventListener('resize', resize);

    // Seed initial stars
    for (let i = 0; i < 120; i++) {
      particles.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        vx: (Math.random() - 0.5) * 0.3,
        vy: (Math.random() - 0.5) * 0.3,
        size: Math.random() * 2 + 0.5,
        color: ['#6688cc', '#8899dd', '#aabbff', '#ffcc44', '#ff8833'][Math.floor(Math.random() * 5)],
        life: Math.random() * 300,
        maxLife: 200 + Math.random() * 300,
      });
    }

    // Seed streaks
    for (let i = 0; i < 6; i++) {
      streaks.push({
        x: -200 - Math.random() * 400,
        y: Math.random() * canvas.height,
        vx: 2 + Math.random() * 4,
        len: 80 + Math.random() * 200,
        color: Math.random() > 0.5 ? '#ff8833' : '#6688cc',
        alpha: 0.15 + Math.random() * 0.25,
      });
    }

    // Asteroids — large detailed rocks drifting through (pre-rendered to offscreen canvases)
    type AsteroidRock = {
      x: number; y: number; vx: number; vy: number;
      rotation: number; rotSpeed: number; size: number;
      shape: number[];
      craters: { cx: number; cy: number; r: number }[];
      ridges: { dist: number; start: number; len: number }[];
      rgb: [number, number, number];
      preRendered: HTMLCanvasElement;
    };
    const asteroidList: AsteroidRock[] = [];

    const preRenderAsteroid = (size: number, shape: number[], craters: AsteroidRock['craters'], ridges: AsteroidRock['ridges'], rgb: [number, number, number]): HTMLCanvasElement => {
      const pad = 4;
      const dim = Math.ceil(size * 2 + pad * 2);
      const c = document.createElement('canvas');
      c.width = dim;
      c.height = dim;
      const octx = c.getContext('2d')!;
      const cx = dim / 2, cy = dim / 2;
      const [r, g, b] = rgb;

      // Body shape
      octx.beginPath();
      for (let j = 0; j < shape.length; j += 2) {
        const px = cx + Math.cos(shape[j]) * shape[j + 1];
        const py = cy + Math.sin(shape[j]) * shape[j + 1];
        j === 0 ? octx.moveTo(px, py) : octx.lineTo(px, py);
      }
      octx.closePath();
      octx.fillStyle = `rgb(${r},${g},${b})`;
      octx.fill();

      // 3D lighting gradient
      const lg = octx.createRadialGradient(cx - size * 0.3, cy - size * 0.3, 0, cx, cy, size);
      lg.addColorStop(0, `rgba(${r + 55},${g + 50},${b + 45},0.4)`);
      lg.addColorStop(0.5, 'rgba(0,0,0,0)');
      lg.addColorStop(1, 'rgba(0,0,0,0.4)');
      octx.fillStyle = lg;
      octx.fill();

      // Edge outline
      octx.strokeStyle = `rgba(${r + 35},${g + 30},${b + 25},0.5)`;
      octx.lineWidth = 1.5;
      octx.stroke();

      // Craters
      for (const cr of craters) {
        octx.globalAlpha = 1;
        octx.beginPath();
        octx.arc(cx + cr.cx, cy + cr.cy, cr.r, 0, Math.PI * 2);
        octx.fillStyle = `rgb(${r - 25},${g - 25},${b - 20})`;
        octx.fill();
        octx.beginPath();
        octx.arc(cx + cr.cx - cr.r * 0.25, cy + cr.cy - cr.r * 0.25, cr.r * 0.75, 0, Math.PI * 2);
        octx.strokeStyle = `rgba(${r + 25},${g + 20},${b + 15},0.3)`;
        octx.lineWidth = 0.8;
        octx.stroke();
      }

      // Surface ridges
      octx.globalAlpha = 0.25;
      octx.strokeStyle = `rgb(${r - 15},${g - 15},${b - 10})`;
      octx.lineWidth = 0.7;
      for (const rd of ridges) {
        octx.beginPath();
        octx.arc(cx, cy, rd.dist, rd.start, rd.start + rd.len);
        octx.stroke();
      }

      return c;
    };

    const makeAsteroid = (): AsteroidRock => {
      const size = 80 + Math.random() * 120;
      const nv = 10 + Math.floor(Math.random() * 6);
      const shape: number[] = [];
      for (let i = 0; i < nv; i++) {
        shape.push((i / nv) * Math.PI * 2, size * (0.65 + Math.random() * 0.35));
      }
      const craters: AsteroidRock['craters'] = [];
      for (let i = 0, n = 2 + Math.floor(Math.random() * 4); i < n; i++) {
        const a = Math.random() * Math.PI * 2, d = Math.random() * size * 0.45;
        craters.push({ cx: Math.cos(a) * d, cy: Math.sin(a) * d, r: 5 + Math.random() * size * 0.12 });
      }
      const ridges: AsteroidRock['ridges'] = [];
      for (let i = 0, n = 2 + Math.floor(Math.random() * 3); i < n; i++) {
        ridges.push({ dist: Math.random() * size * 0.55, start: Math.random() * Math.PI * 2, len: 0.4 + Math.random() * 0.8 });
      }
      const speed = 0.5 + Math.random() * 1.0;
      const edge = Math.floor(Math.random() * 4);
      let x: number, y: number, vx: number, vy: number;
      if (edge === 0) { x = -size * 1.5; y = Math.random() * canvas.height; vx = speed; vy = (Math.random() - 0.5) * speed * 0.4; }
      else if (edge === 1) { x = canvas.width + size * 1.5; y = Math.random() * canvas.height; vx = -speed; vy = (Math.random() - 0.5) * speed * 0.4; }
      else if (edge === 2) { x = Math.random() * canvas.width; y = -size * 1.5; vx = (Math.random() - 0.5) * speed * 0.4; vy = speed; }
      else { x = Math.random() * canvas.width; y = canvas.height + size * 1.5; vx = (Math.random() - 0.5) * speed * 0.4; vy = -speed; }
      const palettes: [number, number, number][] = [[95, 85, 70], [75, 68, 58], [105, 92, 75], [85, 78, 65], [65, 58, 50]];
      const rgb = palettes[Math.floor(Math.random() * palettes.length)];
      const preRendered = preRenderAsteroid(size, shape, craters, ridges, rgb);
      return { x, y, vx, vy, rotation: Math.random() * Math.PI * 2, rotSpeed: (Math.random() - 0.5) * 0.004, size, shape, craters, ridges, rgb, preRendered };
    };

    // ── Sun (top-left corner) — solar flare definitions ──────────
    type SolarFlare = { angle: number; length: number; width: number; speed: number; phase: number };
    const solarFlares: SolarFlare[] = [];
    for (let i = 0; i < 8; i++) {
      solarFlares.push({
        angle: (i / 8) * Math.PI * 2 + (Math.random() - 0.5) * 0.4,
        length: 12 + Math.random() * 22,
        width: 0.1 + Math.random() * 0.18,
        speed: 0.0008 + Math.random() * 0.0012,
        phase: Math.random() * Math.PI * 2,
      });
    }

    // Lens flare element definitions (constant — hoisted out of render loop)
    const lensEls: { t: number; size: number; r: number; g: number; b: number; a: number }[] = [
      { t: 0.25, size: 12, r: 255, g: 200, b: 120, a: 0.12 },
      { t: 0.4, size: 8, r: 200, g: 220, b: 255, a: 0.15 },
      { t: 0.55, size: 30, r: 120, g: 160, b: 255, a: 0.06 },
      { t: 0.7, size: 10, r: 255, g: 230, b: 160, a: 0.14 },
      { t: 0.9, size: 45, r: 100, g: 140, b: 255, a: 0.04 },
      { t: 1.1, size: 18, r: 255, g: 180, b: 100, a: 0.1 },
      { t: 1.35, size: 55, r: 80, g: 120, b: 255, a: 0.03 },
      { t: 1.55, size: 22, r: 200, g: 180, b: 255, a: 0.07 },
    ];

    // ── Exotic planet (bottom-right) — looming with rings & storms ──
    const PLANET_R = 260;
    const STRIP_W = PLANET_R * 5; // full surface "circumference"
    const STRIP_H = PLANET_R * 2 + 20;
    const stripCY = STRIP_H / 2;

    // Volcano and storm positions in strip coordinates (for animated effects)
    const volcanoStripPos = [
      { x: 170, y: stripCY + 55, r: 20 },
      { x: 450, y: stripCY - 35, r: 16 },
      { x: 650, y: stripCY - 85, r: 14 },
      { x: 850, y: stripCY + 70, r: 22 },
      { x: 1100, y: stripCY + 25, r: 18 },
      { x: 280, y: stripCY - 55, r: 15 },
    ];
    const stormStripPos = { x: 500, y: stripCY - 25, rx: 100, ry: 65 };

    // Pre-rendered surface strip (no lighting — lighting applied per-frame)
    const planetStrip = (() => {
      const off = document.createElement('canvas');
      off.width = STRIP_W; off.height = STRIP_H;
      const p = off.getContext('2d')!;

      // Dark rocky base
      p.fillStyle = '#1a1a2e';
      p.fillRect(0, 0, STRIP_W, STRIP_H);

      // Water bodies — spread across the strip
      for (const w of [
        { x: 80, y: stripCY - 65, rx: 100, ry: 70, rot: 0.3 },
        { x: 350, y: stripCY + 50, rx: 80, ry: 50, rot: -0.2 },
        { x: 550, y: stripCY + 100, rx: 60, ry: 45, rot: 0.5 },
        { x: 750, y: stripCY - 100, rx: 55, ry: 35, rot: -0.4 },
        { x: 950, y: stripCY + 20, rx: 75, ry: 55, rot: 0.15 },
        { x: 1180, y: stripCY - 50, rx: 65, ry: 45, rot: -0.3 },
      ]) {
        for (const ox of [-STRIP_W, 0, STRIP_W]) {
          const wx = w.x + ox;
          if (wx + w.rx < 0 || wx - w.rx > STRIP_W) continue;
          p.save();
          p.translate(wx, w.y);
          p.rotate(w.rot);
          p.beginPath();
          p.ellipse(0, 0, w.rx, w.ry, 0, 0, Math.PI * 2);
          const g = p.createRadialGradient(0, 0, 0, 0, 0, w.rx);
          g.addColorStop(0, '#1a7aaa');
          g.addColorStop(0.5, '#0e5570');
          g.addColorStop(1, '#0a3850');
          p.fillStyle = g;
          p.fill();
          p.restore();
        }
      }

      // Forest continents
      for (const f of [
        { x: 30, y: stripCY + 25, rx: 60, ry: 90, rot: 0.1 },
        { x: 200, y: stripCY - 15, rx: 85, ry: 45, rot: -0.25 },
        { x: 420, y: stripCY - 40, rx: 50, ry: 75, rot: 0.4 },
        { x: 580, y: stripCY + 80, rx: 70, ry: 35, rot: 0.2 },
        { x: 700, y: stripCY - 20, rx: 55, ry: 60, rot: -0.15 },
        { x: 880, y: stripCY + 60, rx: 40, ry: 30, rot: -0.1 },
        { x: 1050, y: stripCY - 70, rx: 65, ry: 50, rot: 0.3 },
        { x: 1230, y: stripCY + 40, rx: 45, ry: 55, rot: -0.2 },
      ]) {
        const maxR = Math.max(f.rx, f.ry);
        for (const ox of [-STRIP_W, 0, STRIP_W]) {
          const fx = f.x + ox;
          if (fx + maxR < 0 || fx - maxR > STRIP_W) continue;
          p.save();
          p.translate(fx, f.y);
          p.rotate(f.rot);
          p.beginPath();
          p.ellipse(0, 0, f.rx, f.ry, 0, 0, Math.PI * 2);
          const g = p.createRadialGradient(0, 0, 0, 0, 0, f.rx);
          g.addColorStop(0, '#2d7a1e');
          g.addColorStop(0.4, '#1a5515');
          g.addColorStop(1, '#0a2808');
          p.fillStyle = g;
          p.fill();
          p.restore();
        }
      }

      // Lava rivers
      for (const lv of [
        { x: 170, y: stripCY + 60, rx: 75, ry: 4, rot: 0.7 },
        { x: 450, y: stripCY - 30, rx: 55, ry: 3.5, rot: -0.5 },
        { x: 650, y: stripCY - 80, rx: 45, ry: 3, rot: 1.2 },
        { x: 850, y: stripCY + 75, rx: 40, ry: 3.5, rot: -0.8 },
        { x: 1100, y: stripCY + 30, rx: 55, ry: 3, rot: 0.9 },
        { x: 280, y: stripCY - 50, rx: 35, ry: 3, rot: -0.6 },
      ]) {
        for (const ox of [-STRIP_W, 0, STRIP_W]) {
          const lvx = lv.x + ox;
          if (lvx + lv.rx < 0 || lvx - lv.rx > STRIP_W) continue;
          p.save();
          p.translate(lvx, lv.y);
          p.rotate(lv.rot);
          p.beginPath();
          p.ellipse(0, 0, lv.rx, lv.ry + 6, 0, 0, Math.PI * 2);
          p.fillStyle = 'rgba(255,60,0,0.12)';
          p.fill();
          p.beginPath();
          p.ellipse(0, 0, lv.rx, lv.ry, 0, 0, Math.PI * 2);
          const g = p.createLinearGradient(-lv.rx, 0, lv.rx, 0);
          g.addColorStop(0, 'rgba(255,80,10,0.1)');
          g.addColorStop(0.2, '#ff5500');
          g.addColorStop(0.5, '#ff7700');
          g.addColorStop(0.8, '#ff5500');
          g.addColorStop(1, 'rgba(255,80,10,0.1)');
          p.fillStyle = g;
          p.fill();
          p.restore();
        }
      }

      // Volcano craters
      for (const v of volcanoStripPos) {
        for (const ox of [-STRIP_W, 0, STRIP_W]) {
          const vx = v.x + ox;
          if (vx + v.r * 2.5 < 0 || vx - v.r * 2.5 > STRIP_W) continue;
          p.beginPath();
          p.arc(vx, v.y, v.r * 1.4, 0, Math.PI * 2);
          const cg = p.createRadialGradient(vx, v.y, 0, vx, v.y, v.r * 1.4);
          cg.addColorStop(0, '#cc5500');
          cg.addColorStop(0.5, '#5a2a0a');
          cg.addColorStop(1, '#2a1505');
          p.fillStyle = cg;
          p.fill();
          p.beginPath();
          p.arc(vx, v.y, v.r * 0.5, 0, Math.PI * 2);
          const lg = p.createRadialGradient(vx, v.y, 0, vx, v.y, v.r * 0.5);
          lg.addColorStop(0, '#ffdd00');
          lg.addColorStop(0.5, '#ff8800');
          lg.addColorStop(1, '#cc4400');
          p.fillStyle = lg;
          p.fill();
          p.beginPath();
          p.arc(vx, v.y, v.r * 2.5, 0, Math.PI * 2);
          const hg = p.createRadialGradient(vx, v.y, 0, vx, v.y, v.r * 2.5);
          hg.addColorStop(0, 'rgba(255,120,0,0.12)');
          hg.addColorStop(1, 'rgba(255,60,0,0)');
          p.fillStyle = hg;
          p.fill();
        }
      }

      // Storm cloud mass
      p.save();
      p.translate(stormStripPos.x, stormStripPos.y);
      p.rotate(0.2);
      for (const cp of [
        { x: 0, y: 0, rx: 100, ry: 65 },
        { x: -30, y: 15, rx: 60, ry: 45 },
        { x: 35, y: -10, rx: 55, ry: 40 },
      ]) {
        p.beginPath();
        p.ellipse(cp.x, cp.y, cp.rx, cp.ry, 0, 0, Math.PI * 2);
        const sg = p.createRadialGradient(cp.x, cp.y, 0, cp.x, cp.y, cp.rx);
        sg.addColorStop(0, 'rgba(10,5,20,0.75)');
        sg.addColorStop(0.5, 'rgba(20,12,35,0.45)');
        sg.addColorStop(1, 'rgba(0,0,0,0)');
        p.fillStyle = sg;
        p.fill();
      }
      p.restore();

      return off;
    })();

    // Ring bands and planet animation state
    const ringBands = [
      { r: PLANET_R * 1.12, w: 10, c: 'rgba(185,165,135,0.3)' },
      { r: PLANET_R * 1.22, w: 18, c: 'rgba(205,180,145,0.35)' },
      { r: PLANET_R * 1.38, w: 20, c: 'rgba(195,170,135,0.3)' },
      { r: PLANET_R * 1.52, w: 14, c: 'rgba(180,160,140,0.22)' },
      { r: PLANET_R * 1.67, w: 10, c: 'rgba(160,145,125,0.15)' },
    ];
    const RING_TILT = 0.28;
    const RING_ROT = -0.15;
    const PLANET_SCROLL_SPEED = 0.008; // ~4 min per full rotation
    let stormBolts: { pts: { x: number; y: number }[]; branches: { x: number; y: number }[][]; alpha: number; decay: number }[] = [];
    let nextBoltTime = 0;
    let stormFlash = 0;
    const makeBolt = (sx: number, sy: number, ex: number, ey: number, n: number): { x: number; y: number }[] => {
      const pts = [{ x: sx, y: sy }];
      for (let i = 1; i < n; i++) {
        const t = i / n;
        pts.push({ x: sx + (ex - sx) * t + (Math.random() - 0.5) * 35, y: sy + (ey - sy) * t + (Math.random() - 0.5) * 25 });
      }
      pts.push({ x: ex, y: ey });
      return pts;
    };

    // ── Astronaut — tumbling spaceman on a windy path ────────────
    const astroEl = document.createElement('img');
    astroEl.src = '/images/grib_astro.png';
    astroEl.style.cssText = 'position: absolute; pointer-events: none; display: none; z-index: 0;';
    this.element.appendChild(astroEl);
    let astroReady = false;
    astroEl.onload = () => { astroReady = true; };

    // ── Nick Sanders — fast flyby in a magical bubble ────────────
    const nickBubbleEl = document.createElement('div');
    nickBubbleEl.style.cssText = `
      position: absolute; pointer-events: none; display: none; z-index: 0;
      border-radius: 50%;
      background: radial-gradient(circle at 35% 35%,
        rgba(200,230,255,0.1) 0%, rgba(140,180,255,0.18) 30%,
        rgba(120,160,255,0.28) 60%, rgba(100,200,255,0.38) 80%,
        rgba(150,220,255,0.06) 100%);
      box-shadow: 0 0 25px rgba(120,180,255,0.5), 0 0 50px rgba(150,100,255,0.25),
        inset 0 0 30px rgba(200,230,255,0.25);
      overflow: hidden;
    `;
    const nickHighlight = document.createElement('div');
    nickHighlight.style.cssText = `
      position: absolute; bottom: 10%; right: 12%; width: 35%; height: 22%;
      background: radial-gradient(ellipse, rgba(255,255,255,0.35) 0%, transparent 100%);
      border-radius: 50%; transform: rotate(25deg); pointer-events: none; z-index: 2;
    `;
    nickBubbleEl.appendChild(nickHighlight);
    const nickImg = document.createElement('img');
    nickImg.src = '/images/nick_sanders.png';
    let nickReady = false;
    nickImg.onload = () => { nickReady = true; };
    nickImg.style.cssText = `
      position: absolute; top: 50%; left: 50%; width: 80%; height: 80%;
      transform: translate(-50%, -50%); object-fit: contain;
      border-radius: 50%; z-index: 1;
    `;
    nickBubbleEl.appendChild(nickImg);
    this.element.appendChild(nickBubbleEl);

    // Thought bubble — bottom-left anchored to astronaut's top-right corner
    const bubbleWrap = document.createElement('div');
    bubbleWrap.style.cssText = `
      position: absolute; pointer-events: none; display: none; z-index: 0;
      transform-origin: 50% 100%;
    `;
    // Main bubble
    const bubble = document.createElement('div');
    const astroThoughts = [
      "I'm fucked!",
      "I loved her...",
      "Where's Brad?",
      "STEVE! NOOOOO!",
      "Big Buuuuuush",
      "Berny's a fuckin' tard, ain't he?",
      "Where's the fucking gas station?",
      "I'll never get glad 😟",
      "Yeah, I'm huge",
      "Joel?",
      "Can't believe I'm actually 300 lbs...",
      "Am I gay?",
      "Cord??",
      "I'm looksmaxxing right now",
      "What's on the Dash tonight?",
      "Wish I had some bird right about now...",
      "T levels are TANKING!",
      "Shoulda stayed on the damn couch",
      "Always keep your appointments",
      "I should disband the guild",
      "Sure could use a sammich right about now",
      "I just shidded all over myself",
      "I'm Sketch MC Flex, I'm the best...",
      "I haven't shit in 3 weeks",
      "How do you talk to girls?",
      "Yeah, I like to beat on women, so what?",
      "Save the children",
      "Look at my deaths, LOOK AT MY DEATHS!",
      "Accoma-accom-commendations?",
      "I'm chorgin' on em!",
      "It's a goon angle",
      "I don't care for the blacks",
      "Tore open my dang scapuloid",
      "Only one more day til breakfast...",
      "Even Steven!",
      "Gotta get that bitrate goin",
    ];
    let shuffledThoughts: string[] = [];
    let thoughtIndex = 0;
    function nextThought(): string {
      if (thoughtIndex >= shuffledThoughts.length) {
        shuffledThoughts = [...astroThoughts];
        for (let i = shuffledThoughts.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [shuffledThoughts[i], shuffledThoughts[j]] = [shuffledThoughts[j], shuffledThoughts[i]];
        }
        thoughtIndex = 0;
      }
      return shuffledThoughts[thoughtIndex++];
    }
    bubble.textContent = nextThought();
    bubble.style.cssText = `
      background: #fff; color: #111; font-family: 'Comic Sans MS', 'Segoe UI', sans-serif;
      font-size: 15px; font-weight: 700; padding: 8px 14px; border-radius: 18px;
      white-space: nowrap;
      box-shadow: 0 2px 12px rgba(0,0,0,0.4);
    `;
    bubbleWrap.appendChild(bubble);
    // Trailing dots in normal flow (big → small, toward the anchor)
    const dotSizes = [10, 7, 5];
    for (let di = 0; di < 3; di++) {
      const dot = document.createElement('div');
      dot.style.cssText = `
        width: ${dotSizes[di]}px; height: ${dotSizes[di]}px; border-radius: 50%;
        background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,0.3);
        margin-top: 3px; margin-left: auto; margin-right: auto;
      `;
      bubbleWrap.appendChild(dot);
    }
    this.element.appendChild(bubbleWrap);
    let bubbleVisible = false;
    let bubbleDone = false; // prevents re-triggering after pop-out
    let bubbleShowTime = 0;
    let bubbleScale = 0;
    const BUBBLE_DURATION = 3500; // visible for 3.5s
    const BUBBLE_TRIGGER = 0.35; // show at 35% of journey
    const BUBBLE_POP_SPEED = 0.07; // scale change per frame at 60fps

    type AstroWaypoint = { x: number; y: number };
    type Astronaut = {
      path: AstroWaypoint[];  // bezier-style waypoints
      t: number;              // 0..1 progress along path
      speed: number;          // how fast t advances per frame
      rotation: number;
      rotSpeed: number;
      size: number;
    };
    let astronaut: Astronaut | null = null;
    let astroSpawnTime = 0; // timestamp of next spawn
    const ASTRO_INTERVAL = 3000; // 3 seconds
    let nextIsNick = false; // alternates between astronaut and nick

    type NickFlyby = {
      startX: number; startY: number;
      endX: number; endY: number;
      t: number;
      speed: number;
      rotation: number;
      rotSpeed: number;
      size: number;
    };
    let nickFlyby: NickFlyby | null = null;

    const spawnAstronaut = (): Astronaut => {
      const w = canvas.width, h = canvas.height;
      const margin = 180;
      // Pick a random edge to enter from
      const edge = Math.floor(Math.random() * 4);
      let startX: number, startY: number;
      if (edge === 0) { startX = -margin; startY = Math.random() * h; }
      else if (edge === 1) { startX = w + margin; startY = Math.random() * h; }
      else if (edge === 2) { startX = Math.random() * w; startY = -margin; }
      else { startX = Math.random() * w; startY = h + margin; }

      // Generate 5-7 waypoints that meander through the screen then exit off another edge
      const numWaypoints = 5 + Math.floor(Math.random() * 3);
      const path: AstroWaypoint[] = [{ x: startX, y: startY }];
      for (let i = 1; i < numWaypoints - 1; i++) {
        path.push({
          x: margin * 0.5 + Math.random() * (w - margin),
          y: margin * 0.5 + Math.random() * (h - margin),
        });
      }
      // Exit off a different edge
      let exitEdge = (edge + 1 + Math.floor(Math.random() * 3)) % 4;
      let endX: number, endY: number;
      if (exitEdge === 0) { endX = -margin; endY = Math.random() * h; }
      else if (exitEdge === 1) { endX = w + margin; endY = Math.random() * h; }
      else if (exitEdge === 2) { endX = Math.random() * w; endY = -margin; }
      else { endX = Math.random() * w; endY = h + margin; }
      path.push({ x: endX, y: endY });

      return {
        path,
        t: 0,
        speed: 0.0004 + Math.random() * 0.0003,
        rotation: Math.random() * Math.PI * 2,
        rotSpeed: (Math.random() - 0.5) * 0.03,
        size: 250 + Math.random() * 60,
      };
    };

    // Catmull-Rom spline interpolation for smooth windy paths
    const catmullRom = (p0: AstroWaypoint, p1: AstroWaypoint, p2: AstroWaypoint, p3: AstroWaypoint, t: number): { x: number; y: number } => {
      const t2 = t * t, t3 = t2 * t;
      return {
        x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      };
    };

    const getAstroPos = (astro: Astronaut): { x: number; y: number } => {
      const pts = astro.path;
      const totalSegments = pts.length - 1;
      const scaledT = astro.t * totalSegments;
      const seg = Math.min(Math.floor(scaledT), totalSegments - 1);
      const localT = scaledT - seg;
      const p0 = pts[Math.max(seg - 1, 0)];
      const p1 = pts[seg];
      const p2 = pts[Math.min(seg + 1, pts.length - 1)];
      const p3 = pts[Math.min(seg + 2, pts.length - 1)];
      return catmullRom(p0, p1, p2, p3, localT);
    };

    const spawnNickFlyby = (): NickFlyby => {
      const w = canvas.width, h = canvas.height;
      const margin = 200;
      const edge = Math.floor(Math.random() * 4);
      let startX: number, startY: number;
      if (edge === 0) { startX = -margin; startY = Math.random() * h; }
      else if (edge === 1) { startX = w + margin; startY = Math.random() * h; }
      else if (edge === 2) { startX = Math.random() * w; startY = -margin; }
      else { startX = Math.random() * w; startY = h + margin; }
      const exitEdge = edge ^ 1;
      let endX: number, endY: number;
      if (exitEdge === 0) { endX = -margin; endY = Math.random() * h; }
      else if (exitEdge === 1) { endX = w + margin; endY = Math.random() * h; }
      else if (exitEdge === 2) { endX = Math.random() * w; endY = -margin; }
      else { endX = Math.random() * w; endY = h + margin; }
      return {
        startX, startY, endX, endY,
        t: 0,
        speed: 0.0015 + Math.random() * 0.001,
        rotation: Math.random() * Math.PI * 2,
        rotSpeed: (Math.random() > 0.5 ? 1 : -1) * (0.012 + Math.random() * 0.01),
        size: 280 + Math.random() * 60,
      };
    };

    // ── Single merged animation loop ─────────────────────────────
    // Astronaut DOM updates run every frame (smooth 60fps movement).
    // Canvas drawing is throttled to ~15fps (plenty for slow ambient motion).
    let lastDrawTime = 0;
    const FRAME_INTERVAL = 66;
    let astroLastTime = 0;

    let lastLoopTime = 0;
    const animateLoop = (now: number) => {
      this.animationFrameId = requestAnimationFrame(animateLoop);
      if (document.hidden) return;
      // Throttle to ~10 FPS when tab is visible but not focused
      const focused = document.hasFocus();
      if (!focused && now - lastLoopTime < 100) return;
      lastLoopTime = now;

      // ── Astronaut update (every frame for smooth DOM movement) ──
      if (astroReady || nickReady) {
        const dt = astroLastTime ? Math.min((now - astroLastTime) / (1000 / 60), focused ? 3 : 8) : 1;
        astroLastTime = now;

        if (astroSpawnTime === 0) astroSpawnTime = now + ASTRO_INTERVAL;

        if (!astronaut && !nickFlyby && now >= astroSpawnTime) {
          if (nextIsNick && nickReady) {
            nickFlyby = spawnNickFlyby();
            nickBubbleEl.style.display = 'block';
          } else if (astroReady) {
            astronaut = spawnAstronaut();
            astroEl.style.display = 'block';
            bubble.textContent = nextThought();
            bubbleVisible = false;
            bubbleDone = false;
            bubbleShowTime = 0;
            bubbleScale = 0;
            bubbleWrap.style.display = 'none';
          }
        }

        if (astronaut) {
          astronaut.t += astronaut.speed * dt;
          astronaut.rotation += astronaut.rotSpeed * dt;

          if (astronaut.t >= 1) {
            astronaut = null;
            astroSpawnTime = now + ASTRO_INTERVAL;
            astroEl.style.display = 'none';
            bubbleWrap.style.display = 'none';
            bubbleVisible = false;
            bubbleScale = 0;
            nextIsNick = true;
          } else {
            const pos = getAstroPos(astronaut);
            const s = astronaut.size;
            const aspect = astroEl.naturalWidth / astroEl.naturalHeight;
            const drawH = s;
            const drawW = s * aspect;
            astroEl.style.width = `${drawW}px`;
            astroEl.style.height = `${drawH}px`;
            astroEl.style.left = `${pos.x - drawW / 2}px`;
            astroEl.style.top = `${pos.y - drawH / 2}px`;
            astroEl.style.transform = `rotate(${astronaut.rotation}rad)`;

            // Thought bubble — trigger once at 35% of journey
            const r = astronaut.rotation;
            if (!bubbleVisible && !bubbleDone && astronaut.t >= BUBBLE_TRIGGER) {
              bubbleVisible = true;
              bubbleShowTime = now;
              bubbleScale = 0;
              bubbleWrap.style.display = 'block';
            }
            if (bubbleVisible) {
              // Animate scale in/out
              const popping = now - bubbleShowTime > BUBBLE_DURATION;
              if (popping) {
                bubbleScale = Math.max(0, bubbleScale - BUBBLE_POP_SPEED * dt);
                if (bubbleScale <= 0) { bubbleWrap.style.display = 'none'; bubbleVisible = false; bubbleDone = true; }
              } else {
                bubbleScale = Math.min(1, bubbleScale + BUBBLE_POP_SPEED * dt);
              }
              // Anchor bottom-center of bubble to top-center of astronaut image
              const anchorX = pos.x + Math.sin(r) * (drawH / 2);
              const anchorY = pos.y - Math.cos(r) * (drawH / 2);
              bubbleWrap.style.left = `${anchorX}px`;
              bubbleWrap.style.top = `${anchorY}px`;
              // Dampen rotation so bubble leans with astronaut but stays readable
              let bubbleR = r % (Math.PI * 2);
              if (bubbleR > Math.PI) bubbleR -= Math.PI * 2;
              if (bubbleR < -Math.PI) bubbleR += Math.PI * 2;
              bubbleR *= 0.25;
              bubbleWrap.style.transform = `translate(-50%, -100%) rotate(${bubbleR}rad) scale(${bubbleScale})`;
            }
          }
        }

        // ── Nick Sanders flyby update ──
        if (nickFlyby) {
          nickFlyby.t += nickFlyby.speed * dt;
          nickFlyby.rotation += nickFlyby.rotSpeed * dt;

          if (nickFlyby.t >= 1) {
            nickFlyby = null;
            astroSpawnTime = now + ASTRO_INTERVAL;
            nickBubbleEl.style.display = 'none';
            nextIsNick = false;
          } else {
            const nx = nickFlyby.startX + (nickFlyby.endX - nickFlyby.startX) * nickFlyby.t;
            const ny = nickFlyby.startY + (nickFlyby.endY - nickFlyby.startY) * nickFlyby.t;
            const s = nickFlyby.size;
            nickBubbleEl.style.width = `${s}px`;
            nickBubbleEl.style.height = `${s}px`;
            nickBubbleEl.style.left = `${nx - s / 2}px`;
            nickBubbleEl.style.top = `${ny - s / 2}px`;
            nickBubbleEl.style.transform = `rotate(${nickFlyby.rotation}rad)`;
          }
        }
      }

      // ── Canvas background (throttled to ~15fps) ──
      if (now - lastDrawTime < FRAME_INTERVAL) return;
      lastDrawTime = now;

      ctx.fillStyle = 'rgba(0, 0, 0, 0.15)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Draw radial gradient base (cached)
      ctx.fillStyle = cachedBaseGradient;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // ── Sun ──────────────────────────────────────────────────────

      // Scene illumination (cached)
      ctx.globalAlpha = 1;
      ctx.fillStyle = cachedSunIllumGradient;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Corona — pulsing outer glow
      const coronaPulse = 1 + Math.sin(now * 0.0015) * 0.08;
      const coronaR = 70 * coronaPulse;
      const corona = ctx.createRadialGradient(sunX, sunY, sunRadius * 0.6, sunX, sunY, coronaR);
      corona.addColorStop(0, 'rgba(255, 230, 170, 0.3)');
      corona.addColorStop(0.4, 'rgba(255, 170, 60, 0.12)');
      corona.addColorStop(0.7, 'rgba(255, 100, 20, 0.04)');
      corona.addColorStop(1, 'rgba(255, 60, 10, 0)');
      ctx.fillStyle = corona;
      ctx.beginPath();
      ctx.arc(sunX, sunY, coronaR, 0, Math.PI * 2);
      ctx.fill();

      // Solar flares — animated prominences curving out from the surface
      for (const flare of solarFlares) {
        const t = now * flare.speed + flare.phase;
        const len = flare.length * (0.5 + 0.5 * Math.sin(t));
        if (len < 3) continue;
        const baseAngle = flare.angle + Math.sin(t * 0.7) * 0.15;
        const x1 = sunX + Math.cos(baseAngle - flare.width) * sunRadius * 0.9;
        const y1 = sunY + Math.sin(baseAngle - flare.width) * sunRadius * 0.9;
        const x2 = sunX + Math.cos(baseAngle + flare.width) * sunRadius * 0.9;
        const y2 = sunY + Math.sin(baseAngle + flare.width) * sunRadius * 0.9;
        const cpx = sunX + Math.cos(baseAngle) * (sunRadius + len);
        const cpy = sunY + Math.sin(baseAngle) * (sunRadius + len);
        const flareGrad = ctx.createRadialGradient(sunX, sunY, sunRadius * 0.8, sunX, sunY, sunRadius + len);
        flareGrad.addColorStop(0, 'rgba(255, 220, 100, 0.6)');
        flareGrad.addColorStop(0.5, 'rgba(255, 130, 30, 0.25)');
        flareGrad.addColorStop(1, 'rgba(255, 60, 10, 0)');
        ctx.globalAlpha = 0.7;
        ctx.fillStyle = flareGrad;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.quadraticCurveTo(cpx, cpy, x2, y2);
        ctx.closePath();
        ctx.fill();
      }

      // Sun body (cached gradient)
      ctx.globalAlpha = 1;
      ctx.fillStyle = cachedSunBodyGradient;
      ctx.beginPath();
      ctx.arc(sunX, sunY, sunRadius, 0, Math.PI * 2);
      ctx.fill();

      // Surface shimmer — moving bright spots on the sun
      ctx.globalAlpha = 0.15;
      for (let si = 0; si < 3; si++) {
        const shimAngle = now * 0.001 * (si + 1) + si * 2.1;
        const shimX = sunX + Math.cos(shimAngle) * sunRadius * 0.4;
        const shimY = sunY + Math.sin(shimAngle) * sunRadius * 0.3;
        const shimR = sunRadius * (0.25 + 0.15 * Math.sin(now * 0.002 + si));
        const shim = ctx.createRadialGradient(shimX, shimY, 0, shimX, shimY, shimR);
        shim.addColorStop(0, 'rgba(255, 255, 220, 0.5)');
        shim.addColorStop(1, 'rgba(255, 255, 200, 0)');
        ctx.fillStyle = shim;
        ctx.beginPath();
        ctx.arc(shimX, shimY, shimR, 0, Math.PI * 2);
        ctx.fill();
      }

      // Star-point light rays — elongated spikes
      ctx.globalAlpha = 1;
      const rayCount = 6;
      const rayBaseLen = 80 + Math.sin(now * 0.001) * 15;
      for (let ri = 0; ri < rayCount; ri++) {
        const rayAngle = (ri / rayCount) * Math.PI * 2 + Math.PI / 12;
        const rayLen = rayBaseLen * (0.7 + 0.3 * Math.sin(now * 0.0008 + ri * 1.5));
        const rw = 0.02;
        const rx1 = sunX + Math.cos(rayAngle - rw) * sunRadius;
        const ry1 = sunY + Math.sin(rayAngle - rw) * sunRadius;
        const rx2 = sunX + Math.cos(rayAngle + rw) * sunRadius;
        const ry2 = sunY + Math.sin(rayAngle + rw) * sunRadius;
        const rxTip = sunX + Math.cos(rayAngle) * (sunRadius + rayLen);
        const ryTip = sunY + Math.sin(rayAngle) * (sunRadius + rayLen);
        const rayGrad = ctx.createLinearGradient(sunX, sunY, rxTip, ryTip);
        rayGrad.addColorStop(0, 'rgba(255, 240, 180, 0.45)');
        rayGrad.addColorStop(0.3, 'rgba(255, 200, 100, 0.15)');
        rayGrad.addColorStop(1, 'rgba(255, 160, 60, 0)');
        ctx.fillStyle = rayGrad;
        ctx.beginPath();
        ctx.moveTo(rx1, ry1);
        ctx.lineTo(rxTip, ryTip);
        ctx.lineTo(rx2, ry2);
        ctx.closePath();
        ctx.fill();
      }

      // Dynamic lens flare — elements along sun → screen-center line
      const lfDx = canvas.width * 0.5 - sunX;
      const lfDy = canvas.height * 0.5 - sunY;
      const flareIntensity = 0.7 + 0.3 * Math.sin(now * 0.0012);
      ctx.globalAlpha = flareIntensity;
      for (const le of lensEls) {
        const lx = sunX + lfDx * le.t;
        const ly = sunY + lfDy * le.t;
        const pSize = le.size * (1 + 0.15 * Math.sin(now * 0.002 + le.t * 5));
        const leGrad = ctx.createRadialGradient(lx, ly, 0, lx, ly, pSize);
        leGrad.addColorStop(0, `rgba(${le.r}, ${le.g}, ${le.b}, ${le.a})`);
        leGrad.addColorStop(0.6, `rgba(${le.r}, ${le.g}, ${le.b}, ${le.a * 0.3})`);
        leGrad.addColorStop(1, 'transparent');
        ctx.fillStyle = leGrad;
        ctx.beginPath();
        ctx.arc(lx, ly, pSize, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.globalAlpha = 1;

      // Particles
      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;
        p.life++;
        if (p.life > p.maxLife) {
          p.x = Math.random() * canvas.width;
          p.y = Math.random() * canvas.height;
          p.life = 0;
        }
        const fade = p.life < 30 ? p.life / 30 : p.life > p.maxLife - 30 ? (p.maxLife - p.life) / 30 : 1;
        ctx.globalAlpha = fade * 0.8;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }

      // Streaks
      ctx.globalAlpha = 1;
      for (const s of streaks) {
        s.x += s.vx;
        if (s.x > canvas.width + 200) {
          s.x = -s.len - Math.random() * 400;
          s.y = Math.random() * canvas.height;
        }
        const grad = ctx.createLinearGradient(s.x, s.y, s.x + s.len, s.y);
        grad.addColorStop(0, 'transparent');
        grad.addColorStop(0.5, s.color);
        grad.addColorStop(1, 'transparent');
        ctx.strokeStyle = grad;
        ctx.globalAlpha = s.alpha;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(s.x + s.len, s.y);
        ctx.stroke();
      }

      // ── Exotic planet (bottom-right, rotating) ─────────────────
      const px = canvas.width - 180, py = canvas.height - 100;
      const scrollX = (now * PLANET_SCROLL_SPEED) % STRIP_W;

      // Atmospheric outer glow
      ctx.globalAlpha = 0.6;
      const planetAtmos = ctx.createRadialGradient(px, py, PLANET_R * 0.9, px, py, PLANET_R * 1.2);
      planetAtmos.addColorStop(0, 'rgba(40,80,180,0.08)');
      planetAtmos.addColorStop(0.5, 'rgba(30,60,150,0.04)');
      planetAtmos.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = planetAtmos;
      ctx.beginPath();
      ctx.arc(px, py, PLANET_R * 1.2, 0, Math.PI * 2);
      ctx.fill();

      // Back rings (top visual half — behind planet)
      ctx.globalAlpha = 1;
      for (const rb of ringBands) {
        ctx.beginPath();
        ctx.ellipse(px, py, rb.r, rb.r * RING_TILT, RING_ROT, Math.PI, 2 * Math.PI);
        ctx.strokeStyle = rb.c;
        ctx.lineWidth = rb.w;
        ctx.stroke();
      }

      // Planet surface — scrolling strip clipped to planet disk
      ctx.save();
      ctx.beginPath();
      ctx.arc(px, py, PLANET_R, 0, Math.PI * 2);
      ctx.clip();
      ctx.fillStyle = '#1a1a2e';
      ctx.fillRect(px - PLANET_R, py - PLANET_R, PLANET_R * 2, PLANET_R * 2);
      const stripDrawX = px - PLANET_R - scrollX;
      const stripDrawY = py - stripCY;
      ctx.drawImage(planetStrip, stripDrawX, stripDrawY);
      ctx.drawImage(planetStrip, stripDrawX + STRIP_W, stripDrawY);

      // 3D lighting overlay (fixed, doesn't rotate with surface)
      ctx.globalAlpha = 1;
      const pLight = ctx.createRadialGradient(px - PLANET_R * 0.45, py - PLANET_R * 0.45, 0, px, py, PLANET_R);
      pLight.addColorStop(0, 'rgba(255,240,200,0.12)');
      pLight.addColorStop(0.35, 'rgba(0,0,0,0)');
      pLight.addColorStop(0.75, 'rgba(0,0,0,0.35)');
      pLight.addColorStop(1, 'rgba(0,0,0,0.65)');
      ctx.fillStyle = pLight;
      ctx.fillRect(px - PLANET_R, py - PLANET_R, PLANET_R * 2, PLANET_R * 2);

      // Atmosphere rim highlight
      ctx.strokeStyle = 'rgba(80,140,255,0.12)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(px, py, PLANET_R - 1.5, 0, Math.PI * 2);
      ctx.stroke();

      // Volcano glow pulses (at scrolled strip positions)
      for (const v of volcanoStripPos) {
        for (let wrap = 0; wrap < 2; wrap++) {
          const vx = stripDrawX + v.x + wrap * STRIP_W;
          const vy = stripDrawY + v.y;
          const dx = vx - px, dy = vy - py;
          if (dx * dx + dy * dy > (PLANET_R + v.r * 3) * (PLANET_R + v.r * 3)) continue;
          const pulse = 0.5 + 0.5 * Math.sin(now * 0.003 + v.x * 0.1);
          ctx.globalAlpha = 0.12 + pulse * 0.15;
          const vg = ctx.createRadialGradient(vx, vy, 0, vx, vy, v.r * 3);
          vg.addColorStop(0, 'rgba(255,140,20,0.4)');
          vg.addColorStop(0.5, 'rgba(255,60,0,0.15)');
          vg.addColorStop(1, 'rgba(255,30,0,0)');
          ctx.fillStyle = vg;
          ctx.beginPath();
          ctx.arc(vx, vy, v.r * 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Lightning storm — pick the wrap position closest to planet center
      const stormSX1 = stripDrawX + stormStripPos.x;
      const stormSX2 = stormSX1 + STRIP_W;
      const stormSY = stripDrawY + stormStripPos.y;
      const useStormX = Math.abs(stormSX1 - px) < Math.abs(stormSX2 - px) ? stormSX1 : stormSX2;
      const sDx = useStormX - px, sDy = stormSY - py;
      const stormOnDisk = sDx * sDx + sDy * sDy < PLANET_R * PLANET_R;

      if (stormOnDisk && now > nextBoltTime) {
        const count = 1 + Math.floor(Math.random() * 3);
        for (let bi = 0; bi < count; bi++) {
          const sx = useStormX + (Math.random() - 0.5) * stormStripPos.rx;
          const sy = stormSY + (Math.random() - 0.5) * stormStripPos.ry * 0.5;
          const ex = sx + (Math.random() - 0.5) * 60;
          const ey = sy + 15 + Math.random() * 35;
          const main = makeBolt(sx, sy, ex, ey, 5 + Math.floor(Math.random() * 4));
          const branches: { x: number; y: number }[][] = [];
          for (let j = 0, nb = Math.floor(Math.random() * 3); j < nb; j++) {
            const mi = 1 + Math.floor(Math.random() * (main.length - 2));
            const mp = main[mi];
            branches.push(makeBolt(mp.x, mp.y, mp.x + (Math.random() - 0.5) * 40, mp.y + 10 + Math.random() * 20, 3));
          }
          stormBolts.push({ pts: main, branches, alpha: 1.0, decay: 0.06 + Math.random() * 0.04 });
        }
        stormFlash = 0.5;
        nextBoltTime = now + 800 + Math.random() * 2500;
      }

      // Storm flash decay (always runs)
      if (stormFlash > 0) {
        stormFlash *= 0.85;
        if (stormFlash < 0.01) stormFlash = 0;
      }

      // Storm flash draw (only when on disk)
      if (stormFlash > 0.01 && stormOnDisk) {
        ctx.globalAlpha = stormFlash * 0.35;
        const fg = ctx.createRadialGradient(useStormX, stormSY, 0, useStormX, stormSY, stormStripPos.rx);
        fg.addColorStop(0, 'rgba(180,180,255,0.5)');
        fg.addColorStop(0.5, 'rgba(120,120,200,0.2)');
        fg.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = fg;
        ctx.beginPath();
        ctx.arc(useStormX, stormSY, stormStripPos.rx, 0, Math.PI * 2);
        ctx.fill();
      }

      // Draw lightning bolts
      for (let i = stormBolts.length - 1; i >= 0; i--) {
        const bolt = stormBolts[i];
        bolt.alpha -= bolt.decay;
        if (bolt.alpha <= 0) { stormBolts.splice(i, 1); continue; }
        // Glow
        ctx.globalAlpha = bolt.alpha * 0.5;
        ctx.strokeStyle = 'rgba(150,150,255,0.6)';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(bolt.pts[0].x, bolt.pts[0].y);
        for (let j = 1; j < bolt.pts.length; j++) ctx.lineTo(bolt.pts[j].x, bolt.pts[j].y);
        ctx.stroke();
        // Core
        ctx.globalAlpha = bolt.alpha;
        ctx.strokeStyle = `rgba(220,220,255,${bolt.alpha})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(bolt.pts[0].x, bolt.pts[0].y);
        for (let j = 1; j < bolt.pts.length; j++) ctx.lineTo(bolt.pts[j].x, bolt.pts[j].y);
        ctx.stroke();
        // Branches
        ctx.globalAlpha = bolt.alpha * 0.5;
        ctx.strokeStyle = 'rgba(180,180,255,0.5)';
        ctx.lineWidth = 1;
        for (const br of bolt.branches) {
          ctx.beginPath();
          ctx.moveTo(br[0].x, br[0].y);
          for (let j = 1; j < br.length; j++) ctx.lineTo(br[j].x, br[j].y);
          ctx.stroke();
        }
      }

      ctx.restore(); // end planet clip

      // Front rings (bottom visual half — in front of planet)
      ctx.globalAlpha = 1;
      for (const rb of ringBands) {
        ctx.beginPath();
        ctx.ellipse(px, py, rb.r, rb.r * RING_TILT, RING_ROT, 0, Math.PI);
        ctx.strokeStyle = rb.c;
        ctx.lineWidth = rb.w;
        ctx.stroke();
      }

      ctx.globalAlpha = 1;

      // Asteroids — pre-rendered, just drawImage with rotation
      if (asteroidList.length < 3 && Math.random() < 0.004) asteroidList.push(makeAsteroid());

      for (let i = asteroidList.length - 1; i >= 0; i--) {
        const a = asteroidList[i];
        a.x += a.vx; a.y += a.vy; a.rotation += a.rotSpeed;
        const m = a.size * 2;
        if (a.x < -m || a.x > canvas.width + m || a.y < -m || a.y > canvas.height + m) {
          asteroidList.splice(i, 1); continue;
        }
        ctx.save();
        ctx.translate(a.x, a.y);
        ctx.rotate(a.rotation);
        ctx.globalAlpha = 1;
        ctx.drawImage(a.preRendered, -a.preRendered.width / 2, -a.preRendered.height / 2);
        ctx.restore();
      }

      ctx.globalAlpha = 1;
    };
    this.animationFrameId = requestAnimationFrame(animateLoop);

    // ── Content wrapper (over canvas) ───────────────────────────────
    const content = document.createElement('div');
    content.style.cssText = 'position: relative; z-index: 1; display: flex; flex-direction: column; align-items: center;';

    // ── Banner: "LET THE GOOD TIMES ROLL" ───────────────────────────
    const bannerWrap = document.createElement('div');
    bannerWrap.style.cssText = 'position: relative; margin-bottom: 32px; text-align: center;';

    // Decorative line left/right of banner
    const decoLine = (side: 'left' | 'right') => {
      const line = document.createElement('div');
      line.style.cssText = `
        position: absolute; top: 50%; ${side}: -80px;
        width: 60px; height: 2px;
        background: linear-gradient(${side === 'left' ? 'to left' : 'to right'}, rgba(255,180,50,0.8), transparent);
        transform: translateY(-50%);
      `;
      return line;
    };

    // Outer glow ring behind the banner
    const glowRing = document.createElement('div');
    glowRing.style.cssText = `
      position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
      width: 500px; height: 120px; border-radius: 50%;
      background: radial-gradient(ellipse, rgba(255,150,30,0.12) 0%, transparent 70%);
      animation: gtr-pulse-ring 3s ease-in-out infinite;
      pointer-events: none;
    `;
    bannerWrap.appendChild(glowRing);

    const bannerText = document.createElement('div');
    bannerText.textContent = 'LET THE GOOD TIMES ROLL';
    bannerText.style.cssText = `
      font-family: 'Impact', 'Arial Black', 'Segoe UI', sans-serif;
      font-size: 42px; font-weight: 900; letter-spacing: 4px;
      background: linear-gradient(90deg, #ff8833, #ffcc44, #ffe066, #ffcc44, #ff8833);
      background-size: 200% 100%;
      -webkit-background-clip: text; -webkit-text-fill-color: transparent;
      background-clip: text;
      animation: gtr-banner-gradient 3s ease infinite, gtr-banner-glow 2s ease-in-out infinite;
      text-transform: uppercase; position: relative;
      filter: drop-shadow(0 2px 8px rgba(255,150,0,0.4));
    `;

    // Sub-line beneath the banner
    const subLine = document.createElement('div');
    subLine.style.cssText = `
      margin-top: 8px; font-family: 'Segoe UI', sans-serif;
      font-size: 13px; letter-spacing: 6px; text-transform: uppercase;
      color: rgba(150, 170, 220, 0.7);
    `;
    subLine.textContent = 'ARENA COMBAT';

    // Decorative diamond separators
    const diamonds = document.createElement('div');
    diamonds.style.cssText = 'margin-top: 12px; display: flex; justify-content: center; gap: 8px;';
    for (let i = 0; i < 5; i++) {
      const d = document.createElement('div');
      const isCenter = i === 2;
      d.style.cssText = `
        width: ${isCenter ? 8 : 5}px; height: ${isCenter ? 8 : 5}px;
        background: ${isCenter ? '#ffcc44' : 'rgba(100,130,200,0.5)'};
        transform: rotate(45deg);
        ${isCenter ? 'box-shadow: 0 0 8px rgba(255,200,50,0.6);' : ''}
      `;
      diamonds.appendChild(d);
    }

    bannerWrap.appendChild(decoLine('left'));
    bannerWrap.appendChild(decoLine('right'));
    bannerWrap.appendChild(bannerText);
    bannerWrap.appendChild(subLine);
    bannerWrap.appendChild(diamonds);
    content.appendChild(bannerWrap);

    // ── Login box ───────────────────────────────────────────────────
    const box = document.createElement('div');
    box.style.cssText = `
      background: linear-gradient(to bottom, rgba(20, 20, 35, 0.92), rgba(10, 10, 20, 0.95));
      border: 1px solid rgba(100, 120, 200, 0.3);
      border-radius: 8px; width: 320px;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      overflow: hidden;
      box-shadow: 0 0 40px rgba(60, 80, 180, 0.15), 0 0 80px rgba(255, 150, 50, 0.05);
    `;

    // ── Title ──────────────────────────────────────────────────────────
    const titleArea = document.createElement('div');
    titleArea.style.cssText = 'padding: 32px 40px 20px; text-align: center;';

    const title = document.createElement('div');
    title.textContent = 'GTR Arena';
    title.style.cssText = `
      color: #8899cc; font-size: 28px; font-weight: bold; margin-bottom: 4px;
      text-shadow: 0 0 10px rgba(100, 140, 255, 0.3);
    `;

    titleArea.appendChild(title);

    // ── Tabs ───────────────────────────────────────────────────────────
    const tabBar = document.createElement('div');
    tabBar.style.cssText = 'display: flex; border-bottom: 1px solid rgba(100, 120, 200, 0.15);';

    const loginTab = document.createElement('button');
    loginTab.textContent = 'Log In';
    const registerTab = document.createElement('button');
    registerTab.textContent = 'Register';

    const tabBase = `
      flex: 1; padding: 12px 0; font-size: 14px; font-weight: 600;
      background: none; border: none; border-bottom: 2px solid transparent;
      cursor: pointer; outline: none; transition: color 0.15s, border-color 0.15s;
    `;
    loginTab.style.cssText = tabBase;
    registerTab.style.cssText = tabBase;

    const updateTabs = () => {
      if (this.mode === 'login') {
        loginTab.style.color = '#aabbee';
        loginTab.style.borderBottomColor = '#6688cc';
        registerTab.style.color = '#556';
        registerTab.style.borderBottomColor = 'transparent';
        this.confirmPasswordInput.style.display = 'none';
      } else {
        registerTab.style.color = '#aabbee';
        registerTab.style.borderBottomColor = '#6688cc';
        loginTab.style.color = '#556';
        loginTab.style.borderBottomColor = 'transparent';
        this.confirmPasswordInput.style.display = 'block';
      }
      this.errorEl.textContent = '';
    };

    loginTab.addEventListener('click', () => { this.mode = 'login'; updateTabs(); });
    registerTab.addEventListener('click', () => { this.mode = 'register'; updateTabs(); });

    tabBar.appendChild(loginTab);
    tabBar.appendChild(registerTab);

    // ── Form ──────────────────────────────────────────────────────────
    const form = document.createElement('div');
    form.style.cssText = 'padding: 24px 40px 32px;';

    const inputStyle = `
      width: 100%; padding: 10px 14px; font-size: 14px; box-sizing: border-box;
      background: rgba(0, 0, 0, 0.5); color: #ccc;
      border: 1px solid rgba(100, 120, 200, 0.25); border-radius: 4px;
      outline: none; display: block; margin-bottom: 12px;
    `;

    const addFocusBorder = (input: HTMLInputElement) => {
      input.addEventListener('focus', () => { input.style.borderColor = 'rgba(100, 140, 255, 0.5)'; });
      input.addEventListener('blur', () => { input.style.borderColor = 'rgba(100, 120, 200, 0.25)'; });
    };

    const usernameInput = document.createElement('input');
    usernameInput.type = 'text';
    usernameInput.placeholder = 'Username';
    usernameInput.maxLength = 20;
    usernameInput.style.cssText = inputStyle;
    addFocusBorder(usernameInput);

    const passwordInput = document.createElement('input');
    passwordInput.type = 'password';
    passwordInput.placeholder = 'Password';
    passwordInput.style.cssText = inputStyle;
    addFocusBorder(passwordInput);

    this.confirmPasswordInput = document.createElement('input');
    this.confirmPasswordInput.type = 'password';
    this.confirmPasswordInput.placeholder = 'Confirm Password';
    this.confirmPasswordInput.style.cssText = inputStyle;
    this.confirmPasswordInput.style.display = 'none';
    addFocusBorder(this.confirmPasswordInput);

    this.errorEl = document.createElement('div');
    this.errorEl.style.cssText = 'color: #cc4444; font-size: 12px; min-height: 18px; margin-bottom: 8px; white-space: pre-line;';

    this.submitBtn = document.createElement('button');
    const submitBtn = this.submitBtn;
    submitBtn.textContent = 'Enter Arena';
    submitBtn.style.cssText = `
      width: 100%; padding: 11px 0; font-size: 14px; font-weight: bold;
      background: rgba(60, 80, 160, 0.8); color: #ddd;
      border: 1px solid rgba(100, 140, 255, 0.3); border-radius: 4px;
      cursor: pointer; outline: none; transition: opacity 0.15s;
    `;
    submitBtn.addEventListener('mouseenter', () => { if (!this.loading) submitBtn.style.background = 'rgba(70, 95, 185, 0.9)'; });
    submitBtn.addEventListener('mouseleave', () => { if (!this.loading) submitBtn.style.background = 'rgba(60, 80, 160, 0.8)'; });

    const submit = () => {
      if (this.loading) return;
      const name = usernameInput.value.trim();
      const pass = passwordInput.value;

      if (name.length < 1 || name.length > 20) {
        this.errorEl.textContent = 'Username must be 1-20 characters';
        return;
      }
      if (!/^[a-zA-Z0-9]+$/.test(name)) {
        this.errorEl.textContent = 'Username must contain only letters and numbers';
        return;
      }
      if (pass.length < 1) {
        this.errorEl.textContent = 'Password is required';
        return;
      }
      if (this.mode === 'register') {
        if (this.confirmPasswordInput.value !== pass) {
          this.errorEl.textContent = 'Passwords do not match';
          return;
        }
      }
      this.errorEl.textContent = '';
      this.setLoading(true);
      this.onAuth({ username: name, password: pass, mode: this.mode });
    };

    submitBtn.addEventListener('click', submit);
    usernameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') passwordInput.focus(); });
    passwordInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        if (this.mode === 'register') this.confirmPasswordInput.focus();
        else submit();
      }
    });
    this.confirmPasswordInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

    // Pre-fill username if saved
    const savedName = sessionStorage.getItem('gtr_username');
    if (savedName) usernameInput.value = savedName;

    form.appendChild(usernameInput);
    form.appendChild(passwordInput);
    form.appendChild(this.confirmPasswordInput);
    form.appendChild(this.errorEl);
    form.appendChild(submitBtn);

    box.appendChild(titleArea);
    box.appendChild(tabBar);
    box.appendChild(form);
    content.appendChild(box);
    this.element.appendChild(content);

    // Initial tab state
    updateTabs();

    // ── Menu button (bottom-left) ───────────────────────────────────
    const menuBtn = document.createElement('button');
    menuBtn.textContent = 'Menu';
    menuBtn.style.cssText = `
      position: absolute; bottom: 20px; left: 20px;
      padding: 8px 20px; font-size: 13px; font-weight: bold;
      background: rgba(30, 30, 50, 0.7); color: #aab;
      border: 1px solid rgba(100, 120, 200, 0.2); border-radius: 4px;
      cursor: pointer; outline: none;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      transition: all 0.15s;
    `;
    menuBtn.addEventListener('mouseenter', () => {
      menuBtn.style.background = 'rgba(40, 40, 70, 0.85)';
      menuBtn.style.color = '#ccd';
    });
    menuBtn.addEventListener('mouseleave', () => {
      menuBtn.style.background = 'rgba(30, 30, 50, 0.7)';
      menuBtn.style.color = '#aab';
    });
    menuBtn.addEventListener('click', () => this.onMenu?.());
    this.element.appendChild(menuBtn);

    // ── Background music with fade-in ──────────────────────────────
    this.startMusic();
    audioSettings.onChange(this.onAudioSettingsChange);
  }

  private get authMusicVolume(): number {
    return audioSettings.windowFocused ? audioSettings.masterVolume * audioSettings.musicVolume * 2 : 0;
  }

  private handleAudioSettingsChange(s: { masterVolume: number; enableMusic: boolean; musicVolume: number }): void {
    if (!s.enableMusic) {
      this.fadeOutMusic();
    } else if (this.audioCtx && !this.fadingOut) {
      // Live volume update (also handles focus/blur)
      const ctx = this.audioCtx;
      const gain = this.gainNode!;
      gain.gain.cancelScheduledValues(ctx.currentTime);
      gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(this.authMusicVolume, ctx.currentTime + 0.15);
    } else {
      // Music was off, re-enable
      this.startMusic();
    }
  }

  private async startMusic(): Promise<void> {
    if (!audioSettings.enableMusic) return;
    // Already playing
    if (this.audioCtx && !this.fadingOut) return;
    // Was fading out — wait for cleanup then restart
    if (this.fadingOut) {
      await new Promise<void>(r => setTimeout(r, 1700));
    }
    this.fadingOut = false;
    try {
      const ctx = new AudioContext();
      this.audioCtx = ctx;
      const gain = ctx.createGain();
      this.gainNode = gain;
      gain.gain.value = 0;
      gain.connect(ctx.destination);

      const resp = await fetch('/audio/music/login.ogg');
      const buf = await resp.arrayBuffer();
      const audioBuf = await ctx.decodeAudioData(buf);

      // Don't start if we were destroyed while loading
      if (this.fadingOut) return;

      const source = ctx.createBufferSource();
      this.sourceNode = source;
      source.buffer = audioBuf;
      source.loop = true;
      source.connect(gain);
      source.start();

      document.addEventListener('visibilitychange', this.onVisibilityChange);

      if (ctx.state === 'suspended') {
        for (const evt of ['pointerdown', 'keydown'] as const) {
          document.addEventListener(evt, this.onUserGesture, { once: false });
        }
      } else if (audioSettings.windowFocused) {
        gain.gain.linearRampToValueAtTime(this.authMusicVolume, ctx.currentTime + 2);
      }
    } catch {
      // Audio playback not available — silent fail
    }
  }

  private resumeAudioCtx(): void {
    if (!this.audioCtx || this.fadingOut) return;
    this.audioCtx.resume().then(() => {
      // Remove gesture listeners once resumed
      for (const evt of ['pointerdown', 'keydown'] as const) {
        document.removeEventListener(evt, this.onUserGesture);
      }
      if (!this.fadingOut && this.gainNode && this.audioCtx && audioSettings.windowFocused) {
        this.gainNode.gain.linearRampToValueAtTime(this.authMusicVolume, this.audioCtx.currentTime + 2);
      }
    });
  }

  private handleVisibilityChange(): void {
    if (this.fadingOut || !this.audioCtx || !this.gainNode) return;
    const ctx = this.audioCtx;
    const gain = this.gainNode;
    gain.gain.cancelScheduledValues(ctx.currentTime);
    gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime);
    if (document.hidden) {
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.3);
    } else {
      gain.gain.linearRampToValueAtTime(this.authMusicVolume, ctx.currentTime + 0.5);
    }
  }

  showError(message: string): void {
    this.setLoading(false);
    this.errorEl.textContent = message;
  }

  private setLoading(on: boolean): void {
    this.loading = on;
    this.submitBtn.disabled = on;
    this.submitBtn.textContent = on ? 'Connecting...' : 'Enter Arena';
    this.submitBtn.style.opacity = on ? '0.6' : '1';
    this.submitBtn.style.cursor = on ? 'default' : 'pointer';
  }

  destroy(): void {
    cancelAnimationFrame(this.animationFrameId);
    this.element.remove();
    audioSettings.removeListener(this.onAudioSettingsChange);
    this.fadeOutMusic();
  }

  private fadeOutMusic(): void {
    this.fadingOut = true;
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    for (const evt of ['pointerdown', 'keydown'] as const) {
      document.removeEventListener(evt, this.onUserGesture);
    }
    if (!this.audioCtx || !this.gainNode) return;
    const ctx = this.audioCtx;
    const gain = this.gainNode;
    // Fade out over 1.5 seconds, then stop and close
    gain.gain.cancelScheduledValues(ctx.currentTime);
    gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 1.5);
    setTimeout(() => {
      this.sourceNode?.stop();
      ctx.close();
      this.audioCtx = null;
      this.gainNode = null;
      this.sourceNode = null;
    }, 1600);
  }
}

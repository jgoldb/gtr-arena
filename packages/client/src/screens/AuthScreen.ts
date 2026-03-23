export interface AuthResult {
  username: string;
  password: string;
  mode: 'login' | 'register';
}

export class AuthScreen {
  readonly element: HTMLDivElement;
  private onAuth: (result: AuthResult) => void;
  private errorEl: HTMLDivElement;
  private confirmPasswordInput: HTMLInputElement;
  private submitBtn!: HTMLButtonElement;
  private mode: 'login' | 'register' = 'login';
  private animationFrameId: number = 0;
  private loading = false;

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

    const resize = () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight; };
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

    // Asteroids — large detailed rocks drifting through
    type AsteroidRock = {
      x: number; y: number; vx: number; vy: number;
      rotation: number; rotSpeed: number; size: number;
      shape: number[];
      craters: { cx: number; cy: number; r: number }[];
      ridges: { dist: number; start: number; len: number }[];
      rgb: [number, number, number];
    };
    const asteroidList: AsteroidRock[] = [];

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
      return { x, y, vx, vy, rotation: Math.random() * Math.PI * 2, rotSpeed: (Math.random() - 0.5) * 0.004, size, shape, craters, ridges, rgb: palettes[Math.floor(Math.random() * palettes.length)] };
    };

    let lastDrawTime = 0;
    const FRAME_INTERVAL = 66; // ~15fps — plenty for slow ambient motion

    const animateBg = (now: number) => {
      this.animationFrameId = requestAnimationFrame(animateBg);
      if (document.hidden) return;
      if (now - lastDrawTime < FRAME_INTERVAL) return;
      lastDrawTime = now;

      ctx.fillStyle = 'rgba(0, 0, 0, 0.15)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Draw radial gradient base
      const grd = ctx.createRadialGradient(canvas.width / 2, canvas.height / 2, 0, canvas.width / 2, canvas.height / 2, canvas.width * 0.6);
      grd.addColorStop(0, 'rgba(15, 10, 30, 0.05)');
      grd.addColorStop(1, 'rgba(0, 0, 0, 0.1)');
      ctx.fillStyle = grd;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

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

      // Asteroids — occasional large rocks drifting through
      if (asteroidList.length < 3 && Math.random() < 0.004) asteroidList.push(makeAsteroid());

      for (let i = asteroidList.length - 1; i >= 0; i--) {
        const a = asteroidList[i];
        a.x += a.vx; a.y += a.vy; a.rotation += a.rotSpeed;
        const m = a.size * 2;
        if (a.x < -m || a.x > canvas.width + m || a.y < -m || a.y > canvas.height + m) {
          asteroidList.splice(i, 1); continue;
        }
        const [r, g, b] = a.rgb;
        ctx.save();
        ctx.translate(a.x, a.y);
        ctx.rotate(a.rotation);

        // Body shape
        ctx.beginPath();
        for (let j = 0; j < a.shape.length; j += 2) {
          const px = Math.cos(a.shape[j]) * a.shape[j + 1];
          const py = Math.sin(a.shape[j]) * a.shape[j + 1];
          j === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.globalAlpha = 0.8;
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fill();

        // 3D lighting gradient (lit from upper-left)
        const lg = ctx.createRadialGradient(-a.size * 0.3, -a.size * 0.3, 0, 0, 0, a.size);
        lg.addColorStop(0, `rgba(${r + 55},${g + 50},${b + 45},0.35)`);
        lg.addColorStop(0.5, 'rgba(0,0,0,0)');
        lg.addColorStop(1, 'rgba(0,0,0,0.35)');
        ctx.fillStyle = lg;
        ctx.fill();

        // Edge outline
        ctx.strokeStyle = `rgba(${r + 35},${g + 30},${b + 25},0.35)`;
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Craters
        for (const c of a.craters) {
          ctx.globalAlpha = 0.5;
          ctx.beginPath();
          ctx.arc(c.cx, c.cy, c.r, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${r - 25},${g - 25},${b - 20},0.7)`;
          ctx.fill();
          ctx.beginPath();
          ctx.arc(c.cx - c.r * 0.25, c.cy - c.r * 0.25, c.r * 0.75, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(${r + 25},${g + 20},${b + 15},0.2)`;
          ctx.lineWidth = 0.8;
          ctx.stroke();
        }

        // Surface ridges
        ctx.globalAlpha = 0.15;
        ctx.strokeStyle = `rgb(${r - 15},${g - 15},${b - 10})`;
        ctx.lineWidth = 0.7;
        for (const rd of a.ridges) {
          ctx.beginPath();
          ctx.arc(0, 0, rd.dist, rd.start, rd.start + rd.len);
          ctx.stroke();
        }

        ctx.restore();
      }

      ctx.globalAlpha = 1;
    };
    this.animationFrameId = requestAnimationFrame(animateBg);

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
    this.errorEl.style.cssText = 'color: #cc4444; font-size: 12px; min-height: 18px; margin-bottom: 8px;';

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
  }
}

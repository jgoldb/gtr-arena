import { initAuthBackground, type AuthBackgroundHandle } from './AuthBackground';
import { AuthMusicController } from './AuthMusic';

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
  private loading = false;
  private backgroundHandle: AuthBackgroundHandle;
  private music: AuthMusicController;
  private initialFocusTarget: HTMLInputElement | null = null;

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

    // ── Animated background ─────────────────────────────────────────
    this.backgroundHandle = initAuthBackground(this.element);

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
    passwordInput.maxLength = 128;
    passwordInput.style.cssText = inputStyle;
    addFocusBorder(passwordInput);

    this.confirmPasswordInput = document.createElement('input');
    this.confirmPasswordInput.type = 'password';
    this.confirmPasswordInput.placeholder = 'Confirm Password';
    this.confirmPasswordInput.maxLength = 128;
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
      if (pass.length < 1 || pass.length > 128) {
        this.errorEl.textContent = 'Password must be 1-128 characters';
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
    const savedName = sessionStorage.getItem('gtr_username') || localStorage.getItem('gtr_last_username');
    if (savedName) {
      usernameInput.value = savedName;
      this.initialFocusTarget = passwordInput;
    } else {
      this.initialFocusTarget = usernameInput;
    }

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
    this.music = new AuthMusicController();
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

  focus(): void {
    this.initialFocusTarget?.focus();
  }

  destroy(): void {
    this.backgroundHandle.destroy();
    this.element.remove();
    this.music.destroy();
  }
}

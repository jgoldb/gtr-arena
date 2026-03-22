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
  private mode: 'login' | 'register' = 'login';

  constructor(onAuth: (result: AuthResult) => void) {
    this.onAuth = onAuth;
    this.element = document.createElement('div');
    this.element.style.cssText = `
      position: fixed; inset: 0; z-index: 1000;
      display: flex; align-items: center; justify-content: center;
      background: radial-gradient(ellipse at center, #0a0a14 0%, #000000 100%);
    `;

    const box = document.createElement('div');
    box.style.cssText = `
      background: linear-gradient(to bottom, rgba(20, 20, 35, 0.95), rgba(10, 10, 20, 0.95));
      border: 1px solid rgba(100, 120, 200, 0.3);
      border-radius: 8px; width: 320px;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      overflow: hidden;
    `;

    // ── Title ──────────────────────────────────────────────────────────
    const titleArea = document.createElement('div');
    titleArea.style.cssText = 'padding: 32px 40px 20px; text-align: center;';

    const title = document.createElement('div');
    title.textContent = 'GTR Arena';
    title.style.cssText = 'color: #8899cc; font-size: 28px; font-weight: bold; margin-bottom: 4px;';

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

    const submitBtn = document.createElement('button');
    submitBtn.textContent = 'Enter Arena';
    submitBtn.style.cssText = `
      width: 100%; padding: 11px 0; font-size: 14px; font-weight: bold;
      background: rgba(60, 80, 160, 0.8); color: #ddd;
      border: 1px solid rgba(100, 140, 255, 0.3); border-radius: 4px;
      cursor: pointer; outline: none;
    `;
    submitBtn.addEventListener('mouseenter', () => { submitBtn.style.background = 'rgba(70, 95, 185, 0.9)'; });
    submitBtn.addEventListener('mouseleave', () => { submitBtn.style.background = 'rgba(60, 80, 160, 0.8)'; });

    const submit = () => {
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
    this.element.appendChild(box);

    // Initial tab state
    updateTabs();
  }

  showError(message: string): void {
    this.errorEl.textContent = message;
  }

  destroy(): void {
    this.element.remove();
  }
}

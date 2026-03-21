export interface AuthResult {
  username: string;
  token: string;
}

export class AuthScreen {
  readonly element: HTMLDivElement;
  private onAuth: (result: AuthResult) => void;

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
      border-radius: 8px; padding: 40px 50px; text-align: center;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
    `;

    const title = document.createElement('div');
    title.textContent = 'GTR Arena';
    title.style.cssText = 'color: #8899cc; font-size: 28px; font-weight: bold; margin-bottom: 8px;';

    const subtitle = document.createElement('div');
    subtitle.textContent = 'Enter your name to begin';
    subtitle.style.cssText = 'color: #556; font-size: 13px; margin-bottom: 24px;';

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Username';
    input.maxLength = 20;
    input.style.cssText = `
      width: 220px; padding: 10px 14px; font-size: 15px;
      background: rgba(0, 0, 0, 0.5); color: #ccc;
      border: 1px solid rgba(100, 120, 200, 0.3); border-radius: 4px;
      outline: none; display: block; margin: 0 auto 16px;
    `;
    input.addEventListener('focus', () => { input.style.borderColor = 'rgba(100, 140, 255, 0.5)'; });
    input.addEventListener('blur', () => { input.style.borderColor = 'rgba(100, 120, 200, 0.3)'; });

    const error = document.createElement('div');
    error.style.cssText = 'color: #cc4444; font-size: 12px; margin-bottom: 8px; min-height: 16px;';

    const btn = document.createElement('button');
    btn.textContent = 'Enter Arena';
    btn.style.cssText = `
      padding: 10px 32px; font-size: 14px; font-weight: bold;
      background: rgba(60, 80, 160, 0.8); color: #ddd;
      border: 1px solid rgba(100, 140, 255, 0.3); border-radius: 4px;
      cursor: pointer; outline: none;
    `;

    const submit = () => {
      const name = input.value.trim();
      if (name.length < 1 || name.length > 20) {
        error.textContent = 'Name must be 1-20 characters';
        return;
      }
      let token = sessionStorage.getItem('gtr_token');
      if (!token) {
        token = crypto.randomUUID();
        sessionStorage.setItem('gtr_token', token);
      }
      sessionStorage.setItem('gtr_username', name);
      this.onAuth({ username: name, token });
    };

    btn.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

    // Pre-fill if returning in same tab
    const savedName = sessionStorage.getItem('gtr_username');
    if (savedName) input.value = savedName;

    box.appendChild(title);
    box.appendChild(subtitle);
    box.appendChild(input);
    box.appendChild(error);
    box.appendChild(btn);
    this.element.appendChild(box);

    // Auto-login if already has credentials in this tab
    const existingToken = sessionStorage.getItem('gtr_token');
    if (savedName && existingToken) {
      this.onAuth({ username: savedName, token: existingToken });
    }
  }

  destroy(): void {
    this.element.remove();
  }
}

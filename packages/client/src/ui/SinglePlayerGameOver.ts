export interface SinglePlayerGameOverOptions {
  won: boolean;
  opponentName: string;
  onRematch: () => void;
  onExit: () => void;
  /** Override the large heading text (default: "VICTORY" / "DEFEAT"). */
  title?: string;
  /** Override the subtitle text. */
  subtitle?: string;
}

/**
 * Creates and shows a single-player game-over overlay with victory/defeat
 * result, rematch button, and exit button. Returns a cleanup function
 * that removes the overlay from the DOM.
 */
export function showSinglePlayerGameOver(opts: SinglePlayerGameOverOptions): () => void {
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: 500;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    background: rgba(0,0,0,0.6);
    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
    animation: sp-fade-in 0.5s ease both;
  `;

  const style = document.createElement('style');
  style.textContent = '@keyframes sp-fade-in { from { opacity: 0; } to { opacity: 1; } }';
  overlay.appendChild(style);

  const box = document.createElement('div');
  box.style.cssText = `
    background: rgba(10,12,20,0.95); border: 1px solid rgba(100,120,200,0.2);
    border-radius: 12px; padding: 40px 60px; text-align: center;
    box-shadow: 0 8px 40px rgba(0,0,0,0.6);
  `;

  const resultText = document.createElement('div');
  resultText.textContent = opts.title ?? (opts.won ? 'VICTORY' : 'DEFEAT');
  resultText.style.cssText = `
    font-size: 36px; font-weight: 900; letter-spacing: 6px;
    color: ${opts.won ? '#44cc66' : '#cc4444'};
    text-shadow: 0 0 20px ${opts.won ? 'rgba(60,200,100,0.4)' : 'rgba(200,60,60,0.4)'};
    margin-bottom: 8px;
  `;

  const subText = document.createElement('div');
  subText.textContent = opts.subtitle ?? (opts.won
    ? `You defeated ${opts.opponentName}!`
    : `${opts.opponentName} defeated you.`);
  subText.style.cssText = 'font-size: 14px; color: #aaa; margin-bottom: 28px;';

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display: flex; gap: 16px; justify-content: center;';

  const rematchBtn = document.createElement('button');
  rematchBtn.textContent = 'Rematch';
  rematchBtn.className = 'sp-btn';
  rematchBtn.style.cssText = `
    padding: 12px 32px; font-size: 15px; font-weight: 700;
    background: linear-gradient(135deg, rgba(200,120,30,0.8), rgba(180,80,20,0.9));
    color: #fff; border: 1px solid rgba(255,180,60,0.4);
    border-radius: 6px; cursor: pointer; outline: none;
  `;
  rematchBtn.addEventListener('click', () => {
    cleanup();
    opts.onRematch();
  });

  const exitBtn = document.createElement('button');
  exitBtn.textContent = 'Exit to Lobby';
  exitBtn.className = 'sp-btn';
  exitBtn.style.cssText = `
    padding: 12px 32px; font-size: 15px; font-weight: 600;
    background: rgba(60,60,80,0.7); color: #bbb;
    border: 1px solid rgba(100,100,140,0.3);
    border-radius: 6px; cursor: pointer; outline: none;
  `;
  exitBtn.addEventListener('click', () => {
    cleanup();
    opts.onExit();
  });

  btnRow.append(rematchBtn, exitBtn);
  box.append(resultText, subText, btnRow);
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  function cleanup(): void {
    overlay.remove();
  }

  return cleanup;
}

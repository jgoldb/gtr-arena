import { audioSettings } from './AudioSettings';

export class AudioSettingsDialog {
  private overlay: HTMLDivElement;
  private onClose?: () => void;

  constructor(onClose?: () => void) {
    this.onClose = onClose;

    this.overlay = document.createElement('div');
    this.overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 1100;
      display: flex; align-items: center; justify-content: center;
      background: rgba(0, 0, 0, 0.75);
      backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px);
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
    `;

    const dialog = document.createElement('div');
    dialog.style.cssText = `
      background: linear-gradient(to bottom, rgba(18,20,35,0.98), rgba(8,10,18,0.99));
      border: 1px solid rgba(100,120,200,0.15);
      border-radius: 10px; padding: 32px 40px; min-width: 340px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.5), 0 0 40px rgba(60,80,180,0.08);
    `;

    // Title
    const title = document.createElement('div');
    title.textContent = 'Audio Settings';
    title.style.cssText = `
      color: #ccc; font-size: 20px; font-weight: bold;
      margin-bottom: 24px; text-align: center;
    `;
    dialog.appendChild(title);

    // ── Master Volume ──
    const volLabel = document.createElement('div');
    volLabel.style.cssText = 'color: #aab; font-size: 13px; font-weight: bold; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 1px;';
    volLabel.textContent = 'Master Volume';
    dialog.appendChild(volLabel);

    const sliderRow = document.createElement('div');
    sliderRow.style.cssText = 'display: flex; align-items: center; gap: 12px; margin-bottom: 20px;';

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.value = String(Math.round(audioSettings.masterVolume * 100));
    slider.style.cssText = `
      flex: 1; height: 6px; -webkit-appearance: none; appearance: none;
      background: rgba(60, 80, 140, 0.4); border-radius: 3px; outline: none;
      cursor: pointer;
    `;
    // Style the thumb via a <style> tag
    const style = document.createElement('style');
    style.textContent = `
      .gtr-audio-slider::-webkit-slider-thumb {
        -webkit-appearance: none; appearance: none;
        width: 16px; height: 16px; border-radius: 50%;
        background: rgba(100, 140, 220, 0.9);
        border: 2px solid rgba(140, 170, 255, 0.5);
        cursor: pointer;
      }
      .gtr-audio-slider::-moz-range-thumb {
        width: 16px; height: 16px; border-radius: 50%;
        background: rgba(100, 140, 220, 0.9);
        border: 2px solid rgba(140, 170, 255, 0.5);
        cursor: pointer;
      }
    `;
    dialog.appendChild(style);
    slider.classList.add('gtr-audio-slider');

    const pctLabel = document.createElement('div');
    pctLabel.style.cssText = 'color: #99a; font-size: 13px; min-width: 36px; text-align: right;';
    pctLabel.textContent = slider.value + '%';

    slider.addEventListener('input', () => {
      const v = parseInt(slider.value, 10);
      pctLabel.textContent = v + '%';
      audioSettings.update({ masterVolume: v / 100 });
    });

    sliderRow.append(slider, pctLabel);
    dialog.appendChild(sliderRow);

    // ── Enable Music ──
    const musicRow = document.createElement('label');
    musicRow.style.cssText = `
      display: flex; align-items: center; gap: 10px;
      color: #bbc; font-size: 14px; cursor: pointer;
      margin-bottom: 28px; user-select: none;
    `;

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = audioSettings.enableMusic;
    checkbox.style.cssText = `
      width: 16px; height: 16px; cursor: pointer;
      accent-color: rgba(100, 140, 220, 0.9);
    `;
    checkbox.addEventListener('change', () => {
      audioSettings.update({ enableMusic: checkbox.checked });
    });

    const musicLabel = document.createElement('span');
    musicLabel.textContent = 'Enable Music';

    musicRow.append(checkbox, musicLabel);
    dialog.appendChild(musicRow);

    // ── Close button ──
    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'Close';
    closeBtn.style.cssText = `
      display: block; width: 100%;
      padding: 10px 24px; font-size: 14px;
      background: rgba(60, 60, 80, 0.8); color: #ddd;
      border: 1px solid rgba(100, 100, 160, 0.3); border-radius: 4px;
      cursor: pointer; outline: none; font-family: inherit;
    `;
    closeBtn.addEventListener('mouseenter', () => { closeBtn.style.background = 'rgba(80, 80, 100, 0.9)'; });
    closeBtn.addEventListener('mouseleave', () => { closeBtn.style.background = 'rgba(60, 60, 80, 0.8)'; });
    closeBtn.addEventListener('click', () => this.close());
    dialog.appendChild(closeBtn);

    this.overlay.appendChild(dialog);
    this.overlay.addEventListener('mousedown', (e) => {
      if (e.target === this.overlay) this.close();
    });
  }

  open(): void {
    document.body.appendChild(this.overlay);
  }

  close(): void {
    this.overlay.remove();
    this.onClose?.();
  }
}

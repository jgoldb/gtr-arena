import { audioSettings } from './AudioSettings';
import { keybindManager, matchesKeybindEvent } from './KeybindManager';

export class AudioSettingsDialog {
  private overlay: HTMLDivElement;
  private onClose?: () => void;
  private onKeyDown = (e: KeyboardEvent): void => {
    if (matchesKeybindEvent(keybindManager.getCode('toggle_game_menu'), e)) {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    }
  };

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
      margin-bottom: 20px; user-select: none;
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

    // ── Music Volume ──
    const musicVolLabel = document.createElement('div');
    musicVolLabel.style.cssText = 'color: #aab; font-size: 13px; font-weight: bold; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 1px;';
    musicVolLabel.textContent = 'Music Volume';
    dialog.appendChild(musicVolLabel);

    const musicSliderRow = document.createElement('div');
    musicSliderRow.style.cssText = 'display: flex; align-items: center; gap: 12px; margin-bottom: 20px;';

    const musicSlider = document.createElement('input');
    musicSlider.type = 'range';
    musicSlider.min = '0';
    musicSlider.max = '100';
    musicSlider.value = String(Math.round(audioSettings.musicVolume * 100));
    musicSlider.style.cssText = `
      flex: 1; height: 6px; -webkit-appearance: none; appearance: none;
      background: rgba(60, 80, 140, 0.4); border-radius: 3px; outline: none;
      cursor: pointer;
    `;
    musicSlider.classList.add('gtr-audio-slider');

    const musicPctLabel = document.createElement('div');
    musicPctLabel.style.cssText = 'color: #99a; font-size: 13px; min-width: 36px; text-align: right;';
    musicPctLabel.textContent = musicSlider.value + '%';

    musicSlider.addEventListener('input', () => {
      const v = parseInt(musicSlider.value, 10);
      musicPctLabel.textContent = v + '%';
      audioSettings.update({ musicVolume: v / 100 });
    });

    musicSliderRow.append(musicSlider, musicPctLabel);
    dialog.appendChild(musicSliderRow);

    // ── Enable Sound Effects ──
    const sfxRow = document.createElement('label');
    sfxRow.style.cssText = `
      display: flex; align-items: center; gap: 10px;
      color: #bbc; font-size: 14px; cursor: pointer;
      margin-bottom: 20px; user-select: none;
    `;

    const sfxCheckbox = document.createElement('input');
    sfxCheckbox.type = 'checkbox';
    sfxCheckbox.checked = audioSettings.enableSfx;
    sfxCheckbox.style.cssText = `
      width: 16px; height: 16px; cursor: pointer;
      accent-color: rgba(100, 140, 220, 0.9);
    `;
    sfxCheckbox.addEventListener('change', () => {
      audioSettings.update({ enableSfx: sfxCheckbox.checked });
    });

    const sfxLabel = document.createElement('span');
    sfxLabel.textContent = 'Enable Sound Effects';

    sfxRow.append(sfxCheckbox, sfxLabel);
    dialog.appendChild(sfxRow);

    // ── Sound Effects Volume ──
    const sfxVolLabel = document.createElement('div');
    sfxVolLabel.style.cssText = 'color: #aab; font-size: 13px; font-weight: bold; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 1px;';
    sfxVolLabel.textContent = 'Sound Effects Volume';
    dialog.appendChild(sfxVolLabel);

    const sfxSliderRow = document.createElement('div');
    sfxSliderRow.style.cssText = 'display: flex; align-items: center; gap: 12px; margin-bottom: 28px;';

    const sfxSlider = document.createElement('input');
    sfxSlider.type = 'range';
    sfxSlider.min = '0';
    sfxSlider.max = '100';
    sfxSlider.value = String(Math.round(audioSettings.sfxVolume * 100));
    sfxSlider.style.cssText = `
      flex: 1; height: 6px; -webkit-appearance: none; appearance: none;
      background: rgba(60, 80, 140, 0.4); border-radius: 3px; outline: none;
      cursor: pointer;
    `;
    sfxSlider.classList.add('gtr-audio-slider');

    const sfxPctLabel = document.createElement('div');
    sfxPctLabel.style.cssText = 'color: #99a; font-size: 13px; min-width: 36px; text-align: right;';
    sfxPctLabel.textContent = sfxSlider.value + '%';

    sfxSlider.addEventListener('input', () => {
      const v = parseInt(sfxSlider.value, 10);
      sfxPctLabel.textContent = v + '%';
      audioSettings.update({ sfxVolume: v / 100 });
    });

    sfxSliderRow.append(sfxSlider, sfxPctLabel);
    dialog.appendChild(sfxSliderRow);

    // ── Enable Ambient Sounds ──
    const ambientRow = document.createElement('label');
    ambientRow.style.cssText = `
      display: flex; align-items: center; gap: 10px;
      color: #bbc; font-size: 14px; cursor: pointer;
      margin-bottom: 20px; user-select: none;
    `;

    const ambientCheckbox = document.createElement('input');
    ambientCheckbox.type = 'checkbox';
    ambientCheckbox.checked = audioSettings.enableAmbient;
    ambientCheckbox.style.cssText = `
      width: 16px; height: 16px; cursor: pointer;
      accent-color: rgba(100, 140, 220, 0.9);
    `;
    ambientCheckbox.addEventListener('change', () => {
      audioSettings.update({ enableAmbient: ambientCheckbox.checked });
    });

    const ambientLabel = document.createElement('span');
    ambientLabel.textContent = 'Enable Ambient Sounds';

    ambientRow.append(ambientCheckbox, ambientLabel);
    dialog.appendChild(ambientRow);

    // ── Ambient Sound Volume ──
    const ambientVolLabel = document.createElement('div');
    ambientVolLabel.style.cssText = 'color: #aab; font-size: 13px; font-weight: bold; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 1px;';
    ambientVolLabel.textContent = 'Ambient Sound Volume';
    dialog.appendChild(ambientVolLabel);

    const ambientSliderRow = document.createElement('div');
    ambientSliderRow.style.cssText = 'display: flex; align-items: center; gap: 12px; margin-bottom: 28px;';

    const ambientSlider = document.createElement('input');
    ambientSlider.type = 'range';
    ambientSlider.min = '0';
    ambientSlider.max = '100';
    ambientSlider.value = String(Math.round(audioSettings.ambientVolume * 100));
    ambientSlider.style.cssText = `
      flex: 1; height: 6px; -webkit-appearance: none; appearance: none;
      background: rgba(60, 80, 140, 0.4); border-radius: 3px; outline: none;
      cursor: pointer;
    `;
    ambientSlider.classList.add('gtr-audio-slider');

    const ambientPctLabel = document.createElement('div');
    ambientPctLabel.style.cssText = 'color: #99a; font-size: 13px; min-width: 36px; text-align: right;';
    ambientPctLabel.textContent = ambientSlider.value + '%';

    ambientSlider.addEventListener('input', () => {
      const v = parseInt(ambientSlider.value, 10);
      ambientPctLabel.textContent = v + '%';
      audioSettings.update({ ambientVolume: v / 100 });
    });

    ambientSliderRow.append(ambientSlider, ambientPctLabel);
    dialog.appendChild(ambientSliderRow);

    // ── Play While Minimized ──
    const minimizedRow = document.createElement('label');
    minimizedRow.style.cssText = `
      display: flex; align-items: center; gap: 10px;
      color: #bbc; font-size: 14px; cursor: pointer;
      margin-bottom: 28px; user-select: none;
    `;

    const minimizedCheckbox = document.createElement('input');
    minimizedCheckbox.type = 'checkbox';
    minimizedCheckbox.checked = audioSettings.playWhileMinimized;
    minimizedCheckbox.style.cssText = `
      width: 16px; height: 16px; cursor: pointer;
      accent-color: rgba(100, 140, 220, 0.9);
    `;
    minimizedCheckbox.addEventListener('change', () => {
      audioSettings.update({ playWhileMinimized: minimizedCheckbox.checked });
    });

    const minimizedLabel = document.createElement('span');
    minimizedLabel.textContent = 'Play Audio While Minimized';

    minimizedRow.append(minimizedCheckbox, minimizedLabel);
    dialog.appendChild(minimizedRow);

    // ── Button row ──
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display: flex; gap: 10px;';

    const resetBtn = document.createElement('button');
    resetBtn.textContent = 'Reset';
    resetBtn.style.cssText = `
      flex: 1; padding: 10px 24px; font-size: 14px;
      background: rgba(120, 50, 50, 0.8); color: #ddd;
      border: 1px solid rgba(160, 80, 80, 0.3); border-radius: 4px;
      cursor: pointer; outline: none; font-family: inherit;
    `;
    resetBtn.addEventListener('mouseenter', () => { resetBtn.style.background = 'rgba(140, 60, 60, 0.9)'; });
    resetBtn.addEventListener('mouseleave', () => { resetBtn.style.background = 'rgba(120, 50, 50, 0.8)'; });
    resetBtn.addEventListener('click', () => {
      audioSettings.reset();
      slider.value = String(Math.round(audioSettings.masterVolume * 100));
      pctLabel.textContent = slider.value + '%';
      checkbox.checked = audioSettings.enableMusic;
      musicSlider.value = String(Math.round(audioSettings.musicVolume * 100));
      musicPctLabel.textContent = musicSlider.value + '%';
      sfxCheckbox.checked = audioSettings.enableSfx;
      sfxSlider.value = String(Math.round(audioSettings.sfxVolume * 100));
      sfxPctLabel.textContent = sfxSlider.value + '%';
      ambientCheckbox.checked = audioSettings.enableAmbient;
      ambientSlider.value = String(Math.round(audioSettings.ambientVolume * 100));
      ambientPctLabel.textContent = ambientSlider.value + '%';
      minimizedCheckbox.checked = audioSettings.playWhileMinimized;
    });

    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'Close';
    closeBtn.style.cssText = `
      flex: 1; padding: 10px 24px; font-size: 14px;
      background: rgba(60, 60, 80, 0.8); color: #ddd;
      border: 1px solid rgba(100, 100, 160, 0.3); border-radius: 4px;
      cursor: pointer; outline: none; font-family: inherit;
    `;
    closeBtn.addEventListener('mouseenter', () => { closeBtn.style.background = 'rgba(80, 80, 100, 0.9)'; });
    closeBtn.addEventListener('mouseleave', () => { closeBtn.style.background = 'rgba(60, 60, 80, 0.8)'; });
    closeBtn.addEventListener('click', () => this.close());

    btnRow.append(resetBtn, closeBtn);
    dialog.appendChild(btnRow);

    this.overlay.appendChild(dialog);
    this.overlay.addEventListener('mousedown', (e) => {
      if (e.target === this.overlay) this.close();
    });
  }

  open(): void {
    document.body.appendChild(this.overlay);
    document.addEventListener('keydown', this.onKeyDown, true);
  }

  close(): void {
    document.removeEventListener('keydown', this.onKeyDown, true);
    this.overlay.remove();
    this.onClose?.();
  }
}

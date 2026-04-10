/**
 * Central keybind manager with localStorage persistence.
 *
 * Every rebindable action has:
 *  - id:          stable identifier (e.g. "move_forward")
 *  - label:       human-readable label shown in the menu
 *  - defaultCode: KeyboardEvent.code shipped with the game
 *  - code:        current KeyboardEvent.code (user-overridden or default)
 */

export interface KeybindEntry {
  id: string;
  label: string;
  category: string;
  defaultCode: string;
  code: string;
}

const STORAGE_KEY = 'gtr_keybinds';

/** Default keybind definitions — order here = order in the UI */
const DEFAULT_BINDS: { id: string; label: string; category: string; code: string }[] = [
  // Movement
  { id: 'move_forward', label: 'Run Forward', category: 'Movement', code: 'KeyW' },
  { id: 'move_left', label: 'Strafe Left', category: 'Movement', code: 'KeyA' },
  { id: 'move_backward', label: 'Backpedal', category: 'Movement', code: 'KeyS' },
  { id: 'move_right', label: 'Strafe Right', category: 'Movement', code: 'KeyD' },
  { id: 'turn_left', label: 'Turn Left', category: 'Movement', code: 'ArrowLeft' },
  { id: 'turn_right', label: 'Turn Right', category: 'Movement', code: 'ArrowRight' },
  { id: 'jump', label: 'Jump', category: 'Movement', code: 'Space' },
  { id: 'rest', label: 'Rest', category: 'Movement', code: 'KeyR' },
  // Action bar slots
  { id: 'action_0', label: 'Action Bar 0', category: 'Action Bar', code: 'Backquote' },
  { id: 'action_1', label: 'Action Bar 1', category: 'Action Bar', code: 'Digit1' },
  { id: 'action_2', label: 'Action Bar 2', category: 'Action Bar', code: 'Digit2' },
  { id: 'action_3', label: 'Action Bar 3', category: 'Action Bar', code: 'Digit3' },
  { id: 'action_4', label: 'Action Bar 4', category: 'Action Bar', code: 'Digit4' },
  { id: 'action_5', label: 'Action Bar 5', category: 'Action Bar', code: 'Digit5' },
  { id: 'action_6', label: 'Action Bar 6', category: 'Action Bar', code: 'Digit6' },
  { id: 'action_7', label: 'Action Bar 7', category: 'Action Bar', code: 'KeyQ' },
  { id: 'action_8', label: 'Action Bar 8', category: 'Action Bar', code: 'KeyE' },
  { id: 'action_9', label: 'Action Bar 9', category: 'Action Bar', code: 'KeyV' },
  { id: 'action_10', label: 'Action Bar 10', category: 'Action Bar', code: 'KeyT' },
  { id: 'action_11', label: 'Action Bar 11', category: 'Action Bar', code: 'KeyY' },
  // Targeting
  { id: 'target_nearest_enemy', label: 'Target Nearest Enemy', category: 'Targeting', code: 'Tab' },
  { id: 'target_of_target', label: 'Assist Target', category: 'Targeting', code: 'KeyF' },
  // Interface
  { id: 'toggle_hud', label: 'Toggle HUD', category: 'Interface', code: 'KeyL' },
  { id: 'toggle_game_menu', label: 'Game Menu', category: 'Interface', code: 'Escape' },
];

// ---- Combo helpers ----

/** Parse a bind string like "Shift+Ctrl+Digit1" into its parts */
export function parseCombo(bindCode: string): { shift: boolean; ctrl: boolean; alt: boolean; baseCode: string } {
  const parts = bindCode.split('+');
  const baseCode = parts[parts.length - 1];
  return {
    shift: parts.includes('Shift'),
    ctrl: parts.includes('Ctrl'),
    alt: parts.includes('Alt'),
    baseCode,
  };
}

/** Build a combo string from a KeyboardEvent (e.g. Shift held + Digit1 → "Shift+Digit1") */
export function buildComboString(e: KeyboardEvent): string {
  let combo = '';
  if (e.shiftKey) combo += 'Shift+';
  if (e.ctrlKey) combo += 'Ctrl+';
  if (e.altKey) combo += 'Alt+';
  combo += e.code;
  return combo;
}

/** Check if a KeyboardEvent matches a bind string (exact modifier matching) */
export function matchesKeybindEvent(bindCode: string, e: KeyboardEvent): boolean {
  if (!bindCode) return false;
  const { shift, ctrl, alt, baseCode } = parseCombo(bindCode);
  return e.code === baseCode && e.shiftKey === shift && e.ctrlKey === ctrl && e.altKey === alt;
}

/** Friendly display name for a single KeyboardEvent.code */
function baseCodeToLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'Num' + code.slice(6);
  const map: Record<string, string> = {
    Space: 'Space',
    ShiftLeft: 'LShift',
    ShiftRight: 'RShift',
    ControlLeft: 'LCtrl',
    ControlRight: 'RCtrl',
    AltLeft: 'LAlt',
    AltRight: 'RAlt',
    Escape: 'Esc',
    Tab: 'Tab',
    CapsLock: 'Caps',
    Backquote: '`',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
  };
  return map[code] ?? code;
}

/** Friendly display name for a bind string (handles combos like "Shift+Digit1" → "Shift+1") */
export function codeToDisplayLabel(code: string): string {
  if (!code) return '';
  const { shift, ctrl, alt, baseCode } = parseCombo(code);
  let label = '';
  if (shift) label += 'Shift+';
  if (ctrl) label += 'Ctrl+';
  if (alt) label += 'Alt+';
  label += baseCodeToLabel(baseCode);
  return label;
}

export class KeybindManager {
  private binds: Map<string, KeybindEntry> = new Map();
  private listeners: Set<() => void> = new Set();

  constructor() {
    // Initialise from defaults
    for (const def of DEFAULT_BINDS) {
      this.binds.set(def.id, {
        id: def.id,
        label: def.label,
        category: def.category,
        defaultCode: def.code,
        code: def.code,
      });
    }
    // Apply saved overrides
    this.load();
  }

  /** Get the current KeyboardEvent.code for an action */
  getCode(actionId: string): string {
    return this.binds.get(actionId)?.code ?? '';
  }

  /** Get display label for the current binding */
  getDisplayLabel(actionId: string): string {
    const code = this.getCode(actionId);
    return codeToDisplayLabel(code);
  }

  /** Get all entries (in definition order) */
  getAll(): KeybindEntry[] {
    return Array.from(this.binds.values());
  }

  /** Rebind an action in memory. If the new code is already used by another action, swap them. Pass '' to unbind. Does NOT persist — call save() explicitly. */
  rebind(actionId: string, newCode: string): void {
    const entry = this.binds.get(actionId);
    if (!entry) return;

    // Swap only when binding to a real key (not when unbinding)
    if (newCode) {
      for (const other of this.binds.values()) {
        if (other.id !== actionId && other.code === newCode) {
          other.code = entry.code;
          break;
        }
      }
    }

    entry.code = newCode;
    this.notifyListeners();
  }

  /** Reset all to defaults in memory. Does NOT persist — call save() explicitly. */
  resetAll(): void {
    for (const entry of this.binds.values()) {
      entry.code = entry.defaultCode;
    }
    this.notifyListeners();
  }

  /** Take a snapshot of current binds (call before opening the editor) */
  snapshot(): Map<string, string> {
    const snap = new Map<string, string>();
    for (const entry of this.binds.values()) {
      snap.set(entry.id, entry.code);
    }
    return snap;
  }

  /** Restore binds from a snapshot (call to cancel edits) */
  restore(snap: Map<string, string>): void {
    for (const entry of this.binds.values()) {
      const code = snap.get(entry.id);
      if (code !== undefined) entry.code = code;
    }
    this.notifyListeners();
  }

  /** Subscribe to changes */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Get set of all currently bound base codes (for InputManager preventDefault) */
  getAllBoundCodes(): Set<string> {
    const codes = new Set<string>();
    for (const entry of this.binds.values()) {
      if (entry.code) codes.add(parseCombo(entry.code).baseCode);
    }
    // Always include modifier & utility keys regardless of binding
    codes.add('ShiftLeft');
    codes.add('ShiftRight');
    codes.add('ControlLeft');
    codes.add('ControlRight');
    codes.add('AltLeft');
    codes.add('AltRight');
    return codes;
  }

  /** Export current binds as a JSON string (all binds, not just overrides) */
  exportString(): string {
    const obj: Record<string, string> = {};
    for (const entry of this.binds.values()) {
      obj[entry.id] = entry.code;
    }
    return JSON.stringify(obj);
  }

  /** Import binds from a JSON string. Unknown keys are ignored, missing keys keep current value. Does NOT persist — call save() explicitly. */
  importString(raw: string): void {
    const obj = JSON.parse(raw) as Record<string, string>;
    for (const [id, code] of Object.entries(obj)) {
      const entry = this.binds.get(id);
      if (entry && typeof code === 'string') {
        entry.code = code;
      }
    }
    this.notifyListeners();
  }

  // --- persistence ---

  /** Persist current binds to localStorage */
  save(): void {
    const overrides: Record<string, string> = {};
    for (const entry of this.binds.values()) {
      if (entry.code !== entry.defaultCode) {
        overrides[entry.id] = entry.code;
      }
    }
    if (Object.keys(overrides).length === 0) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
    }
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const overrides = JSON.parse(raw) as Record<string, string>;
      for (const [id, code] of Object.entries(overrides)) {
        const entry = this.binds.get(id);
        if (entry && typeof code === 'string') {
          entry.code = code;
        }
      }

      // Unbind new actions whose defaults conflict with existing binds.
      // A "new" action is one the user has never touched (no saved override).
      const boundCodes = new Set<string>();
      for (const entry of this.binds.values()) {
        if (entry.id in overrides && entry.code) boundCodes.add(entry.code);
      }
      for (const entry of this.binds.values()) {
        if (!(entry.id in overrides) && entry.code && boundCodes.has(entry.code)) {
          entry.code = '';
        }
      }
    } catch {
      // corrupt data, ignore
    }
  }

  private notifyListeners(): void {
    for (const fn of this.listeners) fn();
  }
}

/** Singleton — created once, shared across engine + UI */
export const keybindManager = new KeybindManager();

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
  defaultCode: string;
  code: string;
}

const STORAGE_KEY = 'gtr_keybinds';

/** Default keybind definitions — order here = order in the UI */
const DEFAULT_BINDS: { id: string; label: string; code: string }[] = [
  // Movement
  { id: 'move_forward', label: 'Move Forward', code: 'KeyW' },
  { id: 'move_left', label: 'Move Left', code: 'KeyA' },
  { id: 'move_backward', label: 'Move Backward', code: 'KeyS' },
  { id: 'move_right', label: 'Move Right', code: 'KeyD' },
  // Action bar slots
  { id: 'action_1', label: 'Action Bar 1', code: 'Digit1' },
  { id: 'action_2', label: 'Action Bar 2', code: 'Digit2' },
  { id: 'action_3', label: 'Action Bar 3', code: 'Digit3' },
  { id: 'action_4', label: 'Action Bar 4', code: 'Digit4' },
  { id: 'action_5', label: 'Action Bar 5', code: 'Digit5' },
  { id: 'action_6', label: 'Action Bar 6', code: 'Digit6' },
  { id: 'action_7', label: 'Action Bar 7', code: 'KeyQ' },
  { id: 'action_8', label: 'Action Bar 8', code: 'KeyE' },
  // Utility
  { id: 'rest', label: 'Rest', code: 'KeyR' },
  { id: 'target_of_target', label: 'Target of Target', code: 'KeyF' },
  { id: 'toggle_hud', label: 'HUD', code: 'KeyL' },
];

/** Friendly display name for a KeyboardEvent.code */
export function codeToDisplayLabel(code: string): string {
  // Letters
  if (code.startsWith('Key')) return code.slice(3);
  // Digits
  if (code.startsWith('Digit')) return code.slice(5);
  // Numpad
  if (code.startsWith('Numpad')) return 'Num' + code.slice(6);
  // Special keys
  const map: Record<string, string> = {
    Space: 'Space',
    ShiftLeft: 'LShift',
    ShiftRight: 'RShift',
    ControlLeft: 'LCtrl',
    ControlRight: 'RCtrl',
    AltLeft: 'LAlt',
    AltRight: 'RAlt',
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

export class KeybindManager {
  private binds: Map<string, KeybindEntry> = new Map();
  private listeners: Set<() => void> = new Set();

  constructor() {
    // Initialise from defaults
    for (const def of DEFAULT_BINDS) {
      this.binds.set(def.id, {
        id: def.id,
        label: def.label,
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

  /** Rebind an action in memory. If the new code is already used by another action, swap them. Does NOT persist — call save() explicitly. */
  rebind(actionId: string, newCode: string): void {
    const entry = this.binds.get(actionId);
    if (!entry) return;

    // Find any existing action using this code and swap
    for (const other of this.binds.values()) {
      if (other.id !== actionId && other.code === newCode) {
        other.code = entry.code;
        break;
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

  /** Get set of all currently bound codes (for InputManager preventDefault) */
  getAllBoundCodes(): Set<string> {
    const codes = new Set<string>();
    for (const entry of this.binds.values()) {
      codes.add(entry.code);
    }
    // Always include these regardless of binding
    codes.add('Space');
    codes.add('ShiftLeft');
    codes.add('ShiftRight');
    codes.add('Tab');
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

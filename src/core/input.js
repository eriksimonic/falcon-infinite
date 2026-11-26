// Keyboard + mouse input. Edge triggers are consumed once per frame.
const PREVENT = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Tab',
  'BracketLeft', 'BracketRight',
]);

export class Input {
  constructor() {
    this.down = new Set();
    this.pressed = new Set();
    this.released = new Set();
    this.mouse = { buttons: 0, dx: 0, dy: 0, wheel: 0, x: 0, y: 0 };
    this.pointerLocked = false;
    this.captured = null;
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onMouseDown = this._onMouseDown.bind(this);
    this._onMouseUp = this._onMouseUp.bind(this);
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onWheel = this._onWheel.bind(this);
    this._onBlur = this._onBlur.bind(this);
    this._onLockChange = this._onLockChange.bind(this);
  }

  attach(canvas) {
    this.canvas = canvas;
    window.addEventListener('keydown', this._onKeyDown, { passive: false });
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
    canvas.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);
    window.addEventListener('mousemove', this._onMouseMove);
    canvas.addEventListener('wheel', this._onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', this._onLockChange);
  }

  _onKeyDown(e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    const code = e.code;
    if (PREVENT.has(code)) e.preventDefault();
    if (!e.repeat) {
      if (!this.down.has(code)) this.pressed.add(code);
      if (this.onKey) this.onKey(code, e);
    }
    this.down.add(code);
  }

  _onKeyUp(e) {
    const code = e.code;
    this.down.delete(code);
    this.released.add(code);
  }

  _onMouseDown(e) {
    this.mouse.buttons |= 1 << e.button;
    if (e.button === 0 && this.captured) {
      this.captured.focus?.();
      this.requestPointerLock();
    }
    if (e.button === 2) e.preventDefault();
  }

  _onMouseUp(e) {
    this.mouse.buttons &= ~(1 << e.button);
  }

  _onMouseMove(e) {
    this.mouse.x = e.clientX;
    this.mouse.y = e.clientY;
    if (this.pointerLocked) {
      this.mouse.dx += e.movementX || 0;
      this.mouse.dy += e.movementY || 0;
    } else if (this.mouse.buttons & (1 << 0)) {
      // drag-to-look also works when pointer lock is off (external views)
      this.mouse.dx += e.movementX || 0;
      this.mouse.dy += e.movementY || 0;
    }
  }

  _onWheel(e) {
    e.preventDefault();
    this.mouse.wheel += Math.sign(e.deltaY);
  }

  _onBlur() {
    this.down.clear();
    this.mouse.buttons = 0;
  }

  _onLockChange() {
    this.pointerLocked = document.pointerLockElement === this.canvas;
    if (!this.pointerLocked) {
      this.mouse.dx = 0;
      this.mouse.dy = 0;
    }
  }

  requestPointerLock() {
    if (!this.canvas) return;
    if (document.pointerLockElement !== this.canvas) {
      const p = this.canvas.requestPointerLock?.();
      if (p && p.catch) p.catch(() => {});
    }
  }

  releasePointerLock() {
    if (document.pointerLockElement === this.canvas) document.exitPointerLock?.();
  }

  isDown(code) {
    return this.down.has(code);
  }

  anyDown(...codes) {
    for (const c of codes) if (this.down.has(c)) return true;
    return false;
  }

  wasPressed(code) {
    return this.pressed.has(code);
  }

  /** Called at the end of every frame. */
  endFrame() {
    this.pressed.clear();
    this.released.clear();
    this.mouse.dx = 0;
    this.mouse.dy = 0;
    this.mouse.wheel = 0;
    this.mouse.buttons = this.mouse.buttons; // buttons persist until mouseup
  }
}

/** Axis helper: -1 / 0 / 1 from two keys. */
export function axis(neg, pos) {
  return (pos ? 1 : 0) - (neg ? 1 : 0);
}
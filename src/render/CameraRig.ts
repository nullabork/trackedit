import { PerspectiveCamera, Vector3 } from "three";

/**
 * Blender-ish camera controls plus free-fly:
 *
 * - middle-drag: orbit around the focus point (a point `distance` ahead)
 * - shift+middle-drag: pan
 * - alt+wheel: slide the camera along its view vector (fast dolly)
 * - ctrl+wheel: raise/lower the camera straight along world Y (global
 *   ground normal — independent of any layer tilt or view direction)
 * - hold right mouse: fly mode — pointer-locked mouselook (rotates in place,
 *   FPS style), WASD to move, Space/C up/down, steady medium pace with
 *   Ctrl as sneak (slow) and Shift as sprint
 *
 * Plain wheel is deliberately left to the tools layer (build level), and the
 * left button always belongs to the editor tools.
 */
export class CameraRig {
  /** True while right-mouse fly mode is engaged; tools ignore keys then. */
  isFlying = false;
  /** Set while a modal operator owns the mouse — rig ignores its own inputs. */
  suspended = false;
  flySpeed = 250; // metres per second

  private pos = new Vector3();
  private yaw = 0;
  private pitch = -0.5;
  /** Orbit/dolly pivot distance along the view direction. */
  private distance = 900;
  private keys = new Set<string>();
  private panning = false;
  private orbiting = false;
  /** Fly entered via the F toggle (no RMB held) — exits on F or any click. */
  private toggledFly = false;
  /** RMB is down but fly hasn't engaged yet (waits for actual movement). */
  private rmbPending: { x: number; y: number } | null = null;

  constructor(
    private camera: PerspectiveCamera,
    private dom: HTMLElement,
  ) {
    dom.addEventListener("pointerdown", (e) => {
      if (this.suspended) return;
      if (this.toggledFly) {
        // Any click lands the toggled fly.
        e.preventDefault();
        this.toggleFly();
        return;
      }
      if (e.button === 1) {
        e.preventDefault();
        if (e.shiftKey) this.panning = true;
        else this.orbiting = true;
        dom.setPointerCapture(e.pointerId);
      } else if (e.button === 2) {
        e.preventDefault();
        // Don't engage fly yet: a quick right CLICK belongs to the active
        // tool (e.g. rotate-while-placing). Fly starts on actual movement.
        this.rmbPending = { x: e.clientX, y: e.clientY };
      }
    });

    dom.addEventListener("pointermove", (e) => {
      if (this.rmbPending && !this.isFlying && !this.suspended) {
        const moved = Math.hypot(e.clientX - this.rmbPending.x, e.clientY - this.rmbPending.y);
        if (moved > 4) {
          this.isFlying = true;
          dom.requestPointerLock();
        }
      }
      if (this.isFlying) {
        // Rotate in place. Mouse up = look up (standard FPS, not inverted).
        this.yaw -= e.movementX * 0.0024;
        this.addPitch(-e.movementY * 0.0024);
      } else if (this.orbiting) {
        // Rotate around the focus point.
        const focus = this.focusPoint();
        this.yaw -= e.movementX * 0.005;
        this.addPitch(-e.movementY * 0.005);
        this.pos.copy(focus).addScaledVector(this.forwardVec(), -this.distance);
      } else if (this.panning) {
        const scale = this.distance * 0.0012;
        this.pos.addScaledVector(this.rightVec(), -e.movementX * scale);
        this.pos.addScaledVector(this.upVec(), e.movementY * scale);
      }
    });

    const stop = (e: PointerEvent) => {
      if (e.button === 1) this.panning = this.orbiting = false;
      if (e.button === 2) {
        this.rmbPending = null;
        if (this.isFlying && !this.toggledFly) {
          this.isFlying = false;
          document.exitPointerLock();
        }
      }
    };
    dom.addEventListener("pointerup", stop);
    dom.addEventListener("pointercancel", stop);
    document.addEventListener("pointerlockchange", () => {
      if (!document.pointerLockElement && this.isFlying) {
        this.isFlying = false;
        this.toggledFly = false;
      }
    });

    dom.addEventListener(
      "wheel",
      (e) => {
        if (this.suspended) return;
        if (e.ctrlKey) {
          // Straight world-Y elevator (also blocks the browser's ctrl+wheel
          // page zoom). Scroll up = rise.
          e.preventDefault();
          const step = Math.max(24, this.distance * 0.1);
          this.pos.y -= Math.sign(e.deltaY) * step;
          return;
        }
        if (!e.altKey) return; // plain wheel belongs to the tools layer
        e.preventDefault();
        const step = Math.max(48, this.distance * 0.2);
        this.pos.addScaledVector(this.forwardVec(), -Math.sign(e.deltaY) * step);
      },
      { passive: false },
    );

    const typing = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      return !!t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA");
    };
    window.addEventListener("keydown", (e) => {
      if (!typing(e)) this.keys.add(e.code);
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    window.addEventListener("blur", () => this.keys.clear());
    document.addEventListener("focusin", () => this.keys.clear());
  }

  /** Snapshot of the camera position, for modal camera moves. */
  getPosition(): Vector3 {
    return this.pos.clone();
  }

  setPosition(p: Vector3): void {
    this.pos.copy(p);
  }

  /** How far ahead the orbit focus sits — used to scale mouse deltas. */
  get focusDistance(): number {
    return this.distance;
  }

  /** Full pose for persistence (survives page reloads). */
  getState(): { pos: [number, number, number]; yaw: number; pitch: number; distance: number } {
    return {
      pos: [this.pos.x, this.pos.y, this.pos.z],
      yaw: this.yaw,
      pitch: this.pitch,
      distance: this.distance,
    };
  }

  setState(s: { pos: [number, number, number]; yaw: number; pitch: number; distance?: number }): void {
    this.pos.set(s.pos[0], s.pos[1], s.pos[2]);
    this.yaw = s.yaw;
    this.pitch = s.pitch;
    if (s.distance) this.distance = s.distance;
  }

  /** Hands-free fly (F): mouselook + WASD without holding RMB; F or a click exits. */
  toggleFly(): void {
    if (this.isFlying) {
      this.isFlying = false;
      this.toggledFly = false;
      document.exitPointerLock();
    } else {
      this.isFlying = true;
      this.toggledFly = true;
      this.dom.requestPointerLock();
    }
  }

  lookAt(focus: Vector3, distance: number, yaw = 0.7, pitch = -0.55): void {
    this.yaw = yaw;
    this.pitch = pitch;
    this.distance = distance;
    this.pos.copy(focus).addScaledVector(this.forwardVec(), -distance);
  }

  /** Drop a movement key another system consumed (e.g. `c` starting a camera sequence). */
  clearKey(code: string): void {
    this.keys.delete(code);
  }

  /** Advance fly movement and write the camera transform. Call once per frame. */
  update(dt: number): void {
    // Flight movement keys are ALWAYS live (nothing else binds WASD/Space/C);
    // only mouselook needs fly mode (F toggle or RMB hold).
    if (!this.suspended) {
      // Steady medium pace; Ctrl sneaks, Shift sprints.
      const pace = this.ctrl() ? 0.2 : this.shift() ? 3 : 1;
      const speed = this.flySpeed * pace * dt;
      const move = new Vector3();
      if (this.keys.has("KeyW")) move.add(this.forwardVec());
      if (this.keys.has("KeyS")) move.sub(this.forwardVec());
      if (this.keys.has("KeyD")) move.add(this.rightVec());
      if (this.keys.has("KeyA")) move.sub(this.rightVec());
      if (this.keys.has("Space")) move.y += 1;
      if (this.keys.has("KeyC")) move.y -= 1;
      if (move.lengthSq() > 0) this.pos.addScaledVector(move.normalize(), speed);
    }

    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.focusPoint());
  }

  private focusPoint(): Vector3 {
    return this.pos.clone().addScaledVector(this.forwardVec(), this.distance);
  }

  private shift(): boolean {
    return this.keys.has("ShiftLeft") || this.keys.has("ShiftRight");
  }

  private ctrl(): boolean {
    return this.keys.has("ControlLeft") || this.keys.has("ControlRight");
  }

  private addPitch(d: number): void {
    this.pitch = Math.min(Math.max(this.pitch + d, -1.55), 1.55);
  }

  private forwardVec(): Vector3 {
    return new Vector3(
      Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      Math.cos(this.yaw) * Math.cos(this.pitch),
    );
  }

  /** Screen-right. For forward (sin y, 0, cos y) that is (-cos y, 0, sin y). */
  private rightVec(): Vector3 {
    return new Vector3(-Math.cos(this.yaw), 0, Math.sin(this.yaw));
  }

  private upVec(): Vector3 {
    return this.rightVec().cross(this.forwardVec());
  }
}

import { PerspectiveCamera, Quaternion, Vector3 } from "three";

import { ControlPreferences, blocksEditorInput, dragAction, wheelAction } from "@input/ControlScheme";

/** Camera navigation driven by the active control preset. */
export class CameraRig {
  readonly controls = new ControlPreferences();
  private zooming = false;
  private dragButton: number | null = null;

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
  /** Fly entered via a keyboard toggle; a click lands it. */
  private toggledFly = false;
  /**
   * Following a moving target (a driving line's car, see plugins/ghostPlayer): the camera
   * sits relative to the target's HEADING, so it turns with the car. Dragging orbits around
   * the target and the wheel zooms — both keep following. Anything that moves the camera
   * AWAY (pan, fly, WASD) ends it and calls `onFollowEnded`.
   */
  private following: { target: Vector3; heading: number; pitch: number; firstPerson: boolean; attitude: Quaternion | null } | null = null;
  /** Camera yaw relative to the target's heading; 0 = straight behind it. */
  private relYaw = 0;
  onFollowEnded: (() => void) | null = null;
  /** RMB is down but fly hasn't engaged yet (waits for actual movement). */
  private rmbPending: { x: number; y: number } | null = null;

  constructor(
    private camera: PerspectiveCamera,
    private dom: HTMLElement,
  ) {
    this.controls.events.on("changed", () => this.resetInput());
    dom.addEventListener("pointerdown", (e) => {
      if (this.suspended) return;
      if (this.toggledFly) {
        // Any click lands the toggled fly.
        e.preventDefault();
        this.toggleFly();
        e.stopImmediatePropagation();
        return;
      }
      const action = dragAction(this.controls.id, e);
      if (action === "fly") {
        e.preventDefault();
        this.rmbPending = { x: e.clientX, y: e.clientY };
      } else if (action) {
        e.preventDefault();
        this.dragButton = e.button;
        this.panning = action === "pan";
        this.orbiting = action === "orbit";
        this.zooming = action === "zoom";
        dom.setPointerCapture(e.pointerId);
      }
    });

    dom.addEventListener("pointermove", (e) => {
      if (this.suspended) return;
      if (this.rmbPending && !this.isFlying && !this.suspended) {
        const moved = Math.hypot(e.clientX - this.rmbPending.x, e.clientY - this.rmbPending.y);
        if (moved > 4) {
          this.endFollow();
          this.isFlying = true;
          dom.requestPointerLock();
        }
      }
      if (this.isFlying) {
        // Rotate in place. Mouse up = look up (standard FPS, not inverted).
        this.yaw -= e.movementX * 0.0024;
        this.addPitch(-e.movementY * 0.0024);
      } else if (this.orbiting && this.following) {
        // Around the car: the angle is kept relative to where it is heading.
        this.relYaw -= e.movementX * 0.005;
        this.addPitch(-e.movementY * 0.005);
      } else if (this.orbiting) {
        // Rotate around the focus point.
        const focus = this.focusPoint();
        this.yaw -= e.movementX * 0.005;
        this.addPitch(-e.movementY * 0.005);
        this.pos.copy(focus).addScaledVector(this.forwardVec(), -this.distance);
      } else if (this.zooming) {
        this.zoom(e.movementY * 0.01);
      } else if (this.panning) {
        this.endFollow();
        const scale = this.distance * 0.0012;
        this.pos.addScaledVector(this.rightVec(), -e.movementX * scale);
        this.pos.addScaledVector(this.upVec(), e.movementY * scale);
      }
    });

    const stop = (e: PointerEvent) => {
      if (e.button === this.dragButton) {
        this.panning = this.orbiting = this.zooming = false;
        this.dragButton = null;
      }
      if (e.button === 2) {
        this.rmbPending = null;
        if (this.isFlying && !this.toggledFly) {
          this.isFlying = false;
          document.exitPointerLock();
        }
      }
    };
    dom.addEventListener("pointerup", stop);
    dom.addEventListener("pointercancel", () => this.resetInput());
    dom.addEventListener("lostpointercapture", () => {
      this.panning = this.orbiting = this.zooming = false;
      this.dragButton = null;
    });
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
        const action = wheelAction(this.controls.id, e);
        if (action === "height") return;
        e.preventDefault();
        if (action === "zoom" || this.following) {
          // While following, every wheel gesture is distance to the car.
          this.zoom(Math.sign(e.deltaY) * 0.15);
          return;
        }
        if (action === "elevate") {
          // Straight world-Y elevator (also blocks the browser's ctrl+wheel
          // page zoom). Scroll up = rise.
          e.preventDefault();
          const step = Math.max(24, this.distance * 0.1);
          this.pos.y -= Math.sign(e.deltaY) * step;
          return;
        }
        e.preventDefault();
        const step = Math.max(48, this.distance * 0.2);
        this.pos.addScaledVector(this.forwardVec(), -Math.sign(e.deltaY) * step);
      },
      { passive: false },
    );

    window.addEventListener("keydown", (e) => {
      if (!blocksEditorInput(e.target)) this.keys.add(e.code);
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    window.addEventListener("blur", () => this.resetInput());
    document.addEventListener("focusin", () => this.keys.clear());
  }

  get isNavigating(): boolean {
    return this.isFlying || this.dragButton !== null;
  }

  resetInput(): void {
    this.keys.clear();
    this.panning = this.orbiting = this.zooming = false;
    this.dragButton = null;
    this.rmbPending = null;
    this.isFlying = this.toggledFly = false;
    if (document.pointerLockElement === this.dom) document.exitPointerLock();
  }

  /**
   * Follow `target`. `heading` and `pitch` are where its nose points (yaw about +y, and up
   * from the horizon); `attitude` its full orientation when known. The chase camera uses
   * heading and pitch but never the roll — a banked turn should not tip the horizon — while
   * first person rides IN the car and takes all three. Call every frame while following;
   * the first call snaps the camera behind the target.
   */
  follow(target: Vector3, heading: number, pitch: number, firstPerson: boolean, attitude: Quaternion | null = null): void {
    if (!this.following) {
      // Chase-camera close: the editor's own distance is usually hundreds of metres.
      this.relYaw = 0;
      this.pitch = -0.28;
      this.distance = 18;
      this.following = { target: target.clone(), heading, pitch, firstPerson, attitude: attitude?.clone() ?? null };
    } else {
      if (firstPerson !== this.following.firstPerson) { this.relYaw = 0; this.pitch = firstPerson ? -0.05 : -0.35; }
      this.following.target.copy(target);
      // The heading eases in: a 20 Hz path turned into a direction is never quite steady.
      let d = heading - this.following.heading;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.following.heading += d * 0.2;
      this.following.pitch += (pitch - this.following.pitch) * 0.2;
      this.following.firstPerson = firstPerson;
      if (attitude && this.following.attitude) this.following.attitude.slerp(attitude, 0.35);
      else this.following.attitude = attitude?.clone() ?? null;
    }
  }

  endFollow(): void {
    if (!this.following) return;
    this.following = null;
    this.onFollowEnded?.();
  }

  get isFollowing(): boolean {
    return this.following !== null;
  }

  /** Dolly towards a fixed orbit pivot, without passing through it. */
  private zoom(amount: number): void {
    const next = Math.min(100000, Math.max(this.following ? 4 : 1, this.distance * Math.exp(amount)));
    this.pos.addScaledVector(this.forwardVec(), this.distance - next);
    this.distance = next;
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

  /** Toggle mouselook and WASD flight using the preset shortcut. */
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
    if (!this.suspended && !blocksEditorInput(document.activeElement) &&
        (this.isFlying || this.controls.scheme.alwaysMove)) {
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
      if (move.lengthSq() > 0) {
        this.endFollow();
        this.pos.addScaledVector(move.normalize(), speed);
      }
    }

    if (this.following) {
      const { target, heading, firstPerson, attitude } = this.following;
      this.yaw = heading + this.relYaw;
      if (firstPerson && attitude) {
        // In the driver's seat: the camera IS the car — heading, pitch and roll — turned by
        // wherever the user is looking. A camera looks down -z, the car's nose is +z.
        const up = new Vector3(0, 1, 0).applyQuaternion(attitude);
        this.pos.copy(target).addScaledVector(up, 1.1);
        this.camera.position.copy(this.pos);
        this.camera.quaternion.copy(attitude)
          .multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI + this.relYaw))
          .multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), this.pitch));
        return;
      }
      if (firstPerson) this.pos.set(target.x, target.y + 1.1, target.z);
      else this.pos.copy(target).addScaledVector(this.forwardVec(), -this.distance);
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
    // While following, the user's pitch is relative to the car's: climbing a ramp tilts the view up with it.
    const pitch = this.following ? Math.min(Math.max(this.pitch + this.following.pitch, -1.55), 1.55) : this.pitch;
    return new Vector3(
      Math.sin(this.yaw) * Math.cos(pitch),
      Math.sin(pitch),
      Math.cos(this.yaw) * Math.cos(pitch),
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

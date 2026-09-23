import { el } from "./dom";

/**
 * The floating playback bar of a selected driving line (plugins/ghostPlayer): transport,
 * a scrubber with a tick at every checkpoint, speed, follow / first-person, and an
 * arrow-key pad that shows the driver's inputs — each key fills by how far the input is
 * pressed (50% left steer = half the left key), with the percentage on it in a colour that
 * contrasts with both the lit and the unlit part.
 *
 * View only: it renders `PlaybackView` and reports gestures; the plugin owns the state.
 */
export interface PlaybackView {
  label: string;
  hue: string;
  /** Playback time and length, ms. */
  time: number;
  duration: number;
  /** The race clock at the cursor (differs from `time` where failed tries were cut). */
  raceTime: number;
  /** Playback times of the checkpoints, the finish last. */
  checkpoints: readonly number[];
  checkpointsTaken: number;
  playing: boolean;
  speed: number;
  follow: boolean;
  firstPerson: boolean;
  /** "Hide line" is ticked: the tube goes away while playing or following. */
  hideLine: boolean;
  /** "Repeat" is ticked: the run starts over when it ends. */
  repeat: boolean;
  /** -1..1, 0..1, 0..1, km/h; null when the ghost carries no inputs. */
  steer: number | null;
  gas: number | null;
  brake: number | null;
  kmh: number | null;
}

export interface PlaybackHandlers {
  onPlayPause(): void;
  onSeek(ms: number): void;
  /** `samples` grows while a step button is held. */
  onStep(samples: number): void;
  onCheckpoint(direction: 1 | -1): void;
  onSpeed(speed: number): void;
  onFollow(on: boolean): void;
  onFirstPerson(on: boolean): void;
  onHideLine(on: boolean): void;
  onRepeat(on: boolean): void;
  onClose(): void;
}

export const PLAYBACK_SPEEDS = [0.1, 0.25, 0.5, 1, 2, 4, 8, 16, 32];

const clock = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms));
  const h = Math.floor(total / 3_600_000), m = Math.floor(total / 60_000) % 60, s = Math.floor(total / 1000) % 60;
  const cs = Math.floor((total % 1000) / 10);
  const tail = `${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
  return h ? `${h}:${String(m).padStart(2, "0")}:${tail}` : `${m}:${tail}`;
};

/**
 * Press = one step; hold = repeat, faster and in bigger strides the longer it is held
 * (after 2 s two samples at a time, doubling every further second up to 64).
 */
function holdToStep(button: HTMLElement, step: (samples: number) => void): void {
  let timer = 0, startedAt = 0;
  const stop = () => { window.clearTimeout(timer); timer = 0; };
  const tick = () => {
    const held = performance.now() - startedAt;
    const stride = held < 2000 ? 1 : Math.min(64, 2 ** Math.floor((held - 1000) / 1000));
    step(stride);
    timer = window.setTimeout(tick, Math.max(16, 140 - held * 0.08));
  };
  button.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    button.setPointerCapture(e.pointerId);
    startedAt = performance.now();
    step(1);
    timer = window.setTimeout(tick, 320);
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) button.addEventListener(type, stop);
  // Keyboard users: Enter / Space step once.
  button.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); step(1); } });
}

export function createPlaybackBar(handlers: PlaybackHandlers): { element: HTMLElement; update(view: PlaybackView): void } {
  const btn = (text: string, title: string, cls = "") => el("button", { class: `pb-btn ${cls}`, title, "aria-label": title, type: "button" }, text) as HTMLButtonElement;

  const prevCp = btn("⏮", "Previous checkpoint");
  const stepBack = btn("◀", "Step back (hold to keep going, faster the longer)");
  const play = btn("▶", "Play", "pb-play");
  const stepFwd = btn("▶", "Step forward (hold to keep going, faster the longer)");
  const nextCp = btn("⏭", "Next checkpoint");
  stepFwd.classList.add("pb-step");
  stepBack.classList.add("pb-step");
  prevCp.addEventListener("click", () => handlers.onCheckpoint(-1));
  nextCp.addEventListener("click", () => handlers.onCheckpoint(1));
  play.addEventListener("click", () => handlers.onPlayPause());
  holdToStep(stepBack, (n) => handlers.onStep(-n));
  holdToStep(stepFwd, (n) => handlers.onStep(n));

  const range = el("input", { type: "range", class: "pb-range", min: "0", max: "1000", step: "1", value: "0", "aria-label": "Position on the line" }) as HTMLInputElement;
  const ticks = el("div", { class: "pb-ticks" });
  const scrub = el("div", { class: "pb-scrub" }, ticks, range);
  let dragging = false;
  range.addEventListener("input", () => { dragging = true; handlers.onSeek(Number(range.value)); });
  range.addEventListener("change", () => { dragging = false; });

  const swatch = el("span", { class: "pb-swatch" });
  const name = el("span", { class: "pb-name" });
  const time = el("span", { class: "pb-time" });
  const cp = el("span", { class: "pb-cp" });

  const speed = el("select", { class: "pb-speed", title: "Playback speed", "aria-label": "Playback speed" }) as HTMLSelectElement;
  for (const s of PLAYBACK_SPEEDS) speed.append(el("option", { value: String(s) }, `${s}×`));
  speed.addEventListener("change", () => handlers.onSpeed(Number(speed.value)));

  const toggle = (text: string, title: string, on: (v: boolean) => void) => {
    const b = btn(text, title, "pb-toggle");
    b.addEventListener("click", () => on(b.getAttribute("aria-pressed") !== "true"));
    return b;
  };
  const follow = toggle("Follow", "Camera follows the car: drag to look around it, scroll to zoom. Moving away switches it off.", handlers.onFollow);
  const first = toggle("1st person", "See the run from the driver's seat (drag to look around)", handlers.onFirstPerson);
  const hide = toggle("Hide line", "Take the line's tube out of view while playing or following, so only the car is left; it comes back when you pause and stop following", handlers.onHideLine);
  const repeat = toggle("Repeat", "Start the run over when it ends", handlers.onRepeat);
  const close = btn("✕", "Close playback", "pb-close");
  close.addEventListener("click", () => handlers.onClose());

  // The key pad: gas on top, steer left / brake / steer right below.
  const key = (cls: string, glyph: string, title: string) => {
    const fill = el("span", { class: "pb-key-fill" });
    // The text twice: light over the unlit part, dark — clipped to the fill — over the lit
    // part, so it contrasts with whatever is behind each half of a glyph.
    const label = el("span", { class: "pb-key-label" }, glyph);
    const lit = el("span", { class: "pb-key-label pb-key-label-lit", "aria-hidden": "true" }, glyph);
    return { root: el("div", { class: `pb-key ${cls}`, title }, fill, label, lit), fill, label, lit, glyph };
  };
  const up = key("pb-key-up", "▲", "Accelerate"), left = key("pb-key-left", "◀", "Steer left");
  const down = key("pb-key-down", "▼", "Brake"), right = key("pb-key-right", "▶", "Steer right");
  const kmh = el("span", { class: "pb-kmh" });
  const pad = el("div", { class: "pb-pad" }, up.root, left.root, down.root, right.root);

  const element = el("div", { class: "playback-bar", role: "toolbar", "aria-label": "Driving line playback" },
    el("div", { class: "pb-main" },
      el("div", { class: "pb-row" }, swatch, name, time, cp, el("span", { class: "grow" }), speed, follow, first, hide, repeat, close),
      el("div", { class: "pb-row" }, prevCp, stepBack, play, stepFwd, nextCp, scrub),
    ),
    el("div", { class: "pb-inputs" }, pad, kmh),
  );
  // The viewport underneath must not see the bar's gestures.
  for (const type of ["pointerdown", "wheel", "dblclick", "contextmenu"]) element.addEventListener(type, (e) => e.stopPropagation());

  let tickKey = "";
  const setKey = (k: ReturnType<typeof key>, amount: number | null) => {
    const pct = amount === null ? 0 : Math.round(Math.min(1, Math.max(0, amount)) * 100);
    k.root.style.setProperty("--fill", `${pct}%`);
    k.label.textContent = k.lit.textContent = amount === null ? k.glyph : pct ? `${pct}%` : k.glyph;
    k.root.classList.toggle("on", pct > 0);
  };

  return {
    element,
    update(v: PlaybackView): void {
      element.style.setProperty("--line-hue", v.hue);
      name.textContent = v.label;
      time.textContent = `${clock(v.raceTime)} / ${clock(v.duration)} driven`;
      const total = v.checkpoints.length;
      cp.textContent = total ? (v.checkpointsTaken >= total ? "finished" : `CP ${v.checkpointsTaken}/${total - 1}`) : "";
      play.textContent = v.playing ? "⏸" : "▶";
      play.title = v.playing ? "Pause" : "Play";
      play.setAttribute("aria-label", play.title);
      if (speed.value !== String(v.speed)) speed.value = String(v.speed);
      follow.setAttribute("aria-pressed", String(v.follow));
      first.setAttribute("aria-pressed", String(v.firstPerson));
      hide.setAttribute("aria-pressed", String(v.hideLine));
      repeat.setAttribute("aria-pressed", String(v.repeat));
      range.max = String(Math.max(1, Math.round(v.duration)));
      if (!dragging) range.value = String(Math.round(v.time));
      range.style.setProperty("--played", `${v.duration ? (100 * v.time) / v.duration : 0}%`);

      const key = `${v.duration}|${v.checkpoints.length}`;
      if (key !== tickKey) {
        tickKey = key;
        ticks.replaceChildren(...v.checkpoints.slice(0, -1).map((c) => {
          const t = el("span", { class: "pb-tick" });
          t.style.left = `${v.duration ? (100 * c) / v.duration : 0}%`;
          return t;
        }));
      }

      setKey(up, v.gas);
      setKey(down, v.brake);
      setKey(left, v.steer === null ? null : Math.max(0, -v.steer));
      setKey(right, v.steer === null ? null : Math.max(0, v.steer));
      pad.classList.toggle("no-inputs", v.steer === null);
      pad.title = v.steer === null ? "This line was loaded without the driver's inputs — unload and load it again" : "";
      kmh.textContent = v.kmh === null ? "" : `${Math.round(v.kmh)} km/h`;
    },
  };
}

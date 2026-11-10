import GUI from 'lil-gui';
import Stats from 'stats.js';
import { applyHandlingPreset, defaultVehicleConfig, handlingState, HANDLING_PRESETS, type HandlingPreset, type VehicleConfig } from '../vehicle/config';
import type { CameraConfig } from '../camera/chase-camera';

/** FPS stats + lil-gui bound directly to the live config objects. Toggle with the ` (backquote) key. */
export class DebugPanel {
  readonly stats = new Stats();
  readonly gui = new GUI({ title: 'Need for Ryazan — debug', width: 320 });
  private visible = true;
  private infoEl = document.createElement('pre');

  constructor(cfg: VehicleConfig, cam: CameraConfig, extra: { audioVolume: { v: number }; onVolume: (v: number) => void; onReset: () => void }) {
    this.stats.showPanel(0);
    this.stats.dom.style.cssText = 'position:fixed;left:0;top:0;z-index:10';
    document.body.appendChild(this.stats.dom);

    this.infoEl.style.cssText = 'position:fixed;left:0;top:50px;margin:0;padding:4px 6px;font:11px monospace;color:#9f9;background:rgba(0,0,0,.55);z-index:10;pointer-events:none';
    document.body.appendChild(this.infoEl);
    const g = this.gui;
    g.domElement.style.zIndex = '10';
    g.domElement.style.top = '212px'; // под миникартой
    const addAll = (folder: GUI, obj: object, ranges: Record<string, [number, number, number?]> = {}) => {
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'number') {
          const r = ranges[k];
          const c = r ? folder.add(obj as Record<string, number>, k, r[0], r[1]) : folder.add(obj as Record<string, number>, k);
          if (r?.[2]) c.step(r[2]);
        }
      }
    };
    const f = (name: string, obj: object, ranges?: Record<string, [number, number, number?]>) => {
      const folder = g.addFolder(name);
      addAll(folder, obj, ranges);
      folder.close();
      return folder;
    };
    // пресет управляемости (docs/stage3/handling.md): arcade (по умолчанию) | sim-lite | drift; ?handling=drift
    const setPreset = (p: HandlingPreset) => { handlingState.preset = p; applyHandlingPreset(cfg, p); g.controllersRecursive().forEach((c) => c.updateDisplay()); };
    const hp = new URLSearchParams(location.search).get('handling') as HandlingPreset | null;
    if (hp && HANDLING_PRESETS.includes(hp)) setPreset(hp);
    g.add(handlingState, 'preset', HANDLING_PRESETS).name('handling preset').onChange(setPreset);
    f('chassis (needs reset to apply mass)', cfg.chassis);
    f('suspension', cfg.suspension, { stiffness: [10000, 120000], damping: [500, 10000], antiRoll: [0, 30000], restLength: [0.15, 0.6], travel: [0.05, 0.4] });
    f('tires', cfg.tires, { gripFront: [0.5, 3], gripRear: [0.5, 3], longGrip: [0.3, 2], lateralStiffness: [2, 25], lateralPeak: [1, 1.9], loadSensitivity: [0, 0.3], forceLever: [0, 1], forceLeverLong: [0, 1], handbrakeRearGrip: [0.1, 1], brakeForce: [3000, 50000], brakeBias: [0, 1], handbrakeForce: [0, 20000], abs: [0, 1], tractionControl: [0, 1] });
    f('engine', cfg.engine, { peakTorque: [100, 900], powerScale: [0.3, 3], driveFrontShare: [0, 1], shiftUpRpm: [3000, 8000], shiftDownRpm: [1000, 4000], shiftUpEcoRpm: [1500, 4000], shiftDownEcoRpm: [800, 2500], redlineRpm: [4000, 9000], finalDrive: [2, 6] });
    f('steering', cfg.steering, { maxAngle: [10, 50], minAngle: [1, 20], speedForMin: [10, 90], response: [1, 25], responseHighSpeed: [1, 25], returnResponse: [1, 25], gripLimit: [0, 1] });
    f('assist (yaw control)', cfg.assist, { yawGain: [0, 20], yawAccelMax: [0, 20], latGripUse: [0.5, 1.2], counterSteer: [0, 4], counterSteerMax: [0, 1], slipLimit: [5, 60], slipLimitGain: [0, 30] });
    f('drift', cfg.drift, { enabled: [0, 1, 1], minSpeed: [0, 30], rearGrip: [0.2, 1], baseAngle: [0, 60], throttleAngle: [0, 40], steerAngle: [0, 30], handbrakeAngle: [0, 60], maxAngle: [10, 90], angleGain: [0, 30], angleDamping: [0, 15], accelMax: [0, 20], exitAngle: [0, 20], blendIn: [0.5, 20], blendOut: [0.5, 20], brakeArmTime: [0, 2], powerOverSlip: [0, 40], speedKeep: [0, 1] });
    f('stability (anti-rollover)', cfg.stability, { rollStart: [0, 30], rollStiffness: [0, 80], rollDamping: [0, 15], pitchDamping: [0, 15], latCutStart: [0, 45], latCutRange: [1, 45], airUpright: [0, 30], airPitch: [0, 1], airDamping: [0, 10], airYawDamping: [0, 5], selfRight: [0, 1, 1] });
    f('aero', cfg.aero);
    f('nitro', cfg.nitro);
    f('camera', cam);
    const misc = g.addFolder('misc');
    misc.add(extra.audioVolume, 'v', 0, 1).name('volume').onChange(extra.onVolume);
    misc.add({ resetCar: extra.onReset }, 'resetCar').name('reset car (R)');
    misc.add({
      defaults: () => {
        Object.assign(cfg.chassis, defaultVehicleConfig().chassis);
        const d = defaultVehicleConfig() as unknown as Record<string, object>;
        for (const k of Object.keys(d)) {
          const target = (cfg as unknown as Record<string, object>)[k];
          if (k !== 'engine') Object.assign(target, d[k]);
          else {
            const { torqueCurve, gearRatios, ...rest } = d[k] as VehicleConfig['engine'];
            Object.assign(target, rest);
            void torqueCurve; void gearRatios;
          }
        }
        applyHandlingPreset(cfg, handlingState.preset);
        g.controllersRecursive().forEach((c) => c.updateDisplay());
      },
    }, 'defaults').name('restore vehicle defaults');

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Backquote') this.toggle();
    });
    if (new URLSearchParams(location.search).get('debug') === '0') this.toggle();
  }

  /** Текстовая строка статистики (draw calls, треугольники, тайлы…). */
  setInfo(text: string): void { if (this.visible) this.infoEl.textContent = text; }

  toggle(): void {
    this.visible = !this.visible;
    this.gui.domElement.style.display = this.visible ? '' : 'none';
    this.stats.dom.style.display = this.visible ? '' : 'none';
    this.infoEl.style.display = this.visible ? '' : 'none';
  }
}

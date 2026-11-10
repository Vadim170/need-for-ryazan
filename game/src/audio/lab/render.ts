/** Offline rendering of scripted drives with the real game audio graph (AudioSystem) -> WAV. */
import { AudioSystem } from '../audio-system';
import { OPEN_ENV, type EnvState } from '../environment';
import type { PlayerTelemetry } from '../vehicle-sfx';
import type { TelemetryFrame } from './scenarios';
import { defaultVehicleConfig } from '../../vehicle/config';

export interface RenderResult {
  buffer: AudioBuffer;
  soundRpm: Float32Array; // per telemetry frame
  renderMs: number;
  audioSeconds: number;
}

const ENG = defaultVehicleConfig().engine;

export function toPlayer(f: TelemetryFrame): PlayerTelemetry {
  return {
    rpm: f.rpm, throttle: f.throttle, load: f.load, gear: f.gear, speed: f.speed, nitro: f.nitro, skid: f.skid,
    handbrake: f.handbrake, drifting: f.drifting, grounded: f.grounded, impact: f.impact, bump: f.bump,
    idleRpm: ENG.idleRpm, redlineRpm: ENG.redlineRpm,
  };
}

export async function renderScenario(preset: string, tel: TelemetryFrame[], env: EnvState = OPEN_ENV, sampleRate = 48000, world = false): Promise<RenderResult> {
  const lead = 0.1, tail = 1.0;
  const dur = lead + tel.length / 60 + tail;
  const ctx = new OfflineAudioContext(2, Math.ceil(dur * sampleRate), sampleRate);
  const sys = await AudioSystem.create(ctx, { preset, world, waitWorld: world });
  sys.setVolume(1);
  sys.engine.reset(tel[0]?.rpm ?? 900);
  sys.updateEnv(env, 0);
  const soundRpm = new Float32Array(tel.length);
  for (let i = 0; i < tel.length; i++) {
    sys.updatePlayer(toPlayer(tel[i]), 1 / 60, lead + i / 60);
    if (world) {
      // a city around: daytime beds, a few cars passing the other way (Doppler), listener follows the car
      const x = 0, cars = [0, 1, 2].map((k) => ({ id: 50 + k, kind: 'sedan', x: 0, y: 0, z: -((i / 60) * 25 % 120) + k * 40 - 60, fx: 0, fz: 1, v: 14 }));
      sys.updateWorld({ listener: { x, y: 1.5, z: 0, fx: 0, fy: 0, fz: -1, ux: 0, uy: 1, uz: 0, vx: 0, vz: -tel[i].speed }, hour: 13, traffic: cars,
        trafficDensity: 1, pedestrians: 5, pedDensity: 1, trainRumble: 0, trainPos: null, inCity: true }, 1 / 60, lead + i / 60);
    }
    soundRpm[i] = sys.engine.debug.soundRpm;
  }
  const t0 = performance.now();
  const buffer = await ctx.startRendering();
  return { buffer, soundRpm, renderMs: performance.now() - t0, audioSeconds: dur };
}

/** 32-bit float stereo WAV. */
export function encodeWav(buf: AudioBuffer): Blob {
  const nCh = buf.numberOfChannels, n = buf.length, sr = buf.sampleRate;
  const bytes = 44 + n * nCh * 4;
  const dv = new DataView(new ArrayBuffer(bytes));
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); dv.setUint32(4, bytes - 8, true); w(8, 'WAVE');
  w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 3, true); dv.setUint16(22, nCh, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * nCh * 4, true); dv.setUint16(32, nCh * 4, true); dv.setUint16(34, 32, true);
  w(36, 'data'); dv.setUint32(40, n * nCh * 4, true);
  const ch = Array.from({ length: nCh }, (_, c) => buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < nCh; c++) { dv.setFloat32(o, ch[c][i], true); o += 4; }
  return new Blob([dv.buffer], { type: 'audio/wav' });
}

export const UPLOAD_URL = 'http://127.0.0.1:5199/save';

export async function upload(name: string, body: Blob | string): Promise<boolean> {
  try {
    const r = await fetch(`${UPLOAD_URL}?name=${encodeURIComponent(name)}`, { method: 'POST', body });
    return r.ok;
  } catch { return false; }
}

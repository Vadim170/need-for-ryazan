import type GUI from 'lil-gui';
import type { DayNight } from './day-night';
import type { NightLights } from './night-lights';
import type { PostFX } from './post';
import { quality, setQuality, PRESETS, type QualityName } from './quality';

/** Папка «day/night» в отладочной панели: время, скорость, пауза, bloom, фары. */
export function addDayNightGui(gui: GUI, dn: DayNight, nl: NightLights, post: PostFX): void {
  const f = gui.addFolder('day / night  ( [ ] = ±1 ч )');
  const st = { time: dn.clock.hour, dayMinutes: dn.clock.dayMinutes, label: dn.clock.label };
  const timeC = f.add(st, 'time', 0, 24, 0.05).name('hour').onChange((h: number) => dn.clock.setHour(h));
  f.add(dn.clock, 'paused').name('pause');
  f.add(st, 'dayMinutes', 0.5, 120, 0.5).name('real min / day').onChange((m: number) => { dn.clock.dayMinutes = m; });
  f.add(dn, 'cloudCover', 0, 1, 0.01).name('clouds');
  f.add(dn, 'exposureBias', 0.4, 2.5, 0.01).name('exposure ×');
  f.add(post, 'bloomEnabled').name('bloom');
  f.add(post, 'dayStrength', 0, 1.5, 0.01).name('bloom day');
  f.add(post, 'nightStrength', 0, 2, 0.01).name('bloom night');
  f.add(nl, 'headIntensity', 0, 2000, 10).name('headlights cd');
  f.add(nl, 'poolIntensity', 0, 2, 0.01).name('lamp pools');
  f.close();
  // графика (docs/stage3/realism.md): пресет качества (перезагрузка), пост-эффекты на лету
  const g = gui.addFolder('graphics');
  const q = { preset: quality.name };
  g.add(q, 'preset', Object.keys(PRESETS)).name('quality (reload)').onChange((v: QualityName) => setQuality(v));
  g.add(post, 'enabled').name('post-processing');
  g.add(post, 'aoStrength', 0, 1.5, 0.01).name('SSAO strength');
  g.add(post, 'aoRadius', 0.2, 4, 0.05).name('SSAO radius m');
  g.add(post, 'motionBlur', 0, 2, 0.01).name('motion blur');
  g.add(post, 'vignette', 0, 0.6, 0.01).name('vignette');
  g.add(dn, 'envIntensity', 0, 3, 0.01).name('sky IBL');
  g.add(dn, 'hemiKeep', 0, 1, 0.01).name('hemi light ×');
  g.close();
  // слайдер времени следует за часами
  setInterval(() => { if (!document.hidden) timeC.setValue(dn.clock.hour); }, 500);
}

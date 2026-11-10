import * as THREE from 'three';
import { DayNight } from './day-night';
import { GameClock, timeUniforms } from './time-of-day';
import { PostFX } from './post';
import { quality } from './quality';
import { createSun } from './sun-shadow';
import { loadWorldTextures } from './textures';
import { installAtmosphere } from './atmosphere';

/**
 * TODO(render): the spec prefers WebGPURenderer (`three/webgpu`) with automatic WebGL2 fallback.
 * Using WebGLRenderer for now: WebGPURenderer needs async init, TSL node materials and the
 * Sky/addon ecosystem differs (SkyMesh). Revisit in Stage 7 (optimisation).
 *
 * Реализм (docs/stage3/realism.md): пресеты качества (render/quality.ts), каскадные тени солнца (sun-shadow.ts),
 * IBL из неба (day-night.ts), PBR-текстуры мира (textures.ts), воздушная перспектива (atmosphere.ts),
 * пост-обработка (post.ts).
 */
export interface RenderContext {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** Солнце/луна (SunLight с каскадами теней): направление = position. */
  sun: THREE.Light & { shadow: THREE.LightShadow };
  hemi: THREE.HemisphereLight;
  /** Игровое время, небо, свет, туман (docs/stage2/day-night.md). */
  dayNight: DayNight;
  post: PostFX;
  /** Окружение из неба (PMREM, обновляется по времени суток; та же текстура — в scene.environment). */
  envMap: THREE.Texture;
  /** Туман под дальность стриминга. */
  setFog(near: number, far: number): void;
  /** Совместимость: раньше — центр карты теней; теперь каскады строятся по камере. */
  updateSun(target: THREE.Vector3): void;
  /** Кадр: часы, небо, свет. */
  update(dt: number, target: THREE.Vector3): void;
  /** Рендер сцены с пост-обработкой. */
  render(dt?: number): void;
  resize(): void;
}

export function createRenderer(canvas: HTMLCanvasElement): RenderContext {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.maxPixelRatio));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  const params = new URLSearchParams(location.search);
  const tm = params.get('tonemap');
  renderer.toneMapping = tm === 'agx' ? THREE.AgXToneMapping : tm === 'neutral' ? THREE.NeutralToneMapping : THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  const scene = new THREE.Scene();
  const fogColor = new THREE.Color(0xbcd0e4);
  scene.fog = new THREE.Fog(fogColor, 250, 1600);
  scene.background = fogColor;
  installAtmosphere();

  const camera = new THREE.PerspectiveCamera(65, 1, 0.25, 6000); // near 0.25: точность глубины для слоёв дорог/разметки

  // Солнце (направление/цвет/интенсивность задаёт DayNight), каскадные тени по пресету
  const sun = createSun(quality.cascades, quality.shadowMap, quality.shadowFar, quality.shadowRadius);
  scene.add(sun);
  const hemi = new THREE.HemisphereLight(0xaac4ff, 0x8b8578, 1.4);
  scene.add(hemi);

  const dayNight = new DayNight({ renderer, scene, camera, sun, hemi, clock: GameClock.fromQuery(params) });
  const envMap = dayNight.bakeEnvironment(renderer); // IBL из неба (PMREM), обновляется по времени суток
  void loadWorldTextures(renderer);
  const setFog = (near: number, far: number) => { (scene.fog as THREE.Fog).near = near; (scene.fog as THREE.Fog).far = far; };
  const post = new PostFX(renderer, scene, camera);
  post.enabled = params.get('post') !== '0';
  if (params.get('bloom') === '0') post.bloomEnabled = false;

  const update = (dt: number, t: THREE.Vector3) => {
    dayNight.update(dt, t);
    post.setSunElevation(dayNight.sunState.elevationDeg);
  };
  const render = (dt?: number) => post.render(timeUniforms.nightFactor.value, dt);

  const resize = () => {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    post.setSize(w, h);
  };
  window.addEventListener('resize', resize);
  resize();

  return { renderer, scene, camera, sun, hemi, dayNight, post, envMap, setFog, updateSun: (t) => update(0, t), update, render, resize };
}

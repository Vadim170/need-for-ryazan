import * as THREE from 'three';

/**
 * Материалы ноды `railway` тайлов (docs/world-format.md, «Дополнение: железная дорога»): процедурные шейдеры
 * в мировых координатах, ставятся через CityMaterials.override(имя glTF-материала) до загрузки тайлов.
 */

const NOISE = /* glsl */ `
varying vec3 vRwPos;
float rwHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float rwNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(rwHash(i), rwHash(i + vec2(1, 0)), f.x), mix(rwHash(i + vec2(0, 1)), rwHash(i + vec2(1, 1)), f.x), f.y);
}`;

function patch(m: THREE.MeshStandardMaterial, key: string, frag: string): THREE.MeshStandardMaterial {
  m.defines = { ...(m.defines ?? {}), USE_UV: '' };   // vUv без карты
  m.customProgramCacheKey = () => 'nfr-rail-' + key;
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRwPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRwPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + NOISE)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + frag);
  };
  return m;
}

export function createTrackMaterials(): Record<string, THREE.Material> {
  // щебень: зерно 5–8 см, пятна мазута между рельсами (uv.x — м поперёк от оси пути)
  const ballast = patch(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.97 }), 'ballast', /* glsl */ `
    {
      vec2 p = vRwPos.xz;
      float g = rwNoise(p * 14.0) * 0.55 + rwNoise(p * 31.0) * 0.3 + rwNoise(p * 2.1) * 0.25;
      vec3 c = mix(vec3(0.36, 0.35, 0.33), vec3(0.55, 0.53, 0.5), g);
      c = mix(c, vec3(0.42, 0.33, 0.26), smoothstep(0.55, 0.85, rwNoise(p * 0.35)) * 0.35);   // ржавчина
      float oil = (1.0 - smoothstep(0.5, 0.95, abs(vUv.x))) * (0.55 + 0.45 * rwNoise(p * 0.8));
      c *= 1.0 - 0.45 * oil;
      diffuseColor.rgb = c;
    }`);
  const sleeper = patch(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 }), 'sleeper', /* glsl */ `
    {
      float n = rwNoise(vRwPos.xz * 6.0) * 0.5 + rwNoise(vRwPos.xz * 23.0) * 0.3;
      // скрепления под рельсами (uv.y 0..1 поперёк шпалы)
      float clip = smoothstep(0.03, 0.0, abs(abs(vUv.y - 0.5) - 0.29));
      vec3 c = vec3(0.4, 0.39, 0.37) * (0.8 + 0.35 * n);
      diffuseColor.rgb = mix(c, vec3(0.18, 0.16, 0.15), clip * 0.85);
    }`);
  // рельсы: верх головки — накатанная сталь, боковины — ржавчина (нормаль в мире ~ вверх у верха)
  const steel = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.6 });
  steel.customProgramCacheKey = () => 'nfr-rail-steel';
  steel.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRwPos; varying float vRwUp;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRwPos = (modelMatrix * vec4(transformed, 1.0)).xyz; vRwUp = normalize(mat3(modelMatrix) * objectNormal).y;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vRwUp;\n' + NOISE)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float top = smoothstep(0.6, 0.9, vRwUp);
        vec3 rust = vec3(0.30, 0.19, 0.13) * (0.75 + 0.4 * rwNoise(vRwPos.xz * 3.0 + vRwPos.y));
        diffuseColor.rgb = mix(rust, vec3(0.78, 0.78, 0.8), top);`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(0.85, 0.25, smoothstep(0.6, 0.9, vRwUp));')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = mix(0.1, 0.85, smoothstep(0.6, 0.9, vRwUp));');
  };
  // платформа: бетонные плиты 1.5×1.5 м со швами, светлая полоса безопасности не делается (нет края в данных)
  const platform = patch(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 }), 'platform', /* glsl */ `
    {
      vec2 p = vRwPos.xz / 1.5;
      vec2 f = abs(fract(p) - 0.5);
      float seam = smoothstep(0.47, 0.5, max(f.x, f.y));
      float n = rwNoise(floor(p) * 1.7) * 0.15 + rwNoise(vRwPos.xz * 4.0) * 0.12;
      diffuseColor.rgb = vec3(0.6, 0.59, 0.56) * (0.85 + n) * (1.0 - 0.35 * seam);
    }`);
  const wall = patch(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92 }), 'pwall', /* glsl */ `
    {
      float n = rwNoise(vec2(vRwPos.x + vRwPos.z, vRwPos.y) * 3.0);
      float dirt = smoothstep(-0.2, -1.0, vUv.y);
      diffuseColor.rgb = vec3(0.58, 0.57, 0.54) * (0.85 + 0.2 * n) * (1.0 - 0.3 * dirt);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.92, 0.82, 0.25), smoothstep(-0.12, -0.05, vUv.y) * 0.9);  // жёлтый кант
    }`);
  const canopy = new THREE.MeshStandardMaterial({ color: 0x5f7364, roughness: 0.6, metalness: 0.3, side: THREE.DoubleSide });
  const column = new THREE.MeshStandardMaterial({ color: 0x3e4a42, roughness: 0.55, metalness: 0.4 });
  return {
    rail_ballast: ballast, rail_sleeper: sleeper, rail_steel: steel, rail_platform: platform, rail_platform_wall: wall,
    rail_canopy: canopy, rail_canopy_column: column,
  };
}

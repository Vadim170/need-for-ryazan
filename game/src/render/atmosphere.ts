import * as THREE from 'three';

/**
 * Воздушная перспектива (docs/stage3/realism.md): к линейному туману three (scene.fog, цвет = горизонт неба,
 * day-night.ts / weather-system.ts управляют near/far/цветом) добавляется экспоненциальная дымка по дальности,
 * гуще в низинах (ниже камеры — пойма Оки, Лыбедь) и реже на высоте. Правка общих чанков `fog_*` один раз до
 * компиляции шейдеров: действует на все материалы с fog (встроенные и с onBeforeCompile). Мировая позиция —
 * из mvPosition (работает с instancing/skinning).
 */
let done = false;
export function installAtmosphere(): void {
  if (done) return;
  done = true;
  const C = THREE.ShaderChunk as unknown as Record<string, string>;
  C.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vFogWorld;
#endif`;
  C.fog_vertex = /* glsl */ `
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  vFogWorld = cameraPosition + transpose(mat3(viewMatrix)) * mvPosition.xyz;
#endif`;
  C.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying vec3 vFogWorld;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
#endif`;
  C.fog_fragment = /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
  #endif
  {
    // дымка: плотность растёт ниже камеры (экспонента по высоте), интеграл по лучу — средняя плотность
    vec3 fr = vFogWorld - cameraPosition;
    float fd = length(fr);
    float hy = clamp(fr.y * 0.5, -60.0, 300.0);
    float dens = 0.0007 * exp(-hy / 75.0);
    float haze = (1.0 - exp(-fd * dens)) * 0.6;
    fogFactor = max(fogFactor, haze);
  }
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
#endif`;
}

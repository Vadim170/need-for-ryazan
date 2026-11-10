/**
 * Пресеты качества графики (docs/stage3/realism.md): `?quality=low|medium|high|ultra`, иначе — сохранённый в
 * localStorage выбор из GUI, иначе — автоопределение по GPU. Смена пресета в GUI перезагружает страницу
 * (число каскадов теней — константа в шейдерах, MSAA — в render target-ах).
 */

export type QualityName = 'low' | 'medium' | 'high' | 'ultra';

export interface QualityPreset {
  name: QualityName;
  /** Потолок devicePixelRatio. */
  maxPixelRatio: number;
  /** Каскады теней солнца (2–4) и размер карты одного каскада. */
  cascades: number;
  shadowMap: number;
  /** Дальность теней, м. */
  shadowFar: number;
  /** Мягкость тени (радиус PCF в текселях ближнего каскада). */
  shadowRadius: number;
  /** MSAA сэмплов в HDR-буфере (0 — нет). */
  msaa: number;
  smaa: boolean;
  /** SSAO: 0 — нет, 0.5 — половинное разрешение, 1 — полное. */
  ssao: number;
  bloom: boolean;
  motionBlur: boolean;
  /** Анизотропная фильтрация текстур. */
  anisotropy: number;
  /** Второй сэмпл текстуры против повторения (асфальт, газон, грунт) и детальные нормали вблизи. */
  textureDetail: number;
  /** Интерьеры за окнами (interior mapping). */
  interiors: boolean;
  /** Дальность полноценных деревьев (дальше — импостеры). */
  treeNear: number;
}

export const PRESETS: Record<QualityName, QualityPreset> = {
  low: {
    name: 'low', maxPixelRatio: 1, cascades: 2, shadowMap: 1024, shadowFar: 120, shadowRadius: 1.5, msaa: 0, smaa: false, ssao: 0,
    bloom: false, motionBlur: false, anisotropy: 4, textureDetail: 0, interiors: false, treeNear: 70,
  },
  medium: {
    name: 'medium', maxPixelRatio: 1, cascades: 2, shadowMap: 2048, shadowFar: 180, shadowRadius: 2, msaa: 0, smaa: true, ssao: 0,
    bloom: true, motionBlur: true, anisotropy: 8, textureDetail: 0.5, interiors: true, treeNear: 100,
  },
  high: {
    name: 'high', maxPixelRatio: 1.5, cascades: 3, shadowMap: 2048, shadowFar: 240, shadowRadius: 2.5, msaa: 4, smaa: false, ssao: 0.5,
    bloom: true, motionBlur: true, anisotropy: 16, textureDetail: 1, interiors: true, treeNear: 115,
  },
  ultra: {
    name: 'ultra', maxPixelRatio: 2, cascades: 4, shadowMap: 2048, shadowFar: 320, shadowRadius: 3, msaa: 4, smaa: true, ssao: 1,
    bloom: true, motionBlur: true, anisotropy: 16, textureDetail: 1, interiors: true, treeNear: 170,
  },
};

const KEY = 'nfr.quality';

/** Автоопределение по строке GPU (WEBGL_debug_renderer_info). */
export function detectQuality(): QualityName {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return 'low';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const gpu = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)).toLowerCase();
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    const mobile = /android|iphone|ipad|mobile/i.test(navigator.userAgent);
    if (mobile || /mali|adreno|powervr|swiftshader|llvmpipe/.test(gpu)) return 'low';
    if (/apple m\d (max|ultra)|rtx [2-9]0[6-9]0|rtx [4-9]0[7-9]0|rx [67]\d00 xt|radeon pro w/.test(gpu)) return 'ultra';
    if (/apple m\d|apple gpu|rtx|radeon rx|arc a7|geforce gtx 1[0-9]{3}/.test(gpu)) return 'high';
    if (/intel|uhd|iris|vega \d|radeon\(tm\) graphics/.test(gpu)) return 'medium';
    return 'high';
  } catch {
    return 'medium';
  }
}

function resolve(): QualityPreset {
  const q = new URLSearchParams(location.search).get('quality') as QualityName | null;
  if (q && q in PRESETS) return PRESETS[q];
  const saved = (typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null) as QualityName | null;
  if (saved && saved in PRESETS) return PRESETS[saved];
  return PRESETS[detectQuality()];
}

/** Текущий пресет (определяется один раз при загрузке модуля). */
export const quality: QualityPreset = resolve();

/** Сменить пресет (GUI): сохраняет выбор и перезагружает страницу без ?quality=. */
export function setQuality(name: QualityName): void {
  localStorage.setItem(KEY, name);
  const u = new URL(location.href);
  u.searchParams.delete('quality');
  location.href = u.toString();
}

/**
 * Ломаемые пропсы: порог скорости сближения (км/ч), масса обломка, опора-шарнир у основания.
 * Ниже порога пропс — неподвижная стена (статический коллайдер). Выше — заменяется динамическим телом этой массы
 * (за мгновение до контакта), машина бьёт его сама: теряет импульс по законам Rapier, без «отскока от стены».
 * mass — кг; perM — кг на метр длины сегмента (ограды). pivot — шаровой шарнир в основании (столб валится от основания,
 * шарнир «лопается» при наклоне > 20° или через 0.6 с).
 */
/** loss — потеря скорости машины на разрушение (км/ч, сверх обмена импульсом с обломком). */
export interface BreakClass { kmh: number; loss: number; mass?: number; perM?: number; pivot?: boolean; lampOff?: boolean; tlOff?: boolean;
  /** Заросли: не обломок, а пригнутая/поломанная клумпа (инстанс наклоняется и приминается), коллайдер убирается. */
  flatten?: boolean;
  /** Припаркованная машина: динамическое тело с низким центром масс, без ручного импульса (удар считает Rapier),
   *  успокоилась — снова статическая на новом месте (до конца сессии); толкает соседей. */
  car?: boolean }

export const BREAK: Record<string, BreakClass> = {
  lamp: { kmh: 28, loss: 8, mass: 250, pivot: true, lampOff: true },
  lamp_double: { kmh: 35, loss: 10, mass: 350, pivot: true, lampOff: true },
  park_lamp: { kmh: 18, loss: 4, mass: 120, pivot: true, lampOff: true },
  tl: { kmh: 25, loss: 6, mass: 180, pivot: true, tlOff: true },
  tl_arm: { kmh: 35, loss: 10, mass: 450, pivot: true, tlOff: true },
  bollard: { kmh: 20, loss: 5, mass: 40, pivot: true },
  bus_stop: { kmh: 30, loss: 8, mass: 450 },
  container: { kmh: 25, loss: 8, mass: 500 },
  bench: { kmh: 5, loss: 1, mass: 60 },
  bin: { kmh: 3, loss: 0.5, mass: 20 },
  fence: { kmh: 15, loss: 0.7, perM: 18 },
  ped_fence: { kmh: 14, loss: 0.7, perM: 15 },
  lawn_fence: { kmh: 6, loss: 0.5, perM: 6 },
  guardrail: { kmh: 60, loss: 12, perM: 40 },
  jersey: { kmh: 30, loss: 0, perM: 900 }, // бетонный блок: не ломается, а сдвигается (тяжёлый)
  jersey_plastic: { kmh: 8, loss: 1, perM: 60 },
  parked_car: { kmh: 3, loss: 0, mass: 1200, car: true },
  // пешеходная улица (Почтовая): чугунный фонарь тяжелее паркового, киоск — как остановка, терраса — мебель
  lamp_classic: { kmh: 20, loss: 5, mass: 180, pivot: true, lampOff: true },
  kiosk: { kmh: 30, loss: 9, mass: 700 },
  terrace: { kmh: 4, loss: 1.5, mass: 150 },
  // заросли клёна ясенелистного (docs/stage3/landcover.md): тонкую клумпу машина продавливает даже шагом, теряя ~9 км/ч на
  // каждой (несколько подряд — встала); густую — только с разгона, теряя 45 км/ч. Пешком — стена.
  thicket: { kmh: 4, loss: 9, flatten: true },
  thicket_dense: { kmh: 55, loss: 45, flatten: true },
};

/** Лимит одновременно «живых» обломков; старше — исчезают (пропс остаётся сломанным до перезагрузки тайла). */
export const DEBRIS_MAX = 40;
export const DEBRIS_TTL = 120; // с
export const DEBRIS_FAR = 220; // м от машины
/** Лимит одновременно динамических припаркованных машин (старшие «засыпают» статическими на месте). */
export const CARS_DYNAMIC_MAX = 20;

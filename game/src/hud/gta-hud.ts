import { WEAPONS, WEAPON_ORDER, type WeaponId } from '../combat/weapons';

/**
 * HUD GTA-режима (DOM поверх канваса): деньги, звёзды розыска (мигают при поиске), оружие и патроны, здоровье и броня,
 * подсказки действий (по-русски), всплывающие сообщения, большие «ПОТРАЧЕНО» / «АРЕСТОВАН», прицел, колесо оружия.
 * Слева от миникарты (правый верх), подсказки — внизу по центру.
 */
export interface HudState {
  money: number;
  hp: number;
  armor: number;
  wanted: number;
  searching: boolean;
  weapon: WeaponId;
  clip: number;
  reserve: number;
  reloading: boolean;
  onFoot: boolean;
  aiming: boolean;
  prompt: string;
  bust: number;
  battery: number | null;
}

const CSS = `
#gta { position: fixed; right: 216px; top: 10px; color: #fff; text-align: right; pointer-events: none; user-select: none;
  font-family: system-ui, sans-serif; text-shadow: 0 0 4px #000, 0 0 2px #000; z-index: 6; min-width: 190px; }
#gta .money { font-size: 28px; font-weight: 800; color: #8fd88f; font-variant-numeric: tabular-nums; letter-spacing: .5px; }
#gta .stars { font-size: 24px; letter-spacing: 2px; height: 28px; }
#gta .stars .on { color: #ffe14a; } #gta .stars .off { color: rgba(255,255,255,.18); }
#gta .stars.flash .on { animation: gtaflash .5s steps(2) infinite; }
@keyframes gtaflash { 50% { color: rgba(255,225,74,.15); } }
#gta .weapon { font-size: 16px; font-weight: 700; margin-top: 2px; }
#gta .ammo { font-size: 14px; opacity: .9; font-variant-numeric: tabular-nums; }
#gta .bar { width: 190px; height: 7px; background: rgba(0,0,0,.45); border: 1px solid rgba(255,255,255,.25); margin: 4px 0 0 auto; }
#gta .bar > i { display: block; height: 100%; width: 100%; }
#gta .hp > i { background: linear-gradient(90deg,#c22,#e44); } #gta .ar > i { background: #48c; }
#gta .bat > i { background: #fd4; }
#gta .batl { font-size: 11px; opacity: .85; }
#gta-prompt { position: fixed; left: 50%; bottom: 120px; transform: translateX(-50%); color: #fff; font: 600 17px system-ui, sans-serif;
  background: rgba(0,0,0,.55); padding: 7px 14px; border-radius: 4px; pointer-events: none; display: none; z-index: 6; }
#gta-prompt b { color: #ffe14a; }
#gta-toast { position: fixed; left: 50%; top: 22%; transform: translateX(-50%); color: #fff; font: 700 22px system-ui, sans-serif;
  text-shadow: 0 0 6px #000; pointer-events: none; z-index: 6; text-align: center; }
#gta-big { position: fixed; inset: 0; display: none; align-items: center; justify-content: center; pointer-events: none; z-index: 7;
  font: 900 76px Georgia, serif; letter-spacing: 3px; text-shadow: 0 0 14px #000, 0 0 3px #000; background: rgba(0,0,0,.25); }
#gta-cross { position: fixed; left: 50%; top: 50%; width: 22px; height: 22px; margin: -11px 0 0 -11px; pointer-events: none; display: none; z-index: 6; }
#gta-cross::before, #gta-cross::after { content: ''; position: absolute; background: rgba(255,255,255,.9); box-shadow: 0 0 2px #000; }
#gta-cross::before { left: 10px; top: 0; width: 2px; height: 22px; } #gta-cross::after { top: 10px; left: 0; height: 2px; width: 22px; }
#gta-bust { position: fixed; left: 50%; bottom: 160px; width: 220px; margin-left: -110px; height: 8px; background: rgba(0,0,0,.5);
  border: 1px solid #fff; display: none; z-index: 6; } #gta-bust > i { display: block; height: 100%; background: #36f; }
#gta-wheel { position: fixed; left: 50%; top: 50%; width: 300px; height: 300px; margin: -150px 0 0 -150px; display: none; z-index: 8; pointer-events: none; }
#gta-wheel div { position: absolute; width: 96px; height: 50px; margin: -25px 0 0 -48px; background: rgba(0,0,0,.6); color: #fff; border: 2px solid rgba(255,255,255,.3);
  font: 700 13px system-ui, sans-serif; display: flex; align-items: center; justify-content: center; text-align: center; border-radius: 6px; }
#gta-wheel div.sel { border-color: #ffe14a; color: #ffe14a; } #gta-wheel div.no { opacity: .3; }
`;

export class GtaHud {
  private root = document.createElement('div');
  private money: HTMLElement; private stars: HTMLElement; private weapon: HTMLElement; private ammo: HTMLElement;
  private hp: HTMLElement; private ar: HTMLElement; private bat: HTMLElement; private batl: HTMLElement; private batWrap: HTMLElement;
  private prompt = document.createElement('div');
  private toastEl = document.createElement('div');
  private big = document.createElement('div');
  private cross = document.createElement('div');
  private bust = document.createElement('div');
  private wheel = document.createElement('div');
  private toasts: { text: string; t: number }[] = [];
  private lastKey = '';
  private shownMoney = 0;
  /** Выбранный в колесе оружия (null — колесо закрыто). */
  wheelSel: WeaponId | null = null;

  constructor() {
    const st = document.createElement('style');
    st.textContent = CSS;
    document.head.appendChild(st);
    this.root.id = 'gta';
    this.root.innerHTML = `<div class="money"></div><div class="stars"></div><div class="weapon"></div><div class="ammo"></div>
      <div class="bar hp"><i></i></div><div class="bar ar"><i></i></div><div class="batw"><div class="bar bat"><i></i></div><div class="batl"></div></div>`;
    document.body.appendChild(this.root);
    const q = (s: string) => this.root.querySelector(s) as HTMLElement;
    this.money = q('.money'); this.stars = q('.stars'); this.weapon = q('.weapon'); this.ammo = q('.ammo');
    this.hp = q('.hp > i'); this.ar = q('.ar > i'); this.bat = q('.bat > i'); this.batl = q('.batl'); this.batWrap = q('.batw');
    this.prompt.id = 'gta-prompt'; this.toastEl.id = 'gta-toast'; this.big.id = 'gta-big'; this.cross.id = 'gta-cross';
    this.bust.id = 'gta-bust'; this.bust.innerHTML = '<i></i>';
    this.wheel.id = 'gta-wheel';
    this.wheel.innerHTML = WEAPON_ORDER.map((w, i) => {
      const a = (i / WEAPON_ORDER.length) * Math.PI * 2 - Math.PI / 2;
      return `<div data-w="${w}" style="left:${150 + Math.cos(a) * 105}px;top:${150 + Math.sin(a) * 105}px">${WEAPONS[w].name}</div>`;
    }).join('');
    document.body.append(this.prompt, this.toastEl, this.big, this.cross, this.bust, this.wheel);
  }

  toast(text: string, t = 2.2): void {
    this.toasts.push({ text, t });
    if (this.toasts.length > 4) this.toasts.shift();
  }

  /** Большая надпись по центру (null — убрать). */
  setBig(text: string | null, color = '#c8282a'): void {
    this.big.style.display = text ? 'flex' : 'none';
    if (text) { this.big.textContent = text; this.big.style.color = color; }
  }

  /** Колесо оружия: открыть/обновить выбор по направлению (dx, dy — накопленное смещение мыши/стика). */
  showWheel(open: boolean, dx: number, dy: number, have: (w: WeaponId) => boolean, current: WeaponId): void {
    this.wheel.style.display = open ? 'block' : 'none';
    if (!open) { this.wheelSel = null; return; }
    let sel: WeaponId = this.wheelSel ?? current;
    if (Math.hypot(dx, dy) > 30) {
      const a = Math.atan2(dy, dx) + Math.PI / 2;
      const i = Math.round(((a + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2) * WEAPON_ORDER.length) % WEAPON_ORDER.length;
      if (have(WEAPON_ORDER[i])) sel = WEAPON_ORDER[i];
    }
    this.wheelSel = sel;
    for (const el of Array.from(this.wheel.children) as HTMLElement[]) {
      const w = el.dataset.w as WeaponId;
      el.className = (w === sel ? 'sel' : '') + (have(w) ? '' : ' no');
    }
  }

  update(dt: number, s: HudState): void {
    this.shownMoney += (s.money - this.shownMoney) * Math.min(1, dt * 8);
    if (Math.abs(s.money - this.shownMoney) < 1) this.shownMoney = s.money;
    const w = WEAPONS[s.weapon];
    const key = [Math.round(this.shownMoney), s.wanted, s.searching, s.weapon, s.clip, s.reserve, s.reloading, Math.round(s.hp), Math.round(s.armor), s.battery === null ? -1 : Math.round(s.battery * 100)].join('|');
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.money.textContent = '₽ ' + Math.round(this.shownMoney).toLocaleString('ru-RU');
      this.stars.innerHTML = [1, 2, 3, 4, 5].map((i) => `<span class="${i <= s.wanted ? 'on' : 'off'}">★</span>`).join('');
      this.stars.classList.toggle('flash', s.searching && s.wanted > 0);
      this.weapon.textContent = w.name;
      this.ammo.textContent = w.melee ? '' : s.reloading ? 'перезарядка…' : `${s.clip} / ${s.reserve}`;
      this.hp.style.width = `${Math.max(0, Math.min(100, s.hp))}%`;
      this.ar.parentElement!.style.display = s.armor > 0 ? 'block' : 'none';
      this.ar.style.width = `${Math.max(0, Math.min(100, s.armor))}%`;
      this.batWrap.style.display = s.battery === null ? 'none' : 'block';
      if (s.battery !== null) { this.bat.style.width = `${s.battery * 100}%`; this.batl.textContent = `АХ ${Math.round(s.battery * 100)}%`; }
    }
    this.prompt.style.display = s.prompt ? 'block' : 'none';
    if (s.prompt && this.prompt.innerHTML !== s.prompt) this.prompt.innerHTML = s.prompt;
    this.cross.style.display = s.aiming && s.onFoot ? 'block' : 'none';
    this.bust.style.display = s.bust > 0.02 ? 'block' : 'none';
    (this.bust.firstChild as HTMLElement).style.width = `${s.bust * 100}%`;
    // всплывающие
    for (const t of this.toasts) t.t -= dt;
    while (this.toasts.length && this.toasts[0].t <= 0) this.toasts.shift();
    const txt = this.toasts.map((t) => `<div style="opacity:${Math.min(1, t.t * 2)}">${t.text}</div>`).join('');
    if (this.toastEl.innerHTML !== txt) this.toastEl.innerHTML = txt;
  }
}

import * as THREE from 'three';
import type { PhysicsWorld, RAPIER } from '../physics/world';
import type { Input, DriveInput } from '../core/input';
import type { Vehicle } from '../vehicle/vehicle';
import type { CityWorld } from '../world/city-world';
import type { Traffic } from '../traffic';
import type { Rail } from '../rail';
import type { People } from '../people';
import type { PeopleSystem, PlayerCarState } from '../people/people-system';
import type { VehicleLibrary } from '../traffic/gltf-models';
import { buildVehicleModels, type VehicleKind, type VehicleModel } from '../traffic/models';
import type { Obstacle } from '../traffic/sim';
import { RagdollPool } from '../people/ragdoll';
import { Effects } from '../combat/effects';
import { VehicleDamage } from '../combat/vehicle-damage';
import { Combat } from '../combat/combat';
import { Pickups } from '../combat/pickups';
import { gameEvents } from '../combat/events';
import { WEAPONS } from '../combat/weapons';
import { Wanted } from '../police/wanted';
import { Police, type PlayerView } from '../police/police';
import { RoadRouter } from '../police/road-router';
import { OrbitCamera } from '../camera/orbit-camera';
import { GtaHud } from '../hud/gta-hud';
import { RigAssets } from './rig-assets';
import { RigRagdollSkin } from './human-rig';
import { Fleet, type FleetCar } from './fleet';
import { ControlReader } from './controls';
import { Player, PLAYER_OUTFITS, type Place, type PlayerOutfit } from './player';

/**
 * GTA-режим целиком (docs/stage3/gta-mode.md): сборка игрока, машин, боя, полиции, HUD. main.ts вызывает
 * preFrame (до шага физики) и postFrame (после), берёт focus (стриминг/камера/свет) и vehicle (машина для звука/HUD).
 * ?gta=0 — режим выключен (как раньше: только машина).
 */
export interface GtaDeps {
  physics: PhysicsWorld;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  canvas: HTMLCanvasElement;
  input: Input;
  envMap?: THREE.Texture | null;
  city: CityWorld | null;
  car: Vehicle;
  lib: VehicleLibrary | null;
  baseUrl: string;
  /** Подгрузить тайлы вокруг точки (респаун). */
  preload: (p: THREE.Vector3) => Promise<void>;
}

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q = new THREE.Quaternion();

export class GtaMode {
  readonly effects: Effects;
  readonly damage: VehicleDamage;
  readonly combat: Combat;
  readonly pickups: Pickups;
  readonly wanted = new Wanted();
  readonly police: Police;
  readonly fleet: Fleet;
  readonly player: Player;
  readonly hud = new GtaHud();
  readonly orbit: OrbitCamera;
  readonly controls: ControlReader;
  readonly ragdolls: RagdollPool;
  readonly skin = new RigRagdollSkin();
  readonly router: RoadRouter | null;
  readonly events = gameEvents;
  traffic: Traffic | null = null;
  rail: Rail | null = null;
  people: People | null = null;
  places: Place[] = [];
  assets: RigAssets | null = null;
  private models: Record<VehicleKind, VehicleModel> | null = null;
  private shotT = 0;
  private copHitT = -1e9;
  private playerHitAt = new Map<number, number>();
  private time = 0;
  private obstacles: Obstacle[] = [];
  private obsPool: Obstacle[] = [];
  private pcs: PlayerCarState = { x: 0, y: 0, z: 0, vx: 0, vz: 0, fx: 0, fz: -1, halfLength: 2.2, halfWidth: 0.9 };
  readonly stats = { ms: 0 };

  constructor(private d: GtaDeps) {
    const { physics, scene } = d;
    this.effects = new Effects(scene);
    this.damage = new VehicleDamage(this.effects);
    this.combat = new Combat(physics, this.effects, this.damage, () => this.ppl(), () => this.traffic);
    this.pickups = new Pickups(scene, (x, y, z) => {
      const g = physics.groundHeightAt(x, z), h = d.city ? d.city.heightAt(x, z) : 0;
      return g > y + 0.5 ? h : Math.max(g, h);
    });
    this.ragdolls = new RagdollPool(physics, scene, 6);
    this.ragdolls.skin = this.skin;
    this.router = d.city ? new RoadRouter(d.city.graph) : null;
    this.fleet = new Fleet({
      physics, scene, envMap: d.envMap, models: () => this.procModels(), gltf: () => this.traffic?.renderer.gltf ?? null,
      lib: d.lib, damage: this.damage, traffic: () => this.traffic, props: () => d.city?.props ?? null,
    });
    const largus = this.fleet.addExisting(d.car, 'largus', true);
    this.orbit = new OrbitCamera(d.camera, physics);
    this.controls = new ControlReader(d.input, d.canvas);
    this.police = new Police({
      physics, scene, fleet: this.fleet, router: this.router, combat: this.combat, wanted: this.wanted, pickups: this.pickups,
      ragdolls: this.ragdolls, skin: this.skin, traffic: () => this.traffic, heightAt: (x, z) => this.heightAt(x, z),
    });
    this.player = new Player({
      physics, scene, camera: d.camera, orbit: this.orbit, fleet: this.fleet, combat: this.combat, effects: this.effects, pickups: this.pickups,
      wanted: this.wanted, police: this.police, hud: this.hud, ragdolls: this.ragdolls, skin: this.skin, people: () => this.ppl(),
      heightAt: (x, z) => this.heightAt(x, z), surfaceAt: (x, z) => d.city?.surfaceAt(x, z) ?? -1,
      onBodyChange: (body, len, w, mass, vehicle) => this.bodyChanged(body, len, w, mass, vehicle),
      preload: d.preload, places: () => this.places, snapToWalkable: (p) => this.snap(p),
    }, largus);
    // связи
    this.police.onBusted = () => this.player.busted();
    this.police.onRagdollDone = (a, r) => this.player.ragdollDone(a, r);
    this.police.onCopHit = () => { if (this.time - this.copHitT > 2) { this.copHitT = this.time; this.wanted.report('hitCop', this.player.focus, true, 0); } };
    this.police.onCopDown = (byPlayer) => { if (byPlayer) this.wanted.report('downCop', this.player.focus, true, 0); };
    this.combat.onShot = (p, byPlayer) => {
      if (!byPlayer || this.shotT > 0) return;
      this.shotT = 1.5;
      this.player.crime('shoot', p);
    };
    this.combat.onPedHit = (i, byPlayer, melee) => {
      if (!byPlayer) return;
      const pp = this.ppl()?.agentPos(i, new THREE.Vector3()) ?? this.player.pos;
      this.player.crime(melee ? 'punch' : 'shootPed', pp);
    };
    this.combat.onVehicleHit = (body, _tid, byPlayer) => {
      if (body && byPlayer) this.playerHitAt.set(body.handle, this.time);
      // по машине игрока стреляют: немного достаётся и водителю
      if (body && !byPlayer && this.player.driving && body === this.player.car.vehicle.body) this.player.hurt(1.5);
    };
    this.damage.trafficWreck = (id) => {
      const t = this.traffic;
      const v = t?.sim.vehicles.find((x) => x.id === id);
      return v && t ? t.physics.crashVehicle(v) : null;
    };
    this.damage.onExplosion = (p, r, power, body) => this.explosion(p, r, power, body);
    // ассеты людей (игрок, полиция)
    const params = new URLSearchParams(location.search);
    // игрок: свой персонаж (body 'player'); ?outfit=robe — халат; ?player_char=<id> — любой персонаж из people.json
    const of = params.get('outfit');
    if (of === 'robe' || of === 'default' || of === 'winter') this.outfit = of;
    RigAssets.load().then(async (a) => {
      this.assets = a;
      const pc = params.get('player_char');
      const want = this.wantedOutfit();
      if (pc) await this.player.loadRig(a, pc);
      else if (a.ids().includes(PLAYER_OUTFITS[want].id)) { await this.player.loadRig(a, PLAYER_OUTFITS[want].id, PLAYER_OUTFITS[want].look); this.wornOutfit = want; }
      else await this.player.loadRig(a, 'man_jacket');
      await this.police.loadAssets(a);
    }).catch((e) => console.warn('[gta] персонажи не загрузились:', e));
    // больницы / отделы полиции / автосервисы из OSM (pipeline/build_places.py); вне world/ — его перезаписывает сборка мира
    fetch(d.baseUrl === '/world/' ? '/assets/gta/places.json' : d.baseUrl + 'places.json').then((r) => (r.ok ? r.json() : null)).then((j) => { if (j) this.places = j.places; }).catch(() => {});
    if (params.get('police') === '0') { this.police.enabled = false; this.wanted.enabled = false; }
  }

  private procModels(): Record<VehicleKind, VehicleModel> {
    return this.traffic?.sim.models ?? (this.models ??= buildVehicleModels());
  }
  private ppl(): PeopleSystem | null { return this.people?.system ?? null; }
  private heightAt(x: number, z: number): number { return this.d.city ? this.d.city.heightAt(x, z) : 0; }

  attachTraffic(t: Traffic): void {
    this.traffic = t;
    this.fleet.buildTrolleyWires(t);
    if (this.player.driving) { const v = this.player.car.vehicle; t.setPlayer(v.body, v.cfg.chassis.length, v.cfg.chassis.width); }
  }
  attachRail(r: Rail): void { this.rail = r; }
  attachPeople(p: People): void {
    this.people = p;
    void p.ready.then((s) => {
      if (!s) return;
      const prev = s.onHit;
      s.onHit = (speed, x, z, byPlayer) => {
        prev?.(speed, x, z, byPlayer);
        if (byPlayer && speed > 5) this.player.crime('runOver', _v.set(x, this.heightAt(x, z), z));
      };
    });
  }

  private bodyChanged(body: RAPIER.RigidBody, len: number, w: number, mass: number, vehicle: boolean): void {
    this.traffic?.setPlayer(body, len, w, vehicle);
    this.rail?.setPlayer(body, len, w, mass);
    if (vehicle) this.d.city?.props.setPlayer(body);
  }

  /** Точка снаружи здания рядом: узел пешеходного графа или дороги. */
  private snap(p: THREE.Vector3): THREE.Vector3 {
    const g = this.ppl()?.graph;
    if (g) {
      const n = g.nearestNode(p.x, p.z, 150);
      if (n >= 0) return new THREE.Vector3(g.x[n], g.y[n], g.z[n]);
    }
    if (this.router) {
      const n = this.router.nearestNode(p.x, p.z, 300);
      if (n >= 0) return this.router.nodePos(n, new THREE.Vector3());
    }
    return p.clone();
  }

  /** Машина «игрока» (текущая или последняя): звук, HUD скорости, ночные фары. */
  get vehicle(): Vehicle { return this.player.car.vehicle; }
  get driving(): boolean { return this.player.driving; }
  get focus(): THREE.Vector3 { return this.player.focus; }

  /** Для пешеходов: машина игрока, когда он за рулём (иначе null). */
  playerCar(): PlayerCarState | null {
    if (!this.player.driving) return null;
    const v = this.player.car.vehicle, p = v.position, lv = v.body.linvel();
    _v.set(0, 0, -1).applyQuaternion(v.visual.quaternion);
    const l = Math.hypot(_v.x, _v.z) || 1;
    const s = this.pcs;
    s.x = p.x; s.y = p.y; s.z = p.z; s.vx = lv.x; s.vz = lv.z; s.fx = _v.x / l; s.fz = _v.z / l;
    s.halfLength = this.player.car.halfLen; s.halfWidth = this.player.car.halfW;
    return s;
  }

  /** Прочие движущиеся машины (полиция, брошенные катящиеся) — для пешеходов. */
  forEachOtherCar(fn: (id: number, x: number, y: number, z: number, vx: number, vz: number, fx: number, fz: number, hl: number, hw: number) => void): void {
    for (const c of this.fleet.cars) {
      if (c.driver === 'player') continue;
      const v = c.vehicle, lv = v.body.linvel();
      if (Math.hypot(lv.x, lv.z) < 1) continue;
      _v.set(0, 0, -1).applyQuaternion(v.visual.quaternion);
      const l = Math.hypot(_v.x, _v.z) || 1;
      fn(1_000_000 + c.id, v.position.x, v.position.y, v.position.z, lv.x, lv.z, _v.x / l, _v.z / l, c.halfLen, c.halfW);
    }
  }

  /** Препятствия для трафика: машины флота (кроме той, которой правит игрок — она «игрок» трафика) + внешние. */
  trafficObstacles(extra: readonly Obstacle[]): Obstacle[] {
    const out = this.obstacles;
    out.length = 0;
    let n = 0;
    const focus = this.player.focus;
    for (const c of this.fleet.cars) {
      if (c.driver === 'player') continue;
      const v = c.vehicle, p = v.position;
      if (Math.abs(p.x - focus.x) > 300 || Math.abs(p.z - focus.z) > 300) continue;
      const lv = v.body.linvel();
      _v.set(0, 0, -1).applyQuaternion(v.visual.quaternion);
      const l = Math.hypot(_v.x, _v.z) || 1;
      let o = this.obsPool[n];
      if (!o) this.obsPool.push((o = { x: 0, z: 0, vx: 0, vz: 0, fx: 0, fz: -1, halfLen: 2, halfW: 0.9 }));
      o.x = p.x; o.z = p.z; o.vx = lv.x; o.vz = lv.z; o.fx = _v.x / l; o.fz = _v.z / l; o.halfLen = c.halfLen; o.halfW = c.halfW;
      out.push(o); n++;
    }
    for (const o of extra) out.push(o);
    return out;
  }

  /** До шага физики: ввод. drive — ввод руля/педалей (Input.state + override). */
  preFrame(dt: number, drive: DriveInput): void {
    this.time += dt;
    this.shotT = Math.max(0, this.shotT - dt);
    const c = this.controls.read(dt);
    this.player.aimHeld = c.aim;
    this.player.preUpdate(dt, c, drive);
  }

  /** R пешком — перезарядка. */
  reload(): void {
    const inv = this.player.inv, w = inv.def;
    if (!w.melee && inv.slot.clip < w.mag && inv.slot.reserve > 0 && inv.reloadT <= 0) { inv.reloadT = w.reload; gameEvents.emit('reload', { weapon: w.id }); }
  }

  /** После шага физики. */
  postFrame(dt: number, time: number, alpha: number): void {
    const t0 = performance.now();
    const pl = this.player;
    pl.postUpdate(dt, alpha, time);
    this.checkVehicleHits();
    const pv: PlayerView = {
      pos: pl.focus, vel: this.playerVel(_v2), inCar: pl.driving ? pl.car : null, onFoot: !pl.driving, fighter: pl, alive: pl.alive,
    };
    this.police.update(dt, pv, this.d.camera, alpha);
    this.wanted.update(dt, this.police.seen, pl.focus);
    this.fleet.update(dt, pl.focus, pl.car);
    this.damage.update(dt, this.d.camera.position);
    this.pickups.update(dt, pl.onFoot ? pl.pos : null, (p) => pl.collect(p));
    this.effects.update(dt, this.d.camera, this.d.canvas.clientHeight || 1080);
    // подсказки
    pl.prompt = this.promptText();
    const inv = pl.inv;
    this.hud.update(dt, {
      money: pl.money, hp: pl.hp, armor: pl.armor, wanted: this.wanted.level, searching: this.wanted.searching,
      weapon: inv.current, clip: inv.slot.clip, reserve: inv.slot.reserve, reloading: inv.reloadT > 0,
      onFoot: !pl.driving, aiming: pl.aimHeld && !inv.def.melee, prompt: pl.prompt, bust: this.police.bustProgress, battery: pl.hudBattery(),
    });
    const hudEl = document.getElementById('hud');
    if (hudEl) hudEl.style.display = pl.driving ? '' : 'none';
    this.stats.ms = this.stats.ms * 0.9 + (performance.now() - t0) * 0.1;
  }

  private playerVel(out: THREE.Vector3): THREE.Vector3 {
    const pl = this.player;
    if (pl.driving) { const lv = pl.car.vehicle.body.linvel(); return out.set(lv.x, lv.y, lv.z); }
    return out.copy(pl.body.vel);
  }

  private promptText(): string {
    const pl = this.player;
    if (pl.driving) {
      if (this.damage.wrecked(pl.car.vehicle.body)) return '<b>F</b> — выйти';
      return pl.car.police ? '<b>G</b> — сирена' : '';
    }
    if (pl.state !== 'foot') return '';
    for (const fc of this.fleet.cars) {
      if (!fc.police || fc.trunkLooted) continue;
      const v = fc.vehicle;
      const trunk = _v.set(0, 0, fc.halfLen + 0.5).applyQuaternion(v.visual.quaternion).add(v.position);
      if (Math.hypot(trunk.x - pl.pos.x, trunk.z - pl.pos.z) < 1.6) return '<b>E</b> — открыть багажник ДПС';
    }
    const cand = this.fleet.findEnterable(pl.pos, 4);
    if (cand) {
      const verb = cand.traffic || (cand.car && cand.car.driver === 'ai') ? 'угнать' : cand.parked ? 'взломать и сесть' : 'сесть';
      return `<b>F</b> — ${verb}: ${cand.label}` + (pl.climbHint ? ' · ' + pl.climbHint : '');
    }
    if (pl.climbHint) return pl.climbHint;
    const ppl = this.ppl();
    if (ppl) {
      let near = false;
      ppl.forEachAgent(pl.pos.x, pl.pos.z, 1.8, (i, _x, _y, _z, _yaw, down) => { if (!down && !ppl.isKid(i)) near = true; });
      if (near) return '<b>E</b> — ограбить · <b>ЛКМ</b> — ударить';
    }
    return '';
  }

  /** Машины сбивают игрока пешком. */
  private checkVehicleHits(): void {
    const pl = this.player;
    if (!pl.hittable() || pl.state === 'down') return;
    const p = pl.pos;
    const test = (x: number, z: number, fx: number, fz: number, hl: number, hw: number, vx: number, vz: number): boolean => {
      const dx = p.x - x, dz = p.z - z;
      if (Math.abs(dx) > hl + 2 || Math.abs(dz) > hl + 2) return false;
      const lo = dx * fx + dz * fz, la = -dx * fz + dz * fx;
      if (Math.abs(lo) > hl + 0.35 || Math.abs(la) > hw + 0.35) return false;
      // сбивает только едущая машина и только скоростью сближения по нормали ближайшей грани OBB: стоящая/ползущая машина
      // (игрок сам в неё вбежал или трётся о борт) человека не роняет — раньше бралась |v машины − v игрока|, и бег/спринт
      // в борт стоящей машины (4.6–7.2 м/с > 3.5) валил игрока в рэгдолл
      if (Math.hypot(vx, vz) < 2.5) return false;
      const front = Math.abs(lo) - hl > Math.abs(la) - hw;
      const nx = front ? fx * Math.sign(lo) : -fz * Math.sign(la), nz = front ? fz * Math.sign(lo) : fx * Math.sign(la);
      const rel = (vx - pl.body.vel.x) * nx + (vz - pl.body.vel.z) * nz;
      if (rel < 3.5) return false;
      pl.hurt(rel * 2.2);
      if (pl.alive) pl.knockDown(_v.set(vx * 0.8, 2 + rel * 0.1, vz * 0.8));
      gameEvents.emit('punch', { x: p.x, y: p.y + 1, z: p.z, hit: true, kick: false, byPlayer: false });
      return true;
    };
    const t = this.traffic;
    if (t) for (const v of t.sim.vehicles) {
      if (v.crashed || Math.abs(v.y - p.y) > 3) continue;
      if (test(v.x, v.z, v.fx, v.fz, v.len / 2, v.halfW, v.fx * v.v, v.fz * v.v)) return;
    }
    for (const c of this.fleet.cars) {
      if (c.driver === 'player') continue;
      const veh = c.vehicle, vp = veh.position, lv = veh.body.linvel();
      if (Math.abs(vp.y - p.y) > 3) continue;
      _v.set(0, 0, -1).applyQuaternion(veh.visual.quaternion);
      const l = Math.hypot(_v.x, _v.z) || 1;
      if (test(vp.x, vp.z, _v.x / l, _v.z / l, c.halfLen, c.halfW, lv.x, lv.z)) return;
    }
  }

  /** Взрыв: люди падают, полицейские и игрок получают урон, соседние машины — урон/толчок, преступление (если машину подбил игрок). */
  private explosion(p: THREE.Vector3, r: number, power: number, body: RAPIER.RigidBody): void {
    const ppl = this.ppl();
    ppl?.forEachAgent(p.x, p.z, r * 1.5, (i, x, _y, z) => {
      const dx = x - p.x, dz = z - p.z, d = Math.hypot(dx, dz) || 1;
      const k = Math.max(0, 1 - d / (r * 1.5)) * 9 * power;
      ppl.strike(i, (dx / d) * k, 3 + k * 0.4, (dz / d) * k);
    });
    for (const f of [...this.combat.fighters]) {
      if (!f.hittable()) continue;
      const d = f.pos.distanceTo(p);
      if (d < r) f.takeHit(90 * (1 - d / r) * power, _v.subVectors(f.pos, p).setY(0).normalize(), 12, false, false);
    }
    if (this.player.driving && this.player.car.vehicle.position.distanceTo(p) < r && this.player.car.vehicle.body !== body) this.player.hurt(10);
    this.damage.blast(p, r, body);
    const t = this.traffic;
    if (t) for (const v of [...t.sim.vehicles]) {
      const d = Math.hypot(v.x - p.x, v.z - p.z);
      if (d > r) continue;
      const b = t.physics.crashVehicle(v);
      if (b) { const k = (1 - d / r) * b.mass() * 6; _q.identity(); b.applyImpulse({ x: (v.x - p.x) / (d || 1) * k, y: k * 0.6, z: (v.z - p.z) / (d || 1) * k }, true); }
      this.damage.damageTraffic(v.id, 60 * (1 - d / r));
    }
    const fc = this.fleet.byBody(body.handle);
    const byPlayer = (this.time - (this.playerHitAt.get(body.handle) ?? -1e9)) < 15;
    if (byPlayer) this.player.crime(fc?.police ? 'copCar' : 'explosion', p);
    if (fc?.police && byPlayer) this.wanted.report('copCar', p, true, 0);
  }

  /** Отладка (window.__game.gta): состояние, полиция, выдать оружие, звёзды, бессмертие. */
  // ------------------------------------------------------------------ наряд игрока
  /** Выбранный наряд (GUI / ?outfit=); зимой default сменяется на winter (робу не трогаем — пасхалка). */
  outfit: PlayerOutfit = 'default';
  private wornOutfit: PlayerOutfit | null = null;
  private winter = 0;
  private swapping = false;
  private wantedOutfit(): PlayerOutfit { return this.outfit === 'default' && this.winter >= 0.5 ? 'winter' : this.outfit; }
  /** Сезон одежды (main.ts: weather.winterClothes): 0 — осень/лето, ≥ 0.5 — зимний наряд. */
  setWinter(f: number): void { this.winter = f; this.applyOutfit(); }
  setOutfit(o: PlayerOutfit): void { this.outfit = o; this.applyOutfit(); }
  private applyOutfit(): void {
    const a = this.assets;
    if (!a || this.swapping || !this.wornOutfit) return; // ассеты не готовы или выбран ?player_char
    const want = this.wantedOutfit();
    if (want === this.wornOutfit || !this.player.canSwapRig()) return;
    this.swapping = true;
    const o = PLAYER_OUTFITS[want];
    this.player.swapRig(a, o.id, o.look).then(() => { if (this.player.rigId === o.id) this.wornOutfit = want; })
      .catch((e) => console.warn('[gta] наряд не загрузился:', e)).finally(() => { this.swapping = false; });
  }
  /** Debug GUI: папка «player» — наряд (default / robe / winter). */
  addPlayerGui(gui: { addFolder(n: string): { add(o: object, k: string, opts?: unknown): { name(n: string): { onChange(f: (v: string) => void): unknown } } } }): void {
    const st = { outfit: this.outfit as string };
    gui.addFolder('player').add(st, 'outfit', ['default', 'robe', 'winter']).name('outfit (?outfit=)').onChange((v: string) => this.setOutfit(v as PlayerOutfit));
  }

  debug() {
    return {
      state: () => ({ state: this.player.state, hp: Math.round(this.player.hp), armor: Math.round(this.player.armor), money: this.player.money, wanted: this.wanted.level,
        weapon: this.player.inv.current, ammo: [this.player.inv.slot.clip, this.player.inv.slot.reserve], car: this.player.car.kind,
        pos: this.player.focus.toArray().map((x) => +x.toFixed(1)), fleet: this.fleet.cars.map((c) => `${c.id}:${c.kind}:${c.driver}`), ms: +this.stats.ms.toFixed(2) }),
      police: () => this.police.debug(),
      give: (w: keyof typeof WEAPONS = 'pistol', ammo = 60) => this.player.giveWeapon(w, ammo),
      wanted: (l: number) => this.wanted.set(l),
      god: (on = true) => { this.player.god = on; },
      damage: () => this.damage.list(),
      carAt: (kind = 'sedan', dist = 6): FleetCar => {
        const p = this.player.focus;
        const yaw = this.orbit.yaw;
        const at = new THREE.Vector3(p.x - Math.sin(yaw) * dist, this.heightAt(p.x - Math.sin(yaw) * dist, p.z - Math.cos(yaw) * dist), p.z - Math.cos(yaw) * dist);
        return this.fleet.spawn(kind, 0x8e1a1a, at, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw + Math.PI / 2));
      },
    };
  }
}

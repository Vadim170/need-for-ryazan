import { loading } from './core/loading-screen'; // первым: обёртка fetch для полосы загрузки
import { registerOfflineCache } from './core/offline-cache';
import * as THREE from 'three';
import { GameLoop } from './core/loop';
import { Input } from './core/input';
import { createRenderer } from './render/renderer';
import { PhysicsWorld } from './physics/world';
import { buildTestWorld, SPAWN } from './world/test-world';
import { Vehicle } from './vehicle/vehicle';
import { loadLargusModel } from './vehicle/car-visual';
import { vehicleConfig } from './vehicle/config';
import { ChaseCamera, cameraConfig } from './camera/chase-camera';
import { GameAudio } from './audio/game-audio';
import { DebugPanel } from './debug/debug-panel';
import { Hud } from './hud/hud';
import { Minimap } from './hud/minimap';
import { CityWorld, tryFetchManifest, type SpawnPoint } from './world/city-world';
import type { DriveInput } from './core/input';
import { NightLights } from './render/night-lights';
import { WeatherSystem } from './render/weather-system';
import { addDayNightGui } from './render/day-night-gui';
import { People, playerFromCar, vehiclesFromTraffic } from './people';
import { pedestrianDensityCurve, trafficDensityCurve, headlightsWanted } from './render/time-of-day';
import { Traffic } from './traffic';
import { Rail, installTrackMaterials } from './rail';
import { VehicleLibrary, GltfTrafficLayer } from './traffic/gltf-models';
import { buildParkedCarDefs } from './world/parked-gltf';
import { Landmarks } from './world/landmarks';
import { GtaMode } from './player/gta';
import { WorldMap } from './hud/world-map';
import { FastTravel } from './world/fast-travel';

async function main() {
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  registerOfflineCache();
  loading.stage(0.08, 'Запуск физики…');
  const rc = createRenderer(canvas);
  const physics = await PhysicsWorld.create();
  loading.stage(0.3, 'Загрузка карты Рязани…');

  // --- выбор мира: ?world=test → тестовый; ?world=synthetic → /world-synthetic/; иначе /world/ с фолбэком на тестовый ---
  const params = new URLSearchParams(location.search);
  const worldParam = params.get('world');
  // glTF-машины (docs/stage2/models.md): манифест vehicles.json; ?vehicles=proc — только процедурные
  const vehLib = VehicleLibrary.load().catch((e) => { console.warn('[vehicles] манифест не загрузился:', e); return null; });
  let city: CityWorld | null = null;
  if (worldParam !== 'test') {
    const baseUrl = worldParam === 'synthetic' ? '/world-synthetic/' : '/world/';
    const manifest = await tryFetchManifest(baseUrl);
    if (manifest) {
      city = await CityWorld.create(manifest, { baseUrl }, physics, rc.scene, rc.envMap);
      if (params.get('rail') !== '0') installTrackMaterials(city.mats); // материалы путей — до загрузки тайлов (src/rail)
      rc.setFog(150, 720); // чуть дальше load radius (600 м), чтобы скрыть границу стриминга
      console.info(`[world] ${baseUrl}: ${manifest.tiles.length} tiles, ${manifest.spawnPoints.length} spawns`);
    } else if (worldParam) {
      console.warn(`[world] ${baseUrl}manifest.json not found, falling back to test world`);
    } else {
      console.info('[world] /world/manifest.json not found, using test world');
    }
  }
  if (!city) buildTestWorld(physics, rc.scene);

  // --- спавн ---
  const spawns: SpawnPoint[] = city?.spawnPoints ?? [];
  let spawnIdx = -1;
  const pickSpawn = (next: boolean): number => {
    if (!spawns.length) return -1;
    const q = params.get('spawn');
    if (!next && q !== null && q !== '') {
      if (Number.isFinite(+q)) return ((Math.trunc(+q) % spawns.length) + spawns.length) % spawns.length;
      const byName = spawns.findIndex((sp) => sp.name?.toLowerCase().includes(q.toLowerCase())); // ?spawn=пост ДПС
      if (byName >= 0) return byName;
    }
    let i = Math.floor(Math.random() * spawns.length);
    if (spawns.length > 1 && i === spawnIdx) i = (i + 1) % spawns.length;
    return i;
  };
  /** Контракт: heading — рад, 0 = смотрит на -Z (север), по часовой (к +X). Поворот вокруг +Y против часовой ⇒ yaw = -heading. */
  const spawnPose = (i: number) => {
    const sp = spawns[i];
    return { pos: new THREE.Vector3(sp.x, sp.y + 1.0, sp.z), yaw: -sp.heading };
  };
  spawnIdx = pickSpawn(false);
  const first = spawnIdx >= 0 ? spawnPose(spawnIdx) : null;
  loading.stage(0.4, 'Загрузка машин…');
  const lib = await vehLib; // парковке модели нужны до подгрузки тайлов
  if (city) city.props.addParkedCarModels(buildParkedCarDefs(lib, rc.envMap));
  loading.stage(0.97, 'Загрузка города вокруг…');
  if (city && first) await city.preload(first.pos, 250);
  // hero-модели (docs/stage2/landmarks.md): театр, цирк, памятники; ?landmarks=0 — выключить
  let landmarks: Landmarks | null = null;
  if (city && params.get('landmarks') !== '0') Landmarks.load(rc.scene, physics, (x, z) => city!.heightAt(x, z), rc.envMap).then((l) => { landmarks = l; (window as unknown as Record<string, unknown>).__landmarks = l; }).catch((e) => console.warn('[landmarks]', e));

  const car = new Vehicle(physics, vehicleConfig, first ? first.pos.clone() : SPAWN.clone());
  rc.scene.add(car.visual);
  city?.props.setPlayer(car.body); // удары по ломаемым пропсам (фонари, ограды…)
  // Модель Largus грузится асинхронно: пока едут коробки-заглушки; при ошибке (или ?car=box) заглушки остаются.
  if (params.get('car') !== 'box') {
    loadLargusModel({ envMap: rc.envMap }).then((m) => car.setModel(m)).catch((e) => console.warn('[car] Largus glb не загрузился, остаются коробки:', e));
  }
  if (first) car.reset(first.pos, first.yaw);
  const minimap = city ? new Minimap(city.graph) : null;
  // GTA-режим (src/player, src/combat, src/police; docs/stage3/gta-mode.md): пешком, угон, полиция; ?gta=0 — выключить
  const worldBase = worldParam === 'synthetic' ? '/world-synthetic/' : '/world/';
  const input = new Input();
  const gta = params.get('gta') !== '0'
    ? new GtaMode({ physics, scene: rc.scene, camera: rc.camera, canvas, input, envMap: rc.envMap, city, car, lib, baseUrl: worldBase,
      preload: async (p) => { if (city) await city.preload(p, 200); } })
    : null;
  /** Машина «игрока» (текущая или последняя): звук, спидометр, фары, погода. */
  const cur = () => (gta ? gta.vehicle : car);
  /** Точка интереса: машина или игрок пешком (стриминг, тени, пешеходы). */
  const focus = () => (gta ? gta.focus : car.position);
  if (minimap && gta) minimap.blips = (cb) => gta.police.forEachBlip((x, z, k) => cb(x, z, k === 'car' ? '#ff3b3b' : '#ff8a8a', k === 'car' ? 4 : 2.5, k === 'car'));
  // пешеходы (src/people, docs/stage2/people.md): граф грузится асинхронно; ?people=0 — выключить
  const people = city && params.get('people') !== '0'
    ? new People(worldParam === 'synthetic' ? '/world-synthetic/' : '/world/', rc.scene,
      { heightAt: (x, z) => city!.heightAt(x, z), player: gta ? () => gta.playerCar() : playerFromCar(car), maxAgents: Number(params.get('people')) || undefined, roads: city.graph, physics, obstacles: city.props })
    : null;
  if (people) gta?.attachPeople(people);
  // трафик и ОТ (src/traffic, docs/stage2/traffic.md): ?traffic=0 — выключить, ?traffic=N — потолок машин
  let traffic: Traffic | null = null;
  if (city && params.get('traffic') !== '0') {
    Traffic.create(worldParam === 'synthetic' ? '/world-synthetic/' : '/world/',
      { physics, scene: rc.scene, envMap: rc.envMap, player: { body: car.body, length: vehicleConfig.chassis.length, width: vehicleConfig.chassis.width }, heightAt: (x, z) => city!.heightAt(x, z) },
      { maxVehicles: Number(params.get('traffic')) || 600 })
      .then((t) => {
        traffic = t;
        if (!t) return;
        if (lib) { t.renderer.gltf = new GltfTrafficLayer(lib, t.sim.models, t.sim.opts.maxVehicles + 50, rc.envMap); t.renderer.root.add(t.renderer.gltf.root); }
        city!.props.setSignalSource(t.signals.propSource());
        // пешеходы: фазы светофоров и машины трафика (src/people)
        people?.setSignalSource((sj, se) => (sj && se ? t.signals.pedestrianWalk(sj, se) : null));
        if (people) t.setPedestrianSource((x, z, r, fn) => people.system?.forEachNear(x, z, r, fn));
        people?.setTrafficSource({ forEachCar: (fn) => { for (const v of t.sim.vehicles) fn(v.x, v.z, v.fx * v.v, v.fz * v.v); } });
        const vs = vehiclesFromTraffic(t);
        people?.setVehicleSource(gta ? (fn) => { vs(fn); gta.forEachOtherCar(fn); } : vs); // машины трафика (и полиция, брошенные) пугают и сбивают пешеходов
        gta?.attachTraffic(t);
        if (minimap) minimap.traffic = (cb) => t.forEachDot(cb);
        (window as unknown as { __game: Record<string, unknown> }).__game.traffic = t.debug();
        (window as unknown as { __game: Record<string, unknown> }).__game.trafficSystem = t;
      })
      .catch((e) => console.warn('[traffic] не запустился:', e));
  }
  // железная дорога (src/rail, docs/stage2/rail.md): поезда, переезды, контактная сеть; ?rail=0 — выключить
  let rail: Rail | null = null;
  if (city && params.get('rail') !== '0') {
    Rail.create(worldParam === 'synthetic' ? '/world-synthetic/' : '/world/',
      { physics, scene: rc.scene, envMap: rc.envMap, player: { body: car.body, length: vehicleConfig.chassis.length, width: vehicleConfig.chassis.width, mass: vehicleConfig.chassis.mass } })
      .then((r) => {
        rail = r;
        if (!r) return;
        gta?.attachRail(r);
        if (minimap) minimap.rail = { lines: r.trackLines(), trains: (cb) => r.forEachTrain(cb) };
        (window as unknown as { __game: Record<string, unknown> }).__game.rail = r.debug();
      })
      .catch((e) => console.warn('[rail] не запустилась:', e));
  }

  if (params.get('carshow')) { // витрина процедурных машин (docs/stage3/procedural-cars.md)
    import('./vehicles/procedural/carshow').then(({ installCarShow }) => {
      (window as unknown as { __game: Record<string, unknown> }).__game.carshow = installCarShow(rc, new THREE.Vector3(car.position.x, car.position.y + 40, car.position.z - 20));
    }).catch((e) => console.warn('[carshow]', e));
  }
  let audioSeason: 'summer' | 'winter' | '' = '';
  const audio = new GameAudio(physics); // звук (src/audio, docs/stage2/audio.md): старт по первому жесту, M — mute
  input.onGesture(() => void audio.start());
  const chase = new ChaseCamera(rc.camera, cameraConfig, (x, z) => physics.groundHeightAt(x, z));
  const hud = new Hud();
  const vol = { v: 0.7 };
  const debug = new DebugPanel(vehicleConfig, cameraConfig, {
    audioVolume: vol,
    onVolume: (v) => audio.setVolume(v),
    onReset: () => cur().reset(),
  });
  const teleport = (next: boolean) => {
    spawnIdx = pickSpawn(next);
    if (spawnIdx < 0) return;
    const p = spawnPose(spawnIdx);
    if (gta && !gta.driving) { gta.player.teleport(p.pos); return; }
    cur().reset(p.pos, p.yaw);
    chase.snap();
  };
  const nightLights = new NightLights(rc.scene);
  addDayNightGui(debug.gui, rc.dayNight, nightLights, rc.post);
  // погода и сезоны (render/weather-system.ts, docs/stage3/weather-seasons.md): ?weather=rain, ?season=winter, O / I
  const weather = new WeatherSystem({ rc, player: () => cur(), heightAt: city ? (x, z) => city!.heightAt(x, z) : undefined, audio, nightLights });
  weather.addGui(debug.gui);
  gta?.addPlayerGui(debug.gui); // наряд игрока: default / robe / winter
  audio.addGui(debug.gui);
  const override: { v: Partial<DriveInput> | null } = { v: null };
  const fwd = new THREE.Vector3();

  // карта мира (M) + быстрый переезд кликом (public/world-map, pipeline/build_map.py; docs/world-format.md)
  const mapFwd = new THREE.Vector3();
  const heading = (v: THREE.Vector3) => Math.atan2(v.x, -v.z); // курс: рад, по часовой от севера
  const travel = city ? new FastTravel({
    city, physics, driving: () => !gta || gta.driving,
    placeCar: (pos, yaw) => { cur().reset(pos, yaw); chase.snap(); },
    placeFoot: (pos) => { if (gta) { gta.player.teleport(pos); gta.orbit.snap(); } },
    walkGraph: () => people?.system?.graph ?? null,
  }) : null;
  const worldMap = city && travel ? new WorldMap({
    graph: city.graph, roads: travel.roads, spawns, worldBase,
    player: () => {
      const p = focus();
      if (!gta || gta.driving) mapFwd.set(0, 0, -1).applyQuaternion(cur().visual.quaternion); else rc.camera.getWorldDirection(mapFwd);
      return { x: p.x, z: p.z, heading: heading(mapFwd) };
    },
    parkedCar: () => {
      if (!gta || gta.driving) return null;
      const v = gta.vehicle;
      mapFwd.set(0, 0, -1).applyQuaternion(v.visual.quaternion);
      return { x: v.position.x, z: v.position.z, heading: heading(mapFwd) };
    },
    onTravel: (x, z) => { void travel.go(x, z); },
    preview: (x, z) => { const t = travel.resolve(x, z); return { x: t.x, z: t.z }; },
    onWaypoint: (wp) => { if (minimap) minimap.waypoint = wp; },
  }) : null;

  const frame = (dt: number, time: number) => {
    debug.stats.begin();
    input.update(dt);
    if (worldMap && travel) { // карта мира (M) и быстрый переезд: игра на паузе, мир только стримится
      if (input.consume('KeyM') && !travel.busy) worldMap.toggle();
      if (worldMap.open || travel.busy) {
        worldMap.update(dt);
        if (city) city.update(travel.focus ?? focus(), dt);
        input.flush();
        debug.stats.end();
        return;
      }
    }
    const driving = !gta || gta.driving;
    if (input.consume('KeyR')) { if (driving) { cur().reset(); chase.snap(); } else gta!.reload(); } // пешком R — перезарядка
    if (input.consume('KeyT')) teleport(true);
    if (gta) gta.preFrame(dt, { ...input.state, ...override.v }); // GTA-режим сам раздаёт ввод машине игрока / пешеходу
    else Object.assign(car.input, input.state, override.v);

    physics.update(dt);
    if (!gta) car.updateVisual(); // GTA-режим: колёса всех машин флота — в gta.postFrame
    const fp = focus(), cv = cur();
    if (city) {
      city.update(fp, dt);
      // страховка: провал под рельеф (например, тайл с коллайдерами ещё не успел загрузиться) — вернуть на поверхность
      const gh = city.heightAt(cv.position.x, cv.position.z);
      if (driving && cv.position.y < gh - 15) cv.reset(new THREE.Vector3(cv.position.x, gh + 2, cv.position.z));
      if (driving) fwd.set(0, 0, -1).applyQuaternion(cv.visual.quaternion); else rc.camera.getWorldDirection(fwd);
      minimap?.update(dt, fp, fwd.x, fwd.z);
    }

    if (gta) gta.postFrame(dt, time, physics.timestep.alpha); // игрок пешком, полиция, бой, HUD (камера пешком — внутри)
    if (gta?.driving ?? true) chase.update(dt, cv, input.lookBack, time);
    if (input.consume('BracketLeft')) rc.dayNight.clock.shift(-1);
    if (input.consume('BracketRight')) rc.dayNight.clock.shift(1);
    rc.update(dt, fp);
    nightLights.update(dt, cv, city?.props ?? null);
    landmarks?.update(fp, dt);
    city?.props.update(rc.camera, fp, dt);
    if (people) { people.setDensityFactor(pedestrianDensityCurve(rc.dayNight.clock.hour) * weather.pedestrianFactor); people.setWinter(weather.winterClothes); people.update(dt, fp, rc.camera); if (people.system && !people.system.onShout) people.system.onShout = (i, who, kind, x, y, z, yaw) => audio.shout(i, who, kind, x, y, z, yaw); }
    gta?.setWinter(weather.winterClothes); // наряд игрока по сезону (src/player/gta.ts)
    { const s = weather.winterClothes >= 0.5 ? 'winter' : 'summer'; if (s !== audioSeason) { audioSeason = s; audio.setSeason(s); } } // снег/каша под колёсами и шагами
    if (traffic) {
      traffic.setDensityFactor(trafficDensityCurve(rc.dayNight.clock.hour));
      traffic.setHeadlights(headlightsWanted(traffic.headlights));
      traffic.update(dt, rc.camera);
      if (gta) traffic.extraObstacles = gta.trafficObstacles(rail?.crossingObstacles ?? []); // брошенные машины, полиция + переезды
      else if (rail && traffic.extraObstacles !== rail.crossingObstacles) traffic.extraObstacles = rail.crossingObstacles; // закрытые переезды
    }
    rail?.update(dt, rc.camera);

    if (input.consume('KeyN')) audio.toggleMuteFromKey();
    if (input.consume('KeyH')) audio.horn();
    audio.update(dt, {
      car: cv, camera: rc.camera, hour: rc.dayNight.clock.hour, inCity: !!city, traffic, rail,
      trafficDensity: trafficDensityCurve(rc.dayNight.clock.hour), pedDensity: pedestrianDensityCurve(rc.dayNight.clock.hour),
      pedestriansNear: people ? (x, z, r) => { let n = 0; people.system?.forEachNear(x, z, r, () => { n++; }); return n; } : undefined,
      onFoot: gta ? !gta.driving : false, focus: fp, sirens: gta ? () => gta.police.sirens() : undefined,
    });
    hud.update(cv, cv.cfg.engine.redlineRpm);

    if (traffic && weather.traffic !== traffic) weather.attachTraffic(traffic);
    weather.update(dt);
    rc.post.setCar(cv.position); // машину игрока не размывать (motion blur)
    rc.render(dt);
    const ri = rc.renderer.info.render;
    debug.setInfo(`draw calls ${ri.calls}\ntriangles ${(ri.triangles / 1000).toFixed(0)}k` + (city
      ? `\ntiles ${city.stats.tilesLoaded} (+${city.stats.tilesLoading})\ncollider tris ${(city.stats.colliderTriangles / 1000).toFixed(1)}k` +
        `\nprops ${(city.props.stats.drawn / 1000).toFixed(1)}k/${(city.props.stats.instances / 1000).toFixed(1)}k  rebuild ${city.props.stats.rebuildMs.toFixed(1)}ms` +
        `\nprop colliders ${city.props.stats.colliders}\nspawn #${spawnIdx}  T=next` + (people?.info() ?? '') : ''));
    debug.stats.end();
  };
  const loop = new GameLoop(frame);
  loop.start();
  loading.finish();

  // handy for console / automated checks
  (window as unknown as Record<string, unknown>).__game = { car, physics, rc, input, THREE, vehicleConfig, city, frame, override, teleport, spawns, worldMap, travel, dayNight: rc.dayNight, nightLights, people, audio, weather: weather.debug(), gta: gta ? Object.assign(gta.debug(), { mode: gta, ctl: gta.controls, events: gta.events, police: gta.police, player: gta.player, fleet: gta.fleet }) : null };
}

main().catch((e) => {
  console.error(e);
  loading.fail();
  const el = document.getElementById('err')!;
  el.style.display = 'flex';
  el.textContent = String(e?.stack ?? e);
});

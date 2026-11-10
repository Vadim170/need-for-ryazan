# Credits

## Lada Largus (машина игрока)
This work is based on "Lada Largus" (https://sketchfab.com/3d-models/lada-largus-ef5fd62d01ca49f1bd70bb596456c144) by usolakolya (https://sketchfab.com/usolakolya) licensed under CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/)

Изменения: удалены интерьер-механика, двигатель, багажник на крыше и вторая копия модели; масштаб приведён к реальным размерам;
сделаны новые колёса (шина 205/45 R17, графитовый диск), посадка кузова −40 мм, спойлер, двойной выхлоп, переименованные материалы;
сжатие meshopt. Файлы: `public/assets/vehicles/largus/` (копия license.txt рядом). Скрипты: `assets/scripts/build_largus.py`.

## Машины трафика и парковки (glTF, docs/stage2/models.md)
- **Lada Largus (трафик/парковка)** — та же модель usolakolya (CC BY 4.0, см. выше), упрощена до ~12k/1.6k треугольников,
  материалы запечены в атлас. Файлы: `public/assets/vehicles/lada_largus/`.
- **UAZ-452 «буханка» (парковка)** — "UAZ-452 Utility Van Lowpoly" by Mehozavr (https://opengameart.org/users/mehozavr),
  https://opengameart.org/content/uaz-452-utility-van-lowpoly, CC0 1.0 (атрибуция не обязательна, указана из уважения).
  Изменения: удалены номера, текстуры запечены в атлас, LOD1. Файлы: `public/assets/vehicles/uaz452/`.
- Полный список с лицензиями — поля `license/author/url` в `public/assets/vehicles/vehicles.json`; каталог кандидатов
  (ожидают токен Sketchfab) — `assets/catalog/vehicles.json`.

## Люди / People (пешеходы, `public/assets/people/`)

**Персонажи** собраны из ассетов MakeHuman с помощью MPFB2 (Blender extension, v2.0.18, GPL-код; сгенерированные модели — CC0,
см. https://static.makehumancommunity.org/mpfb/faq/can_i_sell_models.html). Все использованные ассеты — **CC0 1.0**
(https://creativecommons.org/publicdomain/zero/1.0/), лицензия проверена по странице пакета и метаданным ассета:

- MakeHuman system assets (CC0; Data Collection AB, Joel Palmius, Jonas Hauquier — освобождено в CC0 в 2020):
  базовый меш hm08, прокси-топология `proxy741`, кожа (young/middleage/old caucasian male/female), волосы `short01–04`,
  `bob02`, `ponytail01`, `long01`, `braid01`, одежда `male_casualsuit01/03/05`, `male_elegantsuit01`, `female_elegantsuit01`,
  обувь `shoes01–06`, шляпы `fedora01`, `fedora_cocked`. Пакет: https://static.makehumancommunity.org/assets/assetpacks/makehuman_system_assets.html
- Пакет **Suits 01** (CC0) — Margaret Toigo (MargaretToigo / MRT): `toigo_male_suit_3`, `toigo_male_double-breasted_suit`,
  `toigo_male_suit_tie_and_jacket`, `toigo_female_suit`, `toigo_female_suit_2`, `toigo_female_double-breasted_suit`.
- Пакет **Shirts 01** (CC0) — Margaret Toigo: `toigo_fisherman_sweater`.
- Пакет **Pants 01** (CC0) — Margaret Toigo: `toigo_wool_pants`; Cortu (Cortu Johnstone): `cortu_cargo_pants`.
- Пакет **Skirts 01** (CC0) — Margaret Toigo: `toigo_long_full_skirt`, `toigo_tiered_skirt`.
- Пакет **Dress 01** (CC0) — Margaret Toigo: `toigo_halter_dress_knee_length`.
- Пакет **Gloves 01** (CC0) — Margaret Toigo: `toigo_gloves_short`.
- Пакет **Shoes 01** (CC0) — Margaret Toigo: `toigo_ankle_boots_female`, `toigo_ankle_boots_male`; culturalibre:
  `culturalibre_heroine_boots_1`, `culturalibre_heroine_boots_2`.
- Пакет **Hats 01** (CC0) — Joel Palmius: `joepal_xmas_cap` (перекрашена в вязаную шапку); AEthelraed_Unraed: `aethelraed_unraed_cloche_hat`.

Пакеты: https://static.makehumancommunity.org/assets/assetpacks.html (файлы `files.makehumancommunity.org/asset_packs/<pack>/<pack>_cc0.zip`).
Шарф — собственная геометрия (генерируется `build_character.py`). Изменения: прокси-тело без закрытых одеждой частей, прореживание (LOD0 4–6 тыс., LOD1 ~800 треугольников), 23 кости вместо 31,
атлас 1024×512 на персонажа (одежда обесцвечена для перекраски в игре), WebP + meshopt. Скрипты: `assets/scripts/people/`.

**Анимации** — CMU Graphics Lab Motion Capture Database, http://mocap.cs.cmu.edu/ («free for use in research and commercial
projects worldwide»), в BVH-конвертации Bruce Hahne (cgspeed, «MotionBuilder-friendly», 2010; без дополнительных ограничений),
копия: https://github.com/una-dinosauria/cmu-mocap. Клипы: 111_28 (стоит), 08_01 (идёт), 16_35 (бежит), 114_05 (сидит),
18_08 (разговор), 80_25 (телефон), 80_48 (спор, «сердится»), 79_74 (испуг, «отпрыгивает»), 139_18 (подъём с земли со спины), 140_01 (подъём лицом вниз); «лежит» — синтетическая поза.
Изменения: ретаргет на скелет MakeHuman, на месте, зацикливание, 30 fps.
Цитата по просьбе CMU: *The data used in this project was obtained from mocap.cs.cmu.edu. The database was created with funding from NSF EIA-0196217.*

## Звук (`public/assets/audio/`, docs/stage2/audio.md)

Все звуки — записи с freesound.org (публичные HQ-превью, лицензия проверена на странице каждого звука; метаданные —
`assets/audio/sources/<категория>/<id>/meta.json`). Изменения: нарезка, фильтрация, нормализация громкости, бесшовные лупы;
записи двигателей разобраны на лупы по оборотам с выравниванием высоты тона (`assets/scripts/audio/build_engine.py`),
кодирование AAC. Карта звуковых зон построена из данных OpenStreetMap (© участники OpenStreetMap, ODbL).

**CC BY (атрибуция обязательна):**
- "Cars_driving_slush_road.wav" by Zabuhailo — https://freesound.org/people/Zabuhailo/sounds/190997/ — CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Использование: slush.
- "FR-S BRZ GT-86 Vortech Supercharged Dyno Run" by dezoris — https://freesound.org/people/dezoris/sounds/191194/ — CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Использование: банк двигателя «aggressive».
- "Gear shifts and other noises - Toyota Verso Interior" by JaimeLopes — https://freesound.org/people/JaimeLopes/sounds/442766/ — CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Использование: shift, shift_2.
- "Orthodox church bell ringing_2.Close(Eq).wav" by newlocknew — https://freesound.org/people/newlocknew/sounds/592873/ — CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Использование: bells.
- "Sports Car Accelerating/Speeding Up Fast - Exhaust" by EvanBoyerman — https://freesound.org/people/EvanBoyerman/sounds/754775/ — CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Использование: банк двигателя «velvet».
- "Sports Car Accelerating/Speeding Up Medium - Exhaust" by EvanBoyerman — https://freesound.org/people/EvanBoyerman/sounds/754776/ — CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Использование: банк двигателя «velvet».
- "Car Starting/Ignition On and Off with Idle - Exhaust Mic" by EvanBoyerman — https://freesound.org/people/EvanBoyerman/sounds/754779/ — CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Использование: start, банк двигателя «velvet».
- "Car Accelerating Slowly and Decelerating 1 (Engine and Exhaust Mix)" by EvanBoyerman — https://freesound.org/people/EvanBoyerman/sounds/755996/ — CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Использование: банк двигателя «velvet».
- "Car Accelerating Slowly and Decelerating 2 (Engine and Exhaust Mix)" by EvanBoyerman — https://freesound.org/people/EvanBoyerman/sounds/755997/ — CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Использование: банк двигателя «velvet».
- "Car Accelerating Slowly and Maintaining Speed (Engine and Exhaust Mix)" by EvanBoyerman — https://freesound.org/people/EvanBoyerman/sounds/755998/ — CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Использование: банк двигателя «velvet».

**CC0 1.0** (атрибуция не обязательна, указана из уважения):
- "tires_snow_ice_slow.wav" by dunebuggy — https://freesound.org/people/dunebuggy/sounds/71099/ (snow_tires)
- "Chrysler LHS tire squeal 04 (04-25-2009).wav" by audible-edge — https://freesound.org/people/audible-edge/sounds/71739/ (tire_squeal)
- "Wind-inside car-091007.wav" by ra_gun — https://freesound.org/people/ra_gun/sounds/82267/ (wind)
- "BACKFIRE.ogg" by CeebFrack — https://freesound.org/people/CeebFrack/sounds/105351/ (backfire)
- "auto5.wav" by escortmarius — https://freesound.org/people/escortmarius/sounds/141459/ (банк двигателя «stock»)
- "Clank Car Crash Collision" by qubodup — https://freesound.org/people/qubodup/sounds/151624/ (impact_metal_1)
- "two_jet_engines.wav" by minian89 — https://freesound.org/people/minian89/sounds/152540/ (nitro_rush)
- "car park skiding corner.wav" by martian — https://freesound.org/people/martian/sounds/178889/ (tire_skid)
- "Playground for children in Romania" by felix.blume — https://freesound.org/people/felix.blume/sounds/238549/ (amb_kids)
- "WRX - Exhaust sounds" by ulose2piranha — https://freesound.org/people/ulose2piranha/sounds/273334/ (банк двигателя «aggressive»)
- "Fast Collision" by qubodup — https://freesound.org/people/qubodup/sounds/332056/ (impact_metal_2)
- "Collision" by qubodup — https://freesound.org/people/qubodup/sounds/332058/ (impact_metal_3)
- "Hard Rain on Car Roof.wav" by eRobb4 — https://freesound.org/people/eRobb4/sounds/344460/ (rain_roof)
- "J1_Car_Horn.mp3" by Iamgiorgio — https://freesound.org/people/Iamgiorgio/sounds/371833/ (horn)
- "Light rain on street.wav" by BonnyOrbit — https://freesound.org/people/BonnyOrbit/sounds/380651/ (rain_street)
- "S022_Plastic_Impact_Mono.wav" by Pól — https://freesound.org/people/P%C3%B3l/sounds/385940/ (impact_plastic)
- "siren ambulance european distant echo nice with steps to clean.wav" by kyles — https://freesound.org/people/kyles/sounds/451068/ (siren_1)
- "bus coach ext diesel truck engine idle throaty.flac" by kyles — https://freesound.org/people/kyles/sounds/453415/ (bus_idle)
- "traffic roar nearby or distant country road stereo left heavy.flac" by kyles — https://freesound.org/people/kyles/sounds/454255/ (amb_roar)
- "bus coach ext pull up brake air release idle.wav" by kyles — https://freesound.org/people/kyles/sounds/454420/ (air_brake_2)
- "Air (or steam) pressure release" by brunoboselli — https://freesound.org/people/brunoboselli/sounds/457294/ (nitro_purge)
- "Early Summer Morning Ambience with Birds, Berlin" by Pfannkuchn — https://freesound.org/people/Pfannkuchn/sounds/457616/ (amb_birds)
- "thunder 5 dry.wav" by elmoustachio — https://freesound.org/people/elmoustachio/sounds/476739/ (thunder)
- "MGB at exhaust start drive shift.flac" by sv650nut — https://freesound.org/people/sv650nut/sounds/488956/ (банк двигателя «stock»)
- "Rocket Thrust 02" by LilMati — https://freesound.org/people/LilMati/sounds/515122/ (nitro_body)
- "Car Horn.wav" by DuranBurrus — https://freesound.org/people/DuranBurrus/sounds/547667/ (horn_2)
- "car alarm.wav" by Dienamyte — https://freesound.org/people/Dienamyte/sounds/548470/ (car_alarm)
- "200829 Sirens, distant, ambulence, police, urban echoes roof, stops 9am.flac" by TRP — https://freesound.org/people/TRP/sounds/568814/ (siren_2)
- "Wind in trees autumn leaves rustle weird howls med 77mel 191122.mp3" by TRP — https://freesound.org/people/TRP/sounds/574553/ (amb_trees)
- "Train Horn 71 (Distant, Clean).mp3" by FunWithSound — https://freesound.org/people/FunWithSound/sounds/591873/ (train_horn)
- "Car Crash (with Glass)" by magnuswaker — https://freesound.org/people/magnuswaker/sounds/592388/ (impact_crash)
- "leipzig city ​​atmo with cars tram and people" by Garuda1982 — https://freesound.org/people/Garuda1982/sounds/612854/ (amb_street)
- "Distant construction site, Electric saw, City traffic - EXT/DAY - Amb Atmo - ST 48K24b" by tferrino — https://freesound.org/people/tferrino/sounds/613176/ (amb_construction)
- "dog-distant barking.wav" by alberto59 — https://freesound.org/people/alberto59/sounds/615258/ (dogs_2)
- "AMB CITY DAWN DISTANT TRAFFIC BIRDS" by tferrino — https://freesound.org/people/tferrino/sounds/631479/ (amb_dawn)
- "Train, medium speed, heavy, passing by.wav" by golovlev.sound — https://freesound.org/people/golovlev.sound/sounds/631590/ (train_rumble)
- "factory ambience industrial pump room hum with PA announcement heavy echo and pump turn on start.flac" by kyles — https://freesound.org/people/kyles/sounds/637521/ (amb_industry)
- "Fire Extinguisher" by tranzfusion — https://freesound.org/people/tranzfusion/sounds/642961/ (nitro_pssh)
- "Trackless Trolley.wav" by nomerodin1 — https://freesound.org/people/nomerodin1/sounds/652360/ (trolley)
- "Turbo Spooling and Blow Off.WAV" by EwanPenman11 — https://freesound.org/people/EwanPenman11/sounds/659544/ (bov)
- "Diesel Locomotive Horn - 2300 Class.wav" by JotrainG — https://freesound.org/people/JotrainG/sounds/662553/ (train_horn_2)
- "City ambiance in a residential area, with city hum, road far away, some birds singing, slight windchimes bell at a distance, recorded in the morning in Dekalb, Illinois" by felix.blume — https://freesound.org/people/felix.blume/sounds/667218/ (amb_city)
- "Whoosh stereo light (transition)" by xkeril — https://freesound.org/people/xkeril/sounds/701104/ (nitro_on)
- "Impact on metal" by JoMungus — https://freesound.org/people/JoMungus/sounds/726486/ (impact_metal_4)
- "Glass panel shattering" by LukaCafuka — https://freesound.org/people/LukaCafuka/sounds/758207/ (impact_glass_2)
- "SFX-Crows,01Jan2021-1515h,Tallinn" by soundandmelodies — https://freesound.org/people/soundandmelodies/sounds/776151/ (amb_crows)
- "AMB-Night,Quiet,DistantTraffic,Lisbon,Portugal" by soundandmelodies — https://freesound.org/people/soundandmelodies/sounds/776263/ (amb_night)
- "Car_Door_Closing_Dull_04" by BlondPanda — https://freesound.org/people/BlondPanda/sounds/778421/ (thump)
- "Three People Walking on Concrete – Group Footsteps" by ZackSoundLab — https://freesound.org/people/ZackSoundLab/sounds/789609/ (footsteps)
- "Car Interior, Driving on Highway, Wet Pavement, with Slow Acceleration at Beginning and Abrupt Stop at End" by bmacphail — https://freesound.org/people/bmacphail/sounds/795866/ (road)
- "Car Antilag (No cleanup, 32float)" by modusmogulus — https://freesound.org/people/modusmogulus/sounds/797835/ (crackle_1, crackle_2)
- "air brake sound effect" by okpato123 — https://freesound.org/people/okpato123/sounds/801435/ (air_brake)
- "Distant Dogs" by IENBA — https://freesound.org/people/IENBA/sounds/820267/ (dogs_1)
- "Hard Glass Break 2" by ElevatorFan2020 — https://freesound.org/people/ElevatorFan2020/sounds/861043/ (impact_glass_1)
- "Walla_In_Madrid_Spain" by SignatureSoundsOrg — https://freesound.org/people/SignatureSoundsOrg/sounds/869048/ (amb_crowd)
- "Bells of the Church of St. Peter & Paul (Crkva Svetog Petra i Pavla)" by SignatureSoundsOrg — https://freesound.org/people/SignatureSoundsOrg/sounds/870015/ (bells_2)

## PBR-текстуры мира (`public/assets/textures/`, docs/stage3/realism.md)

Все текстуры — **Poly Haven** (https://polyhaven.com), лицензия **CC0 1.0** (https://polyhaven.com/license; атрибуция не обязательна, указана из уважения).
Изменения: приведение к 1024², упаковка AO/шероховатость/высота в один ORM-слой, сжатие KTX2 (Basis UASTC + Zstandard) в массивы текстур.
Скрипт: `scripts/build-textures.mjs` (кэш исходников — `data/raw/textures/`).

- "Asphalt 02" by Rob Tuytel — https://polyhaven.com/a/asphalt_02 — CC0 1.0
- "Clean Asphalt" by Dimitrios Savva — https://polyhaven.com/a/clean_asphalt — CC0 1.0
- "Tarred Gravel" by Dimitrios Savva — https://polyhaven.com/a/tarred_gravel — CC0 1.0
- "Rough Concrete" by Dimitrios Savva — https://polyhaven.com/a/rough_concrete — CC0 1.0
- "Concrete Wall 006" by Dario Barresi, Charlotte Baglioni — https://polyhaven.com/a/concrete_wall_006 — CC0 1.0
- "Forest Ground 01" by Rob Tuytel — https://polyhaven.com/a/forrest_ground_01 — CC0 1.0
- "Leafy Grass" by Charlotte Baglioni — https://polyhaven.com/a/leafy_grass — CC0 1.0
- "Park Dirt" by Christopher Melani — https://polyhaven.com/a/park_dirt — CC0 1.0
- "Gravel Stones" by Amal Kumar — https://polyhaven.com/a/gravel_stones — CC0 1.0
- "Red Brick 03" by Rob Tuytel — https://polyhaven.com/a/red_brick_03 — CC0 1.0
- "White Bricks" by Rob Tuytel — https://polyhaven.com/a/white_bricks — CC0 1.0
- "Painted Plaster Wall" by Amal Kumar — https://polyhaven.com/a/painted_plaster_wall — CC0 1.0
- "White Stucco 02" by Dimitrios Savva — https://polyhaven.com/a/white_stucco_02 — CC0 1.0
- "Corrugated Iron" by Jenelle van Heerden, Dimitrios Savva — https://polyhaven.com/a/corrugated_iron — CC0 1.0
- "Asbestos Sheet 02" by Amal Kumar — https://polyhaven.com/a/asbestos_sheet_02 — CC0 1.0
- "Box Profile Metal Sheet" by Amal Kumar — https://polyhaven.com/a/box_profile_metal_sheet — CC0 1.0
- "Green Metal Rust" by Rob Tuytel — https://polyhaven.com/a/green_metal_rust — CC0 1.0
- "Rusty Metal 02" by Rob Tuytel — https://polyhaven.com/a/rusty_metal_02 — CC0 1.0
- "Painted Metal Shutter" by Dario Barresi, Rico Cilliers, Charlotte Baglioni — https://polyhaven.com/a/painted_metal_shutter — CC0 1.0
- "Wood Plank Wall" by Dimitrios Savva — https://polyhaven.com/a/wood_plank_wall — CC0 1.0
- "Bark Willow" by Dario Barresi, Dimitrios Savva — https://polyhaven.com/a/bark_willow — CC0 1.0
- "Pine Bark" by Dimitrios Savva — https://polyhaven.com/a/pine_bark — CC0 1.0

Атлас листвы, импостеры деревьев и интерьеры за окнами генерируются процедурно (canvas/шейдер), внешних ассетов нет.
Транскодер Basis Universal (`public/assets/basis/`) — из three.js (Apache-2.0, © Binomial LLC).

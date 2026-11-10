# Каталог ассетов и звуков (Этап 0)

Дата исследования: 2026-10-13. Метки: **[проверено]** — данные получены из API/страницы во время исследования; **[не проверено]** — из общих знаний или результатов поиска, перед использованием перепроверить.

Что НЕ делалось: скачивание моделей. Sketchfab Download API возвращает `401` без аккаунта/токена (проверено на `/v3/models/<uid>/download`), а регистрироваться запрещено. Поэтому полигоны/вершины ниже взяты из метаданных поиска (`faceCount`, `vertexCount`), а наличие интерьера, PBR-текстур и формат файла — **не проверены** (смотреть в 3D-просмотрщике на странице модели; формат выдачи у Sketchfab для скачиваемых моделей обычно glTF/USDZ/исходник — [не проверено]). `assets/candidates/` не создавалась: качать нечего без входа.

Лицензии: Sketchfab CC BY — нужна атрибуция (автор + ссылка), CC BY-NC — только некоммерческое (для личного проекта допустимо, но блокирует любую публикацию), "Free Standard" — собственная лицензия Sketchfab (не CC; читать условия). Атрибуции вести в `assets/CREDITS.md` (рекомендация).

Формат ссылок Sketchfab: `https://sketchfab.com/3d-models/none-<uid>` (рабочий, редиректит на модель). Ниже даны так.

---

## 1. Машина игрока: Lada Largus (тюнингованная)

Контекст: Largus 2012+ (Россия) — это Dacia/Renault Logan MCV первого поколения (2006–2013) с российской оптикой/бамперами/решёткой Lada. Значит, Logan MCV — допустимая база для кузова, если переделать перед/зад.

Поиск по Sketchfab API (`q=lada largus`, `largus`, `лада ларгус`, `dacia logan mcv`, `renault logan mcv`, `logan mcv`; и downloadable=true, и false) **[проверено]**. Кандидаты:

| # | Модель | Автор | Лицензия | Faces / Verts | Скач. | Прим. |
|---|---|---|---|---|---|---|
| 1 | [Lada Largus](https://sketchfab.com/3d-models/none-7f138359ee354b208e9eeae42c2b47b3) | Quore | CC BY-NC | 300k / 151k | да | Теги: photorealistic, photogrammetry, 3dscan (2023, 5.6k просмотров, 11 лайков). Фотограмметрия/скан: топология грязная, интерьер скорее всего нет — [не проверено] |
| 2 | [Lada Largus](https://sketchfab.com/3d-models/none-ef5fd62d01ca49f1bd70bb596456c144) | usolakolya | CC BY | 1.50M / 834k | да | Свежая (2026-08), описание «7 мест». Очень тяжёлая, нужна ретопология |
| 3 | [Lada Largus Cross](https://sketchfab.com/3d-models/none-adb12c56ffe7475fa0eef1203261e501) | usolakolya | CC BY | 1.50M / 834k | да | Вариант Cross (пластиковые накладки) |
| 4 | [Lada Largus Cross Rest](https://sketchfab.com/3d-models/none-fe54b2a96397452fb26af48db4696960) | usolakolya | CC BY | 862k / 491k | да | Рестайлинг |
| 5 | [ВАЗ (Lada) largus](https://sketchfab.com/3d-models/none-78e9ab4adf3e4323880e2f0fc347503b) | Mr Humster | CC BY | 2.9k / 1.4k | да | Очень low-poly, пригоден как трафик, не как герой |
| 6 | [Dacia Logan MCV MK1 2006-2013](https://sketchfab.com/3d-models/none-5870ef488734415bb74eb8f3232d42aa) | Merc_TV | CC BY | 1.83M / 1.00M | да | В описании прямо: «Renault Logan MCV, Lada Largus». Самая подходящая геометрия кузова, но тяжёлая |
| 7 | [Dacia Logan Mcv](https://sketchfab.com/3d-models/none-d4362de23bde44acac1cc8fec52c1375) | Ruletă | CC BY | 108k / 63k | да | Средний полигонаж — удобная база для доработки |
| 8 | [2009 Dacia Logan](https://sketchfab.com/3d-models/none-bd250be9928342a9b6f632d80da1fdc3) | Dave Love | CC BY | 66k / 38k | да | Седан, не универсал (теги в API явно мусорные) |
| 9 | [Lada Largus — Low Poly (PSX)](https://sketchfab.com/3d-models/none-0aefdaf045ce4d6083d98562981c8e56) | T_i_a_D | не скачивается (продаётся на Fab) | 4k / 2k | нет | Только референс стиля |
| 10 | [Largus transportation system](https://sketchfab.com/3d-models/none-26d2f69afe974ae8a7cb5113e7b0b770) | Sergo_CRAFTSMAN | CC BY | 5.2M / 1.3M | да | Грузовая версия с оснасткой; избыточно |

Другие площадки: 3D Warehouse, CGTrader free, Free3D, TurboSquid free — **[не проверено]**: страницы грузятся JS-ом, WebFetch вернул пустое тело; без поисковых API не проверить. GTA/BeamNG/Assetto-моды Largus не рассматривались (лицензия модов обычно «не для переиспользования»); если захочется — отдельно, по лицензии каждого автора.

Не найдено: бесплатной модели Largus с проверенным **салоном** + PBR + нормальной топологией. Это нужно открыть и посмотреть вручную (шаги ниже).

### Рекомендация
1. **Основа кузова: №2 (usolakolya, CC BY) или №6 (Merc_TV)** — открыть в просмотрщике Sketchfab (режим Wireframe/Model Inspector), проверить, раздельны ли кузов, колёса, стёкла, фары, салон. Если колёса/двери отдельными объектами — это то, что нужно для тюнинга и физики.
2. Скачать с аккаунта (нужна регистрация пользователем — моя задача её запрещала), в Blender: удалить салон/мелочь, ретопо/Decimate до ~60–120k треугольников для героя (ТЗ: 100–200k), отделить 4 колеса (вращение/руль), стёкла отдельным материалом, фары/стоп-сигналы с emissive. Для лоуполи-версии на LOD: 15–20k.
3. Тюнинг руками в Blender: понижение подвески (опустить кузов на 40–60 мм относительно колёс, развал отрицательный), диски (свой литой диск — 5–10k tris, делается быстро), обвес (передний сплиттер, пороги, спойлер на крышку багажника/крышу — простые экструзии), глушитель с двойным выхлопом, тонировка. Покраска — через PBR-материал, цвет в параметрах игры.
4. Если №2 окажется кривой — запасной путь: №7 (108k, чистый Logan MCV) + заменить бамперы/решётку на Largus вручную (референс — фото из панорам Яндекса/Мapillary).
5. Сохранять атрибуцию автора (CC BY). Для №1 (NC) — только если проект навсегда личный.

---

## 2. Трафик (low–mid poly)

Поиск Sketchfab API, downloadable=true **[проверено, по метаданным поиска]**. Faces — количество граней (треугольников ≈ faces). Для трафика цель 5–20k tris: многое придётся прореживать. Единого «стильного пака» именно российских авто не найдено; ближайшие — пак Zhiguli и серия eightismore (стилизованные).

| Тип | Модель | Автор | Лицензия | Faces | Комментарий |
|---|---|---|---|---|---|
| Lada 2107 | [[FREE] VAZ 2107](https://sketchfab.com/3d-models/none-cc7c031cbfe246e98d5e5cfbc6b871a4) | Mcflower's Creations | CC BY | 6.9k | **Лучший кандидат** по полигонам |
| 2107 | [1995 Lada/VAZ 2107](https://sketchfab.com/3d-models/none-c94daeb210b244729d634975c9ed0c5b) | Renafox | CC BY-NC | 2.0k | Очень low-poly |
| 2107 | [Old Car - VAZ 2107](https://sketchfab.com/3d-models/none-91270dab9d1a47c7ba7ffaaf8c8b0beb) | Arkady Gribachev | CC BY | 19.9k | |
| 2107 | [LADA VAZ 2107](https://sketchfab.com/3d-models/none-08919ffc20a149e487165902114e1e91) | dograaman999 | CC BY | 19.9k | |
| 2107 | [Vaz 2107](https://sketchfab.com/3d-models/none-4315e4d4f2aa48a7afe22ae759931f23) | Ford mondeo | CC BY | 54.7k | |
| 2107 | [ваз 2107](https://sketchfab.com/3d-models/none-ad10b2ef7c8d4edc9f080351a422b882) | Саша | CC BY | 1.8k | |
| 2114 | [ВАЗ (Lada) 2114](https://sketchfab.com/3d-models/none-491224d855604400906b595330b3f544) | Mr Humster | CC BY | 2.2k | Тот же автор, что Largus №5 — возможна стилевая связка |
| 2114 | [VAZ lada 2114](https://sketchfab.com/3d-models/none-ee9e6babfa4d4ed6983d71de65d7a6fc) | NRPshka | CC BY | 1.6k | |
| 2114 | [Vaz 2114 / Lada 2114 / Samara](https://sketchfab.com/3d-models/none-e87c0932b5794d8c834042c273d44a43) | Quore | CC BY-NC | 1.26M | Скан, тяжёлый |
| Granta | [LADA GRANTA DRIVE ACTIVE](https://sketchfab.com/3d-models/none-3ea4311ba52a4a32b11c23029de16b7a) | Quore | CC BY-NC | 50.9k | |
| Granta | [Lada Granta Comfort](https://sketchfab.com/3d-models/none-b7c13bc7e93a458392a6f9df8448e7d9) | deepa.gurnani.ntpc | CC BY | 33.7k | Автор сам пометил «crap» |
| Granta | [Русский народный автомобиль (фотограмметрия)](https://sketchfab.com/3d-models/none-3d16db288db34947b0c5ae9eeb13ff45) | dima051983 | CC BY | 86k | Не уверен, что это Granta — проверить |
| Granta | [Voyage 3: Outlaw Playable & NPC Vehicles](https://sketchfab.com/3d-models/none-ec3bd1d415a0471aad47d07e93a448ff) | Mason | CC BY-NC | 21k | Пак из нескольких авто (в т.ч. полиция) |
| Vesta | [Low Poly Lada Vesta](https://sketchfab.com/3d-models/none-b804fab0498f42be8b40f0201d7ed7c0) | kulonee | CC BY | 5.6k | **Лучший** по полигонам |
| Vesta | [Lada Vesta SW NG](https://sketchfab.com/3d-models/none-74d0168d94fd486889f93e7f0c6cd264) | S.K. | CC BY | 25.7k | Универсал |
| Vesta | [Lada Vesta](https://sketchfab.com/3d-models/none-3c333139feb744ae9d36767c0e9cabfd) | tiunov.se | CC BY | 198k | Автор делает серию (Niva, Logan) — единый стиль |
| Niva | [Low poly lada niva](https://sketchfab.com/3d-models/none-b67df18b55ab497ba30cdbd6be7dee19) | RitiWox | CC BY | 5.8k | Подходит |
| Niva | [Lada Niva](https://sketchfab.com/3d-models/none-26ebf5872bce4ff4ad2baee41882d6b2) | Greg McKechnie | CC BY | 75k | |
| Niva | [Lada Niva](https://sketchfab.com/3d-models/none-5a83c0cc63df418fa5bb9a2bf98dc9a6) | tiunov.se | CC BY | 134k | |
| Hyundai Solaris | [Hyundai_Solaris_ModLandNet](https://sketchfab.com/3d-models/none-1fa0c04858e94d23bccf700fa806e59f) | zapkolenko07 | CC BY | 622k | Единственная прямая Solaris; тяжёлая, **лицензия мода — проверить происхождение** |
| Solaris (прокси) | [2013 Hyundai Accent](https://sketchfab.com/3d-models/none-8270bf067a5247f687b2d38b3b1eae39) | Dave Love | CC BY | 951k | Accent = Solaris (ту же платформу делают Solaris/Accent) в ряде рынков; заменитель |
| Kia Rio | [KIA RIO](https://sketchfab.com/3d-models/none-b5119dce852f461d9eccd59841101a12) | zairiq | CC BY | 520 | Слишком примитивно (520 faces) |
| Kia Rio | [2021 Kia Rio](https://sketchfab.com/3d-models/none-82803d9c4afb4cf2867ef364d31e6528) | tonielpro520 | CC BY | 425k | Не наше поколение |
| Logan | [Renault Logan 2004](https://sketchfab.com/3d-models/none-e4f9463f6e004b90bb977d12f6375b9c) | Denis Petrushin | CC BY | 33k | Подходит |
| Logan | [Renault Logan 2015 FBX](https://sketchfab.com/3d-models/none-20235fc4ceb2442ebad4f60de961e4f4) | itsvipergfx | CC BY | 60.7k | |
| Logan | [Renault Logan](https://sketchfab.com/3d-models/none-f5ae16799df040d88ad155fb3fc7aacb) | tiunov.se | CC BY | 197k | |
| Logan (такси/полиция) | [Taxi 2](https://sketchfab.com/3d-models/none-0b5310fbf2c14b3e807c63f2ee1ca7bf) / [Politia](https://sketchfab.com/3d-models/none-7da8b84f438745cb9e06ed1a2ce5c552) | solid3DDD | CC BY | 19.9k / 912k | Taxi 2 — вероятно Logan-такси (проверить) |
| Газель-маршрутка | [Провинциальная маршрутка / Такси / Газель](https://sketchfab.com/3d-models/none-a89fcdd05e79470caf0c8b39dcf58fce) | yakub | CC BY | 110k | Нужна децимация |
| Газель | [Газель 3302](https://sketchfab.com/3d-models/none-f59647f516f54bbe896972a261d3df87) | thehto | CC BY | 43k | |
| Газель | [Газель gaz-3221](https://sketchfab.com/3d-models/none-e61f855fcc1241eab6589f53eb286bae) | Ford mondeo | CC BY | 154k | 3221 — классическая маршрутка. Автор делает целую серию (ПАЗ-3205 тоже) |
| Газель Next | [GAZelle Next [FREE]](https://sketchfab.com/3d-models/none-6f5f115cb8fc4bb2933b317f505d5708) | UralStrong | CC BY | 318k | |
| ПАЗ-3205 | [PAZ-3205](https://sketchfab.com/3d-models/none-ae628447785e4feca559bdf660c3251f) | hans1240 | CC BY | 42k | |
| ПАЗ-3205 | [Bus ПАЗ 32053](https://sketchfab.com/3d-models/none-5d02a6448537479aacf0093d57de0c39) | morrrtu1o | CC BY | 2.7k | **Лучший low-poly** |
| ПАЗ-3205 | [PAZ 3205](https://sketchfab.com/3d-models/none-95fa1547a7c845bfb9106a5c65a2a15c) | Ford mondeo | CC BY | 134k | |
| ПАЗ-3204 | не найдено [проверено — запросы «paz 3204 bus», «ПАЗ 3204» пусты] | | | | Использовать 3205 (визуально близко) |
| ЛиАЗ-5292 | [liaz 5292](https://sketchfab.com/3d-models/none-577c32b2a6ed418dbaa93b8eb4b21437) | mamontnikita349 | CC BY | 9.2k | Подходит |
| ЛиАЗ | [ЛиАз5256](https://sketchfab.com/3d-models/none-951a7a0d5a4e4382b5d9c461b6261a40) | Zovchick24k | CC BY | 120k | Старый ЛиАЗ-5256 |
| Троллейбус (Тролза) | [Тролза-5275.03 «Оптима»](https://sketchfab.com/3d-models/none-a54431ded56d4a22976b3bd5612ef41a) | Alexey_Kazakov | CC BY | 28k | **Подходит**, современный Тролза |
| Троллейбус (ЗиУ) | [ZiU 683B](https://sketchfab.com/3d-models/none-ede3e5d4e2fd46178194bf8268d4407e) | ARDANYDL12K | CC BY | 13k | |
| Троллейбус (ЗиУ) | [trolley ZIU-682G](https://sketchfab.com/3d-models/none-ad0b00db23164b13998150433c73fb4f) | gildermanvladimir089 | CC BY | 2.5k | Лоуполи, ЗиУ-682 |
| ВМЗ / ПКТС | не найдено [проверено: «ВМЗ троллейбус» — пусто] | | | | |
| Такси | [VAZ-2105 Taxi](https://sketchfab.com/3d-models/none-a043e2f3af464f528861544b449a7a81) | 42manako | CC BY-NC | 7k | Устаревший вариант; чаще рисуем свой «жёлтый» Logan/Solaris перекраской |
| Полиция (ДПС) | [Russian Police](https://sketchfab.com/3d-models/none-93b3c4da7c3744ca8f99cac90955d6ae) | TimaPlay3d | CC BY | 675 | Очень лоуполи, брать как референс/заготовку |
| Полиция | [VAZ 2101 Road Police](https://sketchfab.com/3d-models/none-da518db0b8ff41088db45b55122267d3) | eightismore | CC BY | 3.5k | Старая «копейка» ДПС |
| Классика СССР | [Zhiguli Soviet Cars](https://sketchfab.com/3d-models/none-7c3f4bee5d37401d853d2206dc7859fc) | spacelynxcanfly | CC BY | 4.0k | Единый стиль |

Рекомендация по трафику: не искать единый пак — собрать набор, прогнать через Blender (импорт → Decimate → единые материалы с общим цветовым атласом/палитрой → экспорт glTF с Meshopt), покраска по цветовой карте в рантайме. Недостающие модели (Solaris/Rio актуального поколения, ВМЗ/ПКТС, ПАЗ-3204, ДПС-Granta) делаются перекраской/модификацией близких моделей (Accent→Solaris, ПАЗ-3205→3204, Logan→такси/ДПС с мигалкой и «шашечками»). Все модели прикрепить в `assets/CREDITS.md`.

Исходники, которые стоит учесть — [не проверено]: Kenney Car Kit / Quaternius Cars (CC0, универсальные low-poly машины) — для массовки седанов/хэтчей (см. §5).

---

## 3. Hero-объекты (bbox 54.600,39.700 → 54.665,39.810)

Координаты — Nominatim (1 запрос/сек, свой User-Agent, ограничение по viewbox) **[проверено]**. Поиск Sketchfab — по запросам «Рязань», «Ryazan», по названиям RU/EN, downloadable=true и false **[проверено]**; поиск 3D Warehouse и русских 3D-сайтов **[не проверено]**.

Итог поиска: готовых моделей мало. Для Кремля **нет** ни одной модели Успенского собора, Дворца Олега, Архангельского, Христорождественского, Спасо-Преображенского (кроме нескачиваемого скана DHlab). Найдено только:

| Объект | Координаты (lat, lon) | Найденные модели (лицензия) | Подход | Приоритет |
|---|---|---|---|---|
| Успенский собор (Кремль) | 54.63614, 39.74892 | не найдено | Blender руками по фото/планам + текстуры из панорам Яндекса; в идеале фотограмметрия | 1 (визитка города) |
| Соборная колокольня | 54.63553, 39.74785 | [Рязань. Соборная колокольня](https://sketchfab.com/3d-models/none-5835037fec004073b6a851fcdccf1330), DARKANANAS, CC BY, 13.7k faces / 6.7k verts, скачивается | **Готовая модель** + проверить пропорции/текстуру | 1 |
| Дворец Олега | 54.63704, 39.74960 | не найдено | Blender руками | 2 |
| Архангельский собор | 54.63655, 39.74935 | не найдено (найденный на Sketchfab — Ижевск, не то) | Blender руками | 2 |
| Христорождественский собор | 54.63655, 39.74853 | не найдено | Blender руками | 2 |
| Церковь Богоявления (Богоявленская) | 54.63587, 39.74942 | [Рязань. Богоявленская церковь](https://sketchfab.com/3d-models/none-5b4a57053faa494e84910f5bbf47e70d), DARKANANAS, CC BY, 12.2k faces / 6.1k verts, скачивается | **Готовая модель** | 2 |
| Спасо-Преображенский монастырь | 54.63559, 39.74988 | [Спасо-Преображенский монастырь](https://sketchfab.com/3d-models/none-fcc633fa27e14ff5a5c3d1444f020eb9) DHlab, 1.76M faces, **не скачивается**, лицензия не указана | Только референс. Строить руками, силуэт — из панорам | 3 |
| Рязанский кремль целиком | 54.63625, 39.74963 | [Аэросъемка г. Рязань (Кремль)](https://sketchfab.com/3d-models/none-9dbd0c982eda406da0e04d08f1ad3fc0) SAVIOR, 345k faces, не скачивается | Референс общей планировки/высот | 1 |
| Драмтеатр (Театральная пл.) | 54.62109, 39.75763 | не найдено | Blender руками (простой объём + колонны); 1 день | 2 |
| Площадь Победы (монумент) | 54.62935, 39.71161 | не найдено | Blender руками (стела/обелиск простой) | 3 |
| Вокзал Рязань-I | 54.63237, 39.71408 | не найдено | Blender руками + текстуры фасада из панорам | 2 |
| Вокзал Рязань-II | 54.62967, 39.70305 | не найдено | Blender руками | 2 |
| ТЦ «Круиз» | не определено: Nominatim и Overpass (`name~Круиз` в bbox) не вернули результат [не проверено] | не найдено | Сначала найти точку по карте/Яндексу; затем коробка по футпринту OSM + фасадная текстура | 3 |
| Цирк | 54.63127, 39.74927 | не найдено | Blender руками (характерный купол) | 3 |
| Почтамт | 54.62932, 39.74207 | не найдено | Процедурно по футпринту + фасадная текстура | 4 |
| Соборная площадь | 54.63204, 39.74469 | не найдено | Площадь как часть ландшафта (мощение, фонари, озеленение) | 3 |
| Памятник Есенину | 54.63524, 39.74220 | не найдено; на Sketchfab лишь не скачиваемый «Lenin monument in Ryazan city» (Alex, 148k faces) — другой памятник | Blender (скульптура) или упрощённая фигура-силуэт/билборд | 4 |
| Лыбедский бульвар | 54.62809, 39.74246 | — | Процедурно: аллея, скамейки, деревья из OSM (`natural=tree`) | 4 |

Побочные находки Sketchfab, пока без применения: «RYAZAN» от Allamikhalch (7k faces, CC BY, «Building exported from Pamir» — непонятно, что именно), «Проект Рязань» от mad_and_loony (137k, CC BY — похоже на проект, не ориентир), «Малая Рязань» (Sergey Zubov, 342k, не скачивается) и «Баня Рязань» — отношения к ориентирам не имеют. Всё это [не проверено визуально].

Подходы по эффективности: для ~15 ориентиров ручной Blender (низкая детализация + текстуры из Яндекс-панорам/фото, 1–3 дня на объект для простых и 1–2 недели для Успенского собора). Фотограмметрия (RealityScan) — для Кремля, но требует выезда/съёмки (300–1000 кадров). Ready-made модели: только колокольня и Богоявленская церковь (DARKANANAS) — сразу в игру.

---

## 4. Пешеходы и анимации

| Источник | Лицензия | Статус |
|---|---|---|
| **Mixamo** (mixamo.com): персонажи + анимации (idle, walk, run, talk), экспорт FBX, ретаргет на любой риг | Бесплатно с Adobe ID, royalty-free по условиям Adobe — **вход в аккаунт нужен**, страница отдаёт «Loading» без JS, **не проверено**; аккаунт регистрировать мне нельзя | Основной путь, требует аккаунта пользователя |
| **Quaternius** (quaternius.com): Universal Animation Library, Modular Character/Ultimate Animated Characters | CC0 | [не проверено] |
| **Kenney** (kenney.nl): Animated Characters, Mini Characters | CC0 | [не проверено] |
| **Ready Player Me** | Публичный сервис закрыт 31.01.2026 после покупки Netflix | [проверено поиском: genies.com, avatarsdk.com блоги; часть источников конкурентов]. **Исключить.** |
| Альтернативы: VRoid Studio / VRM (аниме-стиль), MetaPerson (Avatar SDK, не бесплатно в полном объёме) | — | [не проверено] |

Рекомендация: пешеходы — стилизованные low-poly (500–2000 tris), 6–10 вариантов одежды через атлас; анимации Mixamo (walk/idle/run) запекаются в glTF заранее; на дальних дистанциях — инстансы с vertex animation texture, чтобы толпа не била по FPS.

---

## 5. Пропсы, текстуры, растительность, российская специфика

Универсальные библиотеки (адреса даны по знанию, не перепроверялись) **[не проверено]**:
- **Poly Haven** — polyhaven.com: HDRI, PBR-текстуры (асфальт, бетон, брусчатка), модели; всё CC0.
- **ambientCG** — ambientcg.com: PBR-текстуры CC0 (асфальт, плитка, штукатурка, кирпич).
- **Quaternius** — quaternius.com: деревья, природа, город, машины; CC0.
- **Kenney** — kenney.nl/assets: City Kit, Car Kit, Nature Kit; CC0.

### Дорожные знаки ГОСТ Р 52290
Wikimedia Commons, категории **[проверено API, 200]**:
- Корень: <https://commons.wikimedia.org/wiki/Category:Road_signs_in_Russia>
- По номерам: <https://commons.wikimedia.org/wiki/Category:Road_signs_of_Russia_by_number> (подкатегории вида «6.1 (road sign, Russia)», «8.1.1 (road sign, Russia)» и т.д.)
- Диаграммы: <https://commons.wikimedia.org/wiki/Category:Diagrams_of_road_signs_of_Russia>
- Предупреждающие: <https://commons.wikimedia.org/wiki/Category:Warning_road_signs_in_Russia>
- Запрещающие: <https://commons.wikimedia.org/wiki/Category:Prohibitory_road_signs_in_Russia>
- Предписывающие: <https://commons.wikimedia.org/wiki/Category:Mandatory_road_signs_in_Russia>
- Информационные: <https://commons.wikimedia.org/wiki/Category:Informational_road_signs_in_Russia>
- Приоритета: <https://commons.wikimedia.org/wiki/Category:Road_junction_priority_signs_in_Russia>
- Таблички: <https://commons.wikimedia.org/wiki/Category:Additional_road_signs_in_Russia>
- Парковка/автобус/пешеходы: соответствующие категории «Parking signs in Russia», «Pedestrian-related road signs in Russia», «Bus lane signs in Russia».

Важно: категории «Road signs in Russia» содержат в том числе **фотографии** реальных знаков, а не только SVG. Что в них векторные SVG и какой лицензии каждый файл — **не проверено** (Commons оборвал меня rate-limit 429 при выборочной проверке). Нужно отфильтровать по типу файла `.svg` при сборе (через `list=categorymembers` с паузами) и сохранить лицензию каждого. Если векторов не хватает — самостоятельная отрисовка по ГОСТ (простые формы, шрифт «ГОСТ»/Roadgeek-аналог).

### Что делать руками (нет готового)
- Светофоры российского образца (вертикальные, с секцией-стрелкой, пешеходные Т.1), остановки (павильоны Рязани), урны, уличные фонари типа «Рязань» (опоры 8–10 м, консоль), ограждения (оцинкованное барьерное/перильное), троллейбусные опоры с подвесами и контактной сетью, трамвайных путей в Рязани нет — не моделировать, остановочные таблички «А/Т», дорожная разметка (по ГОСТ Р 51256, генерируется процедурно по OSM-полосам), бордюры/пандусы, гаражи, киоски, типовые подъезды и козырьки.
- Контактная сеть троллейбуса — процедурно по OSM-путям `route=trolleybus`, провода + опоры раз в 35–40 м.
- Растительность: Quaternius/Poly Haven деревья + свои билборды берёзы/тополя/клёна (характерные для Рязани).

---

## 6. Звук двигателя

### Концепция
**Рекомендую реальный K4M 1.6 16V (Largus 1.6 16V, 105 л.с.) как «основу характера» + лёгкий «вымышленный» тюнинг-слой**: рядная 4-цилиндровка, рабочие обороты 800–6500 rpm, ограничитель около 6500, высокий регистр, быстрый набор. «Бархатный рёв» складывается из: (1) низкого тела (вторая-четвёртая гармоники порядка зажигания, 4 цилиндра = 2 импульса за оборот), (2) шелеста впуска (спортивный воздушный фильтр, «нулевик»), (3) глухого басистого выхлопа через резонатор + прямоток (завершение коротким «хрипом» на отсечке), (4) хлопков/«выстрелов» при сбросе (антилаг-стиль, поп-генератор), (5) опционально турбо-слой (тюнингованный Largus под турбо — привычный путь у владельцев). Почему не V8: реалистичность и узнаваемость; пользователь просил именно Largus-тюнинг, а i4 с прямотоком + антилаг-хлопками даёт нужный «рёв без V8-клише». Вариант B (если хочется «баса»): свап-концепция рядной 6/ V6 — это сознательно «вымышленный» вариант, оставить как настройку пресета.

### Основные слои (RPM × нагрузка, из ТЗ §6.2)
on-load / off-load на 6–10 точках оборотов, + впуск (салон), выхлоп (внешний), хлопки, КПП, шины, турбо.

### freesound.org — конкретные звуки
Поиск через веб-страницу freesound.org с фильтром «Creative Commons 0»; затем на странице каждого файла есть ссылка на лицензию CC0 (кроме указанных, лицензия определена по фильтру и ссылке на странице — **перед использованием открыть страницу и подтвердить**; длительность и частотный диапазон не проверялись, файлы не скачивались). Freesound API требует токен, поэтому скрейп HTML. Часть ссылок получена из выдачи `downloads desc`.

| Слой | Звук | URL | Лицензия | Комментарий |
|---|---|---|---|---|
| Двигатель на оборотах (близкий по классу) | 00_Renault_duster_Exaust_3times_outdoor.wav (semenov_nick) | <https://freesound.org/people/semenov_nick/sounds/380719/> | CC0 | Renault Duster — тот же семейство моторов K4M/F4R, что у Largus; **самый релевантный** |
| Разгон | Renault 19 underhood acceleration (lovretta) | <https://freesound.org/people/lovretta/sounds/141240/> | CC0 | Под капотом, разгон |
| Салон, холостой→быстро | Car Internal - Idle to Fast (andrewfordham) | <https://freesound.org/people/andrewfordham/sounds/848361/> | CC0 | Интерьерный слой |
| Контактная запись | Car Engine Contact Recording - Mini Cooper S 2019 (TheLittleCrow) | <https://freesound.org/people/TheLittleCrow/sounds/669622/> | CC0 | Контактный микрофон = слой «блок/механика» |
| Несколько микрофонов | Ford Ranger (2000) RPM variations outside 4 mics (YannSauvin) | <https://freesound.org/people/YannSauvin/sounds/779214/> | CC0 | Диапазон оборотов по микрофонам — хорош для нарезки, но дизель/пикап? **(двигатель не проверен)** |
| Холостой/газ | Elantra Engine Idle and Rev (microman502) | <https://freesound.org/people/microman502/sounds/865228/> | CC0 | Бензиновый i4 |
| Прогазовки с турбо | Import car revs on Chassis Dyno with Turbo (editboy23) | <https://freesound.org/people/editboy23/sounds/496171/> | CC0 | Тюнинг-характер |
| Тюнинг-прогазовка | Piece of crap supertuner revs it past the warehouse (PostProdDog) | <https://freesound.org/people/PostProdDog/sounds/535874/> | CC0 | «Тюнингованный» тембр |
| Низкие обороты | SFX_Car_Engine_Outside_RPMLow.wav (GiocoSound) | <https://freesound.org/people/GiocoSound/sounds/401556/> | CC0 | Игровая нарезка по RPM, возможно есть Mid/High — искать по автору |
| Выхлопной/антилаг-поп | Car Antilag (No cleanup, 32float) (modusmogulus) | <https://freesound.org/people/modusmogulus/sounds/797835/> | CC0 | Хлопки/антилаг |
| Турбо | Turbo Spooling and Blow Off.WAV (EwanPenman11) | <https://freesound.org/people/EwanPenman11/sounds/659544/> | CC0 | Свист + сброс |
| Шины | Chrysler LHS tire squeal 01–04 (audible-edge) | <https://freesound.org/people/audible-edge/sounds/71737/> (и 71736, 71738, 71739) | CC0 | Визг шин |
| Занос/ручник | Volvo 740 GLE handbrake turn 01/03 (audible-edge) | <https://freesound.org/people/audible-edge/sounds/76806/> (и 76804) | CC0 | Дрифт-слой |
| Переключение передач | Shifting Lotus Elise 6-1 Interior (conicity) | <https://freesound.org/people/conicity/sounds/697837/> | CC0 | Шифт + реакция двигателя |
| Переключение (механика) | Gear Shift - Park Reverse Drive - Interior Honda (UnplugTheFridge) | <https://freesound.org/people/UnplugTheFridge/sounds/529222/> | CC0 | Ручка/АКПП, не спортивная |
| V8 для сравнения/слоя баса | S63 AMG V8 Engine Revs (marcelweiss) | <https://freesound.org/people/marcelweiss/sounds/505321/> | CC0 | Только для эксперимента |
| Проезды мимо | car pass fast 4 times (martian), Car by slow … DonFX (Donmann) | <https://freesound.org/people/martian/sounds/180324/>, <https://freesound.org/people/Donmann/sounds/237339/> | CC0 | Для трафика и допплера |

Ограничения: у freesound куски часто содержат шум/речь/дыхание, лупы придётся чистить (Audacity, noise reduction, Rubber Band для time-stretch). Загрузка без аккаунта у freesound невозможна для полноразмерных WAV [не проверено; превью MP3/OGG доступны без входа].

### DasEtwas/enginesound (Rust)
- [DasEtwas/enginesound](https://github.com/DasEtwas/enginesound): **385★, MIT, последний push 2023-06-06** **[проверено]**. Процедурный синтез по статье «Physically informed car engine sound synthesis» (волноводы впуск/выхлоп/блок).
- Пресеты: **6 файлов** `example1.esc … example6.esc` (формат RON, параметры rpm, cylinders, выхлоп/впуск волноводы) **[проверено, в репозитории]**.
- **macOS (Apple Silicon): сборка НЕ получилась.** `cargo build --release` падает в зависимости `winit 0.23` (`cocoa 0.23`: «mismatched types», 7 ошибок); `--no-default-features` (без GUI) падает так же, потому что `winit = "0.23.0"` не опциональна **[проверено, rustc/cargo в Homebrew]**. Варианты: (a) форк с обновлением winit/glium/conrod → тянет за собой несколько мажорных версий, трудоёмко; (b) собрать только DSP-ядро (`src/gen.rs` + CLI-режим без winit, убрав `winit`/`native-dialog` из зависимостей) — вероятно 1–2 часа; (c) портировать алгоритм (волноводы) в JS/AudioWorklet — полезно для динамического звука в игре; (d) использовать как референс параметров. Отметка: (a)/(b)/(c) оценки трудозатрат — оценки, не проверены.
- Скомпилированные бинарники в релизах: **есть релизы v1.5.2/v1.5.3/v1.6** [проверено списком релизов], но под какие ОС — не проверено; под macOS arm64 вероятно нет.

### Веб-реализации (GitHub)
- [Antonio-R1/engine-sound-generator](https://github.com/Antonio-R1/engine-sound-generator): **50★, MIT, 2022-11** — генератор звука двигателя на JavaScript + Web Audio API **[проверено через поиск GitHub]**. Подходит как основа для рантайм-синтеза/сравнения; качество звука не проверялось.
- Остальной поиск GitHub (запросы «engine sound webaudio», «engine audio rpm three.js» и т.п.) не дал серьёзных вариантов: единственный стоящий — выше **[проверено, ограниченно: поиск GitHub ненадёжен]**.
- [ATG-Simulator/VehicleNoiseSynthesizer](https://github.com/ATG-Simulator/VehicleNoiseSynthesizer): 53★, MIT, для Unity — идеи по слоям/RPM-пулу; прямой переиспользуемости в Three.js нет.
- ange-yaghi/engine-sim (9.6k★, MIT, по ТЗ) — Windows; записать лупы на чужом ПК/Windows-VM — идея из ТЗ, не проверялась.
- Сэмплерный подход (слои по RPM × нагрузке с кроссфейдом) в Web Audio реализуется самостоятельно: `AudioBufferSourceNode` loop + `playbackRate` + `GainNode` кроссфейд ≈ 300 строк TS.

### Sonniss GDC
Sonniss GDC Game Audio Bundle — ежегодные бесплатные паки (в 2026 — 17 вендоров, ~7.5 ГБ, лицензия royalty-free, атрибуция не нужна; запрет перепродажи и использования для обучения ИИ) **[сводка по сторонним источникам: rekkerd.org, licenseorg.com; текст лицензии Sonniss не читал]**. Для проекта полезны: городские атмосферы, проезды, шины, двери, звуки трафика/сирен. Автомобильных «лупов двигателя Largus» там нет, но возможны отдельные сэмплы выхлопов/хлопков (содержимое не проверено). Требуется скачивание на сайте Sonniss (регистрация/форма — моя задача её не позволяла).

---

## 7. Проверки покрытия

- **Mapillary в центральной Рязани:** **неизвестно.** Graph API без токена отдаёт 500, тайлы `tiles.mapillary.com/maps/vtp/...` — 403 **[проверено]**; поиск в вебе данных по Рязани не дал **[проверено]**. Нужно открыть mapillary.com/app карту у Рязани вручную (или получить бесплатный токен — это регистрация). Для проекта главный источник панорам и так Яндекс (TZ §5.6), Mapillary — запасной.
- **Google Photorealistic 3D Tiles — Рязань:** **неизвестно.** Поиск не нашёл списка городов; документация отсылает к слою «3D Coverage» в Google Earth и странице покрытия Map Tiles API **[проверено поиском]**. Также Map Tiles API требует API-ключа (аккаунт Google Cloud), а условия Google ограничивают использование/кэширование тайлов — как источник для игры сомнительно; только справочно. Проверять вручную в Google Earth.

---

## 8. Итог

### Топ-рекомендации
1. **Largus:** база — модель usolakolya (CC BY, 1.5M faces, нужно ретопо) либо Dacia Logan MCV (Merc_TV, 1.8M, либо Ruletă 108k как более лёгкая); решить после осмотра в просмотрщике Sketchfab, нужен ручной скачивание под аккаунтом пользователя. Тюнинг (посадка, диски, обвес, выхлоп) делается руками.
2. **Трафик:** low-poly подборки: VAZ-2107 (Mcflower 6.9k), Vesta (kulonee 5.6k), Niva (RitiWox 5.8k), ПАЗ 32053 (morrrtu1o 2.7k), ЛиАЗ-5292 (mamontnikita349 9.2k), Тролза-5275 (Alexey_Kazakov 28k), 2114 (Mr Humster 2.2k / NRPshka 1.6k).
3. **Ориентиры:** сразу готовы только колокольня и Богоявленская церковь (DARKANANAS, CC BY). Остальное — руками.
4. **Звук:** сэмпловые слои на основе CC0 с freesound (Duster, Renault 19, Mini Cooper contact, antilag, turbo, tire squeal) + портированное/форкнутое DSP enginesound; концепция K4M 1.6 16V с прямотоком и антилаг-хлопками.
5. **Знаки:** Wikimedia Commons (категории выше) + отрисовка недостающих по ГОСТ.

### Пробелы (делать вручную)
- Все кремлёвские здания (кроме колокольни/Богоявленской), драмтеатр, вокзалы, цирк, почтамт, монумент Победы, памятник Есенину, Круиз (координата неизвестна).
- Тюнинг-обвес и диски Largus; салон (если в базе его нет).
- Модели Solaris/Rio актуального поколения, ВМЗ/ПКТС, ПАЗ-3204, ДПС-Granta/Vesta.
- Российские светофоры, остановки, фонари, троллейбусные опоры, разметка (процедурно).
- Рабочий DSP звука (enginesound не собирается на macOS без правок).

### Грубые оценки трудозатрат (оценки, не измерены)
- Largus: 3–7 дней (подготовка + тюнинг).
- Трафик 12–15 моделей: 3–5 дней (децимация, материалы, LOD).
- Ориентиры: 2–4 недели на ~12 объектов низкой детализации; Успенский собор отдельно 1–2 недели.
- Пешеходы: 2–3 дня.
- Звук: 1–2 недели до приятного результата (нарезка лупов, микс, пост-эффекты).
- Знаки и пропсы: 1–2 недели.

### Что я не смог проверить (дополнительно)
Скачивание любых моделей (Sketchfab требует вход), содержание текстур/интерьеров, 3D Warehouse/CGTrader/Free3D/TurboSquid, русские 3D-сайты, Mapillary, Google 3D Tiles, наличие SVG в категориях Commons, реальные длительности и качество звуков freesound, содержимое Sonniss 2026.

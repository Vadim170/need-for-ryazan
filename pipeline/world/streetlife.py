"""Уличная жизнь: витрины, подъезды, клумбы, ограждения, дополнительные фонари.

Контракт: docs/world-format.md, раздел «Улица: витрины, подъезды, клумбы, ограждения», подробности и цифры:
docs/stage2/streetlife.md. Вызывается из build_world.py сразу после world/yards.py (до записи props/*.json):
- инстансы и сегменты дописываются в общий контекст дворов (yctx.tiles_props / tiles_segs) и попадают в
  props/{ix}_{iz}.json обычным путём (новые типы: flowerbed, bollard, barrier_gate, park_lamp, street_lamp_double;
  сегменты ped_fence, guardrail, jersey_barrier, lawn_fence; плюс лавочки/урны у подъездов);
- витрины и входы — новые ключи `storefronts` и `entrances` в тех же props/{ix}_{iz}.json (StreetLife.write).

Проверки «свободно ли место» — тот же растр масок 1 м (yards.Ctx), плюс свой растр «какая дорога здесь»
(индекс дороги в пикселе проезжей части) — по нему фасады понимают, на какую улицу смотрят.
Деревья и кусты, на которые попали новые объекты, удаляются (они ставились последними и места не помечали).
Всё детерминировано: RNG с ключом по объекту.
"""
import json
import math
import os
import re
import xml.etree.ElementTree as ET
from collections import defaultdict

import numpy as np
import shapely
from rasterio import features
from scipy.ndimage import distance_transform_edt, maximum_filter
from scipy.spatial import cKDTree
from shapely.geometry import LineString, Point, Polygon
from shapely.geometry.polygon import orient
from shapely.ops import polylabel

from config import to_world
from . import buildings as B
from .roads import base_class, cumlen, resample
from .yards import (APT40, AREA, BLD, CEMETERY, CORR, GROUNDS, HARD, JUNC, NEAR_BLD, PARK, PARKING, PATH, PROP, RES, ROAD,
                    ROAD_LIFT, TILE, URBAN, WATER, WOOD, rot_of)

SIDEWALK_TOP = 0.15          # верх тротуара над рельефом (world/sidewalks.py)
RANK = {"primary": 5, "secondary": 4, "tertiary": 3, "unclassified": 2, "residential": 2, "living_street": 2, "service": 1}
SEED = 777

# ---------------------------------------------------------------------------------------------------------------
# категории POI: ключ -> (kind, подпись по-русски, цвет вывески по умолчанию, ширина витрины, м)
CAT = {
    "supermarket": ("shop", "Супермаркет", "#2E7D32", 14), "convenience": ("shop", "Продукты", "#F9A825", 6),
    "alcohol": ("shop", "Алкомаркет", "#8E1B1B", 6), "beverages": ("shop", "Напитки", "#8E1B1B", 5),
    "wine": ("shop", "Вино", "#6D1B2B", 5), "beer": ("shop", "Разливное пиво", "#B26A00", 5),
    "clothes": ("shop", "Одежда", "#6A1B9A", 7), "shoes": ("shop", "Обувь", "#4E342E", 6),
    "cosmetics": ("shop", "Косметика", "#D81B60", 6), "perfumery": ("shop", "Парфюмерия", "#D81B60", 6),
    "beauty": ("service", "Салон красоты", "#C2185B", 5), "hairdresser": ("service", "Парикмахерская", "#AD1457", 5),
    "electronics": ("shop", "Электроника", "#1565C0", 8), "mobile_phone": ("shop", "Салон связи", "#1E88E5", 5),
    "computer": ("shop", "Компьютеры", "#1565C0", 6), "jewelry": ("shop", "Ювелирный", "#B8860B", 5),
    "florist": ("shop", "Цветы", "#43A047", 4), "bakery": ("food", "Пекарня", "#A1662F", 5),
    "butcher": ("shop", "Мясо", "#C62828", 5), "confectionery": ("shop", "Кондитерская", "#EC407A", 5),
    "pet": ("shop", "Зоотовары", "#FB8C00", 5), "hardware": ("shop", "Хозтовары", "#6D4C41", 6),
    "doityourself": ("shop", "Стройматериалы", "#EF6C00", 8), "car_parts": ("shop", "Автозапчасти", "#37474F", 6),
    "car_repair": ("service", "Автосервис", "#455A64", 7), "tyres": ("service", "Шиномонтаж", "#263238", 6),
    "furniture": ("shop", "Мебель", "#795548", 8), "optician": ("shop", "Оптика", "#00838F", 5),
    "books": ("shop", "Книги", "#5D4037", 6), "gift": ("shop", "Подарки", "#E91E63", 5),
    "chemist": ("shop", "Бытовая химия", "#7CB342", 6), "medical_supply": ("shop", "Медтехника", "#00897B", 5),
    "variety_store": ("shop", "Товары для дома", "#FBC02D", 7), "tobacco": ("shop", "Табак", "#5D4037", 4),
    "mall": ("shop", "Торговый центр", "#37474F", 20), "department_store": ("shop", "Универмаг", "#37474F", 16),
    "outpost": ("pickup", "Пункт выдачи", "#5C6BC0", 4), "travel_agency": ("service", "Турагентство", "#0288D1", 5),
    "bicycle": ("shop", "Велосипеды", "#388E3C", 6), "tailor": ("service", "Ателье", "#8D6E63", 4),
    "dry_cleaning": ("service", "Химчистка", "#039BE5", 5), "laundry": ("service", "Прачечная", "#039BE5", 5),
    "copyshop": ("service", "Копицентр", "#546E7A", 4), "pawnbroker": ("finance", "Ломбард", "#FFB300", 5),
    "stationery": ("shop", "Канцтовары", "#3949AB", 5), "toys": ("shop", "Игрушки", "#F4511E", 6),
    "sports": ("shop", "Спорттовары", "#1976D2", 7), "seafood": ("shop", "Рыба", "#0277BD", 4),
    "greengrocer": ("shop", "Овощи-фрукты", "#689F38", 4), "dairy": ("shop", "Молочные продукты", "#1E88E5", 4),
    "farm": ("shop", "Фермерские продукты", "#558B2F", 5), "fabric": ("shop", "Ткани", "#8E24AA", 5),
    "hearing_aids": ("shop", "Слуховые аппараты", "#00897B", 4), "paint": ("shop", "Краски", "#F57C00", 5),
    "bathroom_furnishing": ("shop", "Сантехника", "#0288D1", 6), "kiosk": ("shop", "Киоск", "#546E7A", 3),
    "car": ("shop", "Автосалон", "#263238", 12), "frozen_food": ("shop", "Замороженные продукты", "#29B6F6", 4),
    "shop": ("shop", "Магазин", "#546E7A", 5),
    # amenity / healthcare
    "cafe": ("food", "Кафе", "#6D4C41", 6), "restaurant": ("food", "Ресторан", "#8D6E63", 8),
    "fast_food": ("food", "Фастфуд", "#E65100", 5), "bar": ("food", "Бар", "#4A148C", 6), "pub": ("food", "Паб", "#3E2723", 6),
    "ice_cream": ("food", "Мороженое", "#F06292", 3), "pharmacy": ("health", "Аптека", "#2E7D32", 5),
    "bank": ("finance", "Банк", "#1565C0", 8), "bureau_de_change": ("finance", "Обмен валют", "#00796B", 4),
    "money_lender": ("finance", "Микрозаймы", "#F9A825", 4), "post_office": ("service", "Почта России", "#0055A6", 6),
    "dentist": ("health", "Стоматология", "#00ACC1", 5), "doctors": ("health", "Медцентр", "#00897B", 6),
    "clinic": ("health", "Поликлиника", "#00897B", 8), "laboratory": ("health", "Медлаборатория", "#00897B", 5),
    "veterinary": ("health", "Ветклиника", "#7CB342", 5), "driving_school": ("service", "Автошкола", "#F57F17", 5),
    "nightclub": ("food", "Клуб", "#311B92", 6), "fitness_centre": ("service", "Фитнес", "#E53935", 8),
    "hotel": ("service", "Гостиница", "#5D4037", 8), "internet_cafe": ("service", "Компьютерный клуб", "#311B92", 5),
    # office / craft
    "office": ("office", "Офис", "#455A64", 5), "government": ("office", "Госучреждение", "#1A237E", 6),
    "insurance": ("office", "Страхование", "#0277BD", 5), "estate_agent": ("office", "Недвижимость", "#2E7D32", 5),
    "lawyer": ("office", "Юридические услуги", "#37474F", 4), "notary": ("office", "Нотариус", "#283593", 4),
    "telecommunication": ("office", "Офис связи", "#E53935", 5),
    "shoemaker": ("service", "Ремонт обуви", "#6D4C41", 3), "key_cutter": ("service", "Ключи", "#757575", 3),
    "electronics_repair": ("service", "Ремонт телефонов", "#1E88E5", 4), "watchmaker": ("service", "Ремонт часов", "#5D4037", 3),
    "photographer": ("service", "Фотоателье", "#6A1B9A", 4), "craft": ("service", "Мастерская", "#6D4C41", 4),
}
AMENITY_KEYS = {"cafe", "restaurant", "fast_food", "bar", "pub", "ice_cream", "pharmacy", "bank", "bureau_de_change",
                "money_lender", "post_office", "dentist", "doctors", "clinic", "veterinary", "driving_school", "nightclub",
                "internet_cafe"}
HEALTHCARE_KEYS = {"pharmacy": "pharmacy", "dentist": "dentist", "clinic": "clinic", "laboratory": "laboratory",
                   "doctor": "doctors"}
CRAFT_KEYS = {"shoemaker", "key_cutter", "electronics_repair", "watchmaker", "tailor", "photographer"}
OFFICE_KEYS = {"government", "insurance", "estate_agent", "lawyer", "notary", "telecommunication"}

# известные сети: подстрока (lower) в brand/name -> (цвет вывески, каноническое имя)
CHAINS = [
    ("пятёрочка", "#E31E24", "Пятёрочка"), ("пятерочка", "#E31E24", "Пятёрочка"),
    ("магнит косметик", "#D6006E", "Магнит Косметик"), ("магнит", "#E30613", "Магнит"),
    ("дикси", "#F39200", "Дикси"), ("перекрёсток", "#0A7D3E", "Перекрёсток"), ("перекресток", "#0A7D3E", "Перекрёсток"),
    ("красное&белое", "#8B0D1A", "Красное&Белое"), ("красное и белое", "#8B0D1A", "Красное&Белое"),
    ("бристоль", "#1B3A7A", "Бристоль"), ("вкусвилл", "#2DB34A", "ВкусВилл"), ("лента", "#003D7C", "Лента"),
    ("ашан", "#E2001A", "Ашан"), ("spar", "#00843D", "SPAR"), ("чижик", "#FFD200", "Чижик"),
    ("fix price", "#005BAB", "Fix Price"), ("светофор", "#E30613", "Светофор"), ("ярче", "#E4032E", "Ярче!"),
    ("сбербанк", "#21A038", "СберБанк"), ("сбер", "#21A038", "СберБанк"), ("втб", "#0A2896", "ВТБ"),
    ("промсвязьбанк", "#F26722", "Промсвязьбанк"), ("псб", "#F26722", "ПСБ"), ("россельхозбанк", "#007A3D", "Россельхозбанк"),
    ("альфа-банк", "#EF3124", "Альфа-Банк"), ("альфа банк", "#EF3124", "Альфа-Банк"), ("тинькофф", "#FFDD2D", "Т-Банк"),
    ("т-банк", "#FFDD2D", "Т-Банк"), ("газпромбанк", "#0057A8", "Газпромбанк"), ("совкомбанк", "#0B3E8C", "Совкомбанк"),
    ("почта банк", "#29338A", "Почта Банк"), ("почта россии", "#0055A6", "Почта России"),
    ("ozon", "#005BFF", "Ozon"), ("озон", "#005BFF", "Ozon"), ("wildberries", "#CB11AB", "Wildberries"),
    ("вайлдберриз", "#CB11AB", "Wildberries"), ("сдэк", "#1AB248", "СДЭК"), ("cdek", "#1AB248", "СДЭК"),
    ("boxberry", "#E5003C", "Boxberry"), ("яндекс маркет", "#FFCC00", "Яндекс Маркет"),
    ("мтс", "#E30611", "МТС"), ("билайн", "#FFCC00", "Билайн"), ("мегафон", "#00B956", "МегаФон"),
    ("tele2", "#1F2229", "Tele2"), ("теле2", "#1F2229", "Tele2"), ("ростелеком", "#7700FF", "Ростелеком"),
    ("dns", "#FC8507", "DNS"), ("м.видео", "#E31235", "М.Видео"), ("эльдорадо", "#4F2D7F", "Эльдорадо"),
    ("вкусно — и точка", "#0F4D2C", "Вкусно — и точка"), ("вкусно - и точка", "#0F4D2C", "Вкусно — и точка"),
    ("kfc", "#E4002B", "KFC"), ("rostic", "#E4002B", "Rostic's"), ("бургер кинг", "#D62300", "Бургер Кинг"),
    ("burger king", "#D62300", "Бургер Кинг"), ("додо", "#FF6900", "Додо Пицца"), ("dodo", "#FF6900", "Додо Пицца"),
    ("шоколадница", "#5D3A1A", "Шоколадница"), ("л'этуаль", "#111111", "Л'Этуаль"), ("летуаль", "#111111", "Л'Этуаль"),
    ("золотое яблоко", "#F2C200", "Золотое яблоко"), ("спортмастер", "#0057B8", "Спортмастер"),
    ("детский мир", "#0072BC", "Детский мир"), ("ригла", "#E30613", "Ригла"), ("горздрав", "#00A651", "Горздрав"),
    ("аптека апрель", "#E7287D", "Апрель"), ("36,6", "#E30613", "36,6"), ("инвитро", "#00A0E3", "Инвитро"),
    ("гемотест", "#E30613", "Гемотест"), ("coffee like", "#2F6B3A", "Coffee Like"), ("cofix", "#7B2B83", "Cofix"),
    ("теремок", "#C8102E", "Теремок"), ("subway", "#008C15", "Subway"), ("kari", "#E30613", "Kari"), ("ostin", "#1B1B1B", "O'STIN"), ("ozon банк", "#005BFF", "Ozon Банк"),
]

# процедурные витрины: (подпись, kind, category, цвет, (мин, макс) ширина, вес, варианты названий, часы)
GENERATED = [
    ("Продукты", "shop", "convenience", "#F9A825", (5, 8), 16,
     ["Продукты", "Продукты 24", "Минимаркет", "Магазин «У дома»", "Продукты «Ассорти»", "Универсам", "Продукты «Надежда»"], None),
    ("Аптека", "health", "pharmacy", "#2E7D32", (4, 6), 10, ["Аптека", "Аптечный пункт", "Аптека «Здоровье»", "Аптека 24"], None),
    ("Цветы", "shop", "florist", "#43A047", (3, 5), 7, ["Цветы", "Цветы 24", "Флора", "Мир цветов", "Цветочная лавка"], None),
    ("Шаурма", "food", "fast_food", "#E65100", (3, 5), 6, ["Шаурма", "Шаверма №1", "Шаурма & гриль", "Восточная кухня", "Донер"], None),
    ("Ремонт обуви", "service", "shoemaker", "#6D4C41", (3, 4), 3, ["Ремонт обуви", "Ремонт обуви и ключи"], None),
    ("Салон связи", "shop", "mobile_phone", "#1E88E5", (4, 6), 5, ["Салон связи", "Связной", "Всё для телефонов"], None),
    ("Ломбард", "finance", "pawnbroker", "#FFB300", (3, 5), 4, ["Ломбард", "Ломбард «Золото»", "Скупка"], None),
    ("Парикмахерская", "service", "hairdresser", "#AD1457", (4, 6), 7, ["Парикмахерская", "Салон красоты", "Стрижка", "Барбершоп"], None),
    ("Разливное пиво", "shop", "beer", "#B26A00", (4, 6), 6, ["Разливное пиво", "Пивной двор", "Пенная гавань", "Живое пиво"], None),
    ("Оптика", "shop", "optician", "#00838F", (3, 5), 3, ["Оптика", "Салон оптики"], None),
    ("Одежда", "shop", "clothes", "#6A1B9A", (5, 9), 6, ["Одежда", "Модная одежда", "Секонд-хенд", "Сток-центр"], None),
    ("Обувь", "shop", "shoes", "#4E342E", (4, 7), 3, ["Обувь", "Обувной"], None),
    ("Кафе", "food", "cafe", "#6D4C41", (5, 9), 5, ["Кафе", "Кафе «Встреча»", "Столовая", "Блинная", "Пельменная"], None),
    ("Пекарня", "food", "bakery", "#A1662F", (4, 6), 5, ["Пекарня", "Хлеб", "Свежая выпечка"], None),
    ("Мясо", "shop", "butcher", "#C62828", (3, 5), 3, ["Мясо", "Мясная лавка", "Куры"], None),
    ("Табак", "shop", "tobacco", "#5D4037", (3, 4), 2, ["Табак", "Табачная лавка"], None),
    ("Канцтовары", "shop", "stationery", "#3949AB", (3, 5), 2, ["Канцтовары", "Канцелярия"], None),
    ("Хозтовары", "shop", "hardware", "#6D4C41", (4, 7), 4, ["Хозтовары", "Всё для дома", "Хозяйственный"], None),
    ("Ремонт телефонов", "service", "electronics_repair", "#1E88E5", (3, 4), 4, ["Ремонт телефонов", "Сервис-центр"], None),
    ("Нотариус", "office", "notary", "#283593", (3, 5), 2, ["Нотариус", "Нотариальная контора"], None),
    ("Стоматология", "health", "dentist", "#00ACC1", (4, 7), 3, ["Стоматология", "Зубной кабинет"], None),
    ("Зоотовары", "shop", "pet", "#FB8C00", (3, 5), 3, ["Зоотовары", "Зоомагазин"], None),
    ("Пункт выдачи", "pickup", "outpost", "#5C6BC0", (3, 5), 6, ["Ozon", "Wildberries", "Ozon", "Wildberries", "СДЭК"], None),
    ("Микрозаймы", "finance", "money_lender", "#F9A825", (3, 4), 2, ["Деньги до зарплаты", "Микрозаймы", "Быстроденьги"], None),
    ("Ключи", "service", "key_cutter", "#757575", (2.5, 3), 2, ["Изготовление ключей", "Ключи"], None),
    ("Овощи-фрукты", "shop", "greengrocer", "#689F38", (3, 5), 2, ["Овощи-фрукты", "Фрукты"], None),
    ("Суши", "food", "fast_food", "#D32F2F", (4, 6), 3, ["Суши", "Роллы", "Суши-бар"], None),
    ("Кофе с собой", "food", "cafe", "#4E342E", (3, 4), 3, ["Кофе с собой", "Coffee", "Кофейня"], None),
]

# ширина окна по архетипу — как bWinParams в game/src/world/building-material.ts (шаг — STYLE в archetypes.py)
WIN_W = {"other": 1.4, "panel5": 1.45, "brick5": 1.3, "panel9": 1.5, "tower": 1.4, "stalinka": 1.3, "merchant": 1.1,
         "house": 1.0, "modern": 1.8, "commercial": 3.5, "garage": 2.6, "industrial": 5.4, "church": 1.2, "school": 2.2,
         "public": 1.8, "shed": 0.0}
PODEZD_ARCH = {"panel5", "brick5", "panel9", "tower"}
APART_TAGS = {"apartments", "residential", "dormitory", "flats"}
STEP_RISE = 0.17             # максимальная высота ступени, м
# порог двери подъезда над землёй у края крыльца (остальной подъём до квартир — внутри лестничной клетки)
PODEZD_LIFT = {"panel5": 0.45, "brick5": 0.45, "panel9": 0.6, "tower": 0.6, "stalinka": 0.3, "modern": 0.15}
OFFICE_LIFT = 0.5
SHOP_MAX_LIFT = 1.2          # витрина в жилом доме: высокое крыльцо, но не выше 1.2 м над землёй
SHOP_GRADE_LIFT = 0.3        # торговые здания (commercial): почти в уровень земли

PED_FENCE_STYLES = [("red_white", 0.45), ("grey", 0.25), ("green", 0.15), ("decorative_black", 0.15)]
LAWN_FENCE_STYLES = [("painted_green", 0.35), ("painted_multicolor", 0.25), ("metal_arc", 0.25), ("wood_picket", 0.15)]
FLOWER_PALETTES = 6
GOV_TAGS = {("office", "government"), ("amenity", "townhall"), ("amenity", "courthouse"), ("government", None)}



# Отбойник по оси узких разделителей primary ставится правилом, на спутнике (Первомайский) его не видно — выключен.
MEDIAN_GUARDRAIL = False

def _pick(rng, table):
    p = np.array([w for _, w in table], float)
    return table[int(rng.choice(len(table), p=p / p.sum()))][0]


def _norm_addr(street, num):
    if not street or not num:
        return None
    s = street.lower().replace("ё", "е")
    s = re.sub(r"\b(улица|ул|проспект|пр-т|просп|переулок|пер|площадь|пл|шоссе|ш|проезд|пр-д|бульвар|б-р|набережная|наб)\b\.?", " ", s)
    s = re.sub(r"[^\w]+", " ", s).strip()
    n = re.sub(r"\s+", "", num.lower().replace("ё", "е"))
    return f"{s}|{n}"


def classify_poi(tg):
    """Теги OSM -> ключ CAT или None (не витрина)."""
    sh = tg.get("shop")
    if sh:
        if sh in ("vacant", "no"):
            return None
        return sh if sh in CAT else "shop"
    am = tg.get("amenity")
    if am in AMENITY_KEYS:
        return am
    hc = tg.get("healthcare")
    if hc in HEALTHCARE_KEYS:
        return HEALTHCARE_KEYS[hc]
    if tg.get("leisure") == "fitness_centre":
        return "fitness_centre"
    if tg.get("tourism") in ("hotel", "hostel"):
        return "hotel"
    cr = tg.get("craft")
    if cr:
        return cr if cr in CRAFT_KEYS else "craft"
    if tg.get("beauty"):
        return "beauty"
    of = tg.get("office")
    if of:
        return of if of in OFFICE_KEYS else "office"
    return None


def chain_of(tg):
    for k in ("brand", "name", "operator"):
        v = (tg.get(k) or "").lower()
        if not v:
            continue
        for sub, col, canon in CHAINS:
            if sub in v:
                return col, canon
    return None, None


def parse_pois(path):
    """Узлы OSM с POI -> [(x, y, tags, cat, osm_ref)]."""
    lons, lats, out = [], [], []
    for _, el in ET.iterparse(path):
        if el.tag == "node":
            if len(el):
                tg = {c.get("k"): c.get("v") for c in el.iter("tag")}
                cat = classify_poi(tg)
                if cat is not None:
                    lons.append(float(el.get("lon"))); lats.append(float(el.get("lat")))
                    out.append((tg, cat, "node/" + el.get("id")))
                elif tg.get("barrier") in ("bollard", "lift_gate", "block") or tg.get("historic") in ("memorial", "monument") \
                        or tg.get("amenity") == "fountain" or tg.get("tourism") in ("artwork", "attraction"):   # скульптуры (pedestrian_streets)
                    lons.append(float(el.get("lon"))); lats.append(float(el.get("lat")))
                    out.append((tg, None, "node/" + el.get("id")))
            el.clear()
        elif el.tag in ("way", "relation"):
            el.clear()
    if not out:
        return []
    xs, ys = to_world.transform(np.array(lons), np.array(lats))
    return [(float(x), float(y), tg, cat, ref) for x, y, (tg, cat, ref) in zip(xs, ys, out)]


# ---------------------------------------------------------------------------------------------------------------
class StreetLife:
    def __init__(self, yctx, mctx, crossings, osm_path, log=print, v2=True):
        self.c = yctx
        self.g = yctx.g
        self.mctx = mctx
        self.crossings = crossings or []
        self.osm_path = osm_path
        self.log = log
        self.use_v2 = v2
        self.roads = yctx.roads
        self.stats = defaultdict(int)
        self.tiles_sf = defaultdict(list)
        self.tiles_ent = defaultdict(list)
        self.clear = []                 # (x, y, r): вокруг новых объектов деревья/кусты убираются
        self.lamps_xy = []              # все фонари (старые + новые) для проверки дублей
        self.slots = defaultdict(list)  # id ребра фасада -> [(s0, s1)] занятые интервалы
        self.edge_sf = defaultdict(list)  # id ребра -> витрины

    # ---------------- утилиты
    def rng(self, *key):
        return self.c.rng(SEED, *key)

    def terrain(self, x, y):
        c = self.c
        return c.grid.sample(c.H, np.asarray(x, float), np.asarray(y, float)) - c.base

    def add(self, typ, x, y, rot, yv=None, clear=0.0, stamp=0.0, scale=1.0, **extra):
        self.c.add(typ, x, y, rot, scale, yv=yv, **extra)
        if stamp > 0:
            self.c.stamp(x, y, stamp)
        if clear > 0:
            self.clear.append((x, y, clear))
        self.stats[typ] += 1

    def seg(self, typ, a, b, ya, yb, height, clear=True, **extra):
        rec = {"type": typ, "x1": round(float(a[0]), 2), "y1": round(float(ya), 2), "z1": round(float(-a[1]), 2),
               "x2": round(float(b[0]), 2), "y2": round(float(yb), 2), "z2": round(float(-b[1]), 2),
               "height": round(float(height), 2)}
        rec.update(extra)
        mid = (np.asarray(a, float) + np.asarray(b, float)) / 2
        self.c.tiles_segs[self.c.tile_key(*mid)].append(rec)
        self.c.stats[typ] += 1
        self.stats[typ] += 1
        self.stats[typ + "_m"] += float(np.hypot(*(np.asarray(b) - np.asarray(a))))
        if clear:
            L = float(np.hypot(*(np.asarray(b) - np.asarray(a))))
            for t in np.linspace(0, 1, max(2, int(L / 1.5) + 1)):
                p = np.asarray(a) + (np.asarray(b) - np.asarray(a)) * t
                self.clear.append((float(p[0]), float(p[1]), 0.3))

    def polyline_segs(self, typ, P, yfun, height, seg_len=3.0, **extra):
        """Ломаная -> сегменты ≤ seg_len, y по yfun(x, y)."""
        P = np.asarray(P, float)
        if len(P) < 2 or cumlen(P)[-1] < 0.5:
            return 0
        P = np.asarray(LineString(P).simplify(0.1).coords)     # частые точки выборки -> вершины ломаной
        Q = resample(P, seg_len)
        if len(Q) < 2:
            return 0
        y = yfun(Q[:, 0], Q[:, 1])
        for i in range(len(Q) - 1):
            self.seg(typ, Q[i], Q[i + 1], y[i], y[i + 1], height, **extra)
        return len(Q) - 1

    def free(self, x, y, forbid, radius=0.0):
        return self.c.free(np.atleast_1d(x), np.atleast_1d(y), forbid, radius)

    # ---------------- растр «индекс дороги»
    def build_rid(self):
        c = self.c
        shapes = []
        for i, r in enumerate(self.roads):
            if len(r.axis) < 2 or r.tunnel:
                continue
            hw = max(r.Wf, r.Wb) if r.bwd is not None else r.Wf / 2
            shapes.append((RANK.get(base_class(r.hw), 1), LineString(r.axis).buffer(hw, cap_style="flat", quad_segs=2), i + 1))
        shapes.sort(key=lambda t: t[0])
        self.RID = features.rasterize(((g, v) for _, g, v in shapes), out_shape=c.M.shape, transform=c.tr,
                                      dtype="int32", fill=0)
        self.rank = np.array([RANK.get(base_class(r.hw), 1) for r in self.roads] + [0])

    def rid_at(self, x, y):
        c = self.c
        r, cc = c.rc(x, y)
        ok = (r >= 0) & (r < c.rows) & (cc >= 0) & (cc < c.cols)
        out = np.zeros(np.shape(r), np.int32)
        out[ok] = self.RID[r[ok], cc[ok]]
        return out

    def probe(self, P, N, dmax=45.0, step=1.0, start=1.5):
        """Луч из P по N: первая проезжая часть (индекс дороги или -1), расстояние, перекрыт ли зданием раньше."""
        ds = np.arange(start, dmax + 1e-6, step)
        X = P[:, 0, None] + N[:, 0, None] * ds
        Y = P[:, 1, None] + N[:, 1, None] * ds
        rid = self.rid_at(X, Y)
        bld = (self.c.m(X, Y) & BLD) != 0
        hit = rid > 0
        anyh = hit.any(1)
        first = hit.argmax(1)
        bfirst = np.where(bld.any(1), bld.argmax(1), 10 ** 6)
        road = np.where(anyh, rid[np.arange(len(P)), first] - 1, -1)
        dist = np.where(anyh, ds[first], np.inf)
        blocked = anyh & (bfirst < first)
        return road, dist, blocked

    # ---------------- здания v2 (архетип, цоколь, сетка окон, секции)
    def load_v2(self):
        """Классификация зданий v2 (кэш city_buildings): архетип, высота пола 1-го этажа, шаг окон, число подъездов."""
        self.v2 = None
        if not self.use_v2:
            return
        from . import city_buildings as CB
        from .archetypes import STYLE
        c = self.c
        specs, _ = CB.classify_cached(c.osm, self.osm_path,
                                      lambda x, y: c.min_x + 1 < x < c.max_x - 1 and c.min_y + 1 < y < c.max_y - 1, self.log)
        groups = defaultdict(list)
        for sp in specs:
            groups[sp.tile_pt].append(sp)
        v2 = {}
        for tp, ss in groups.items():
            base = CB.ground_level(ss, c.grid, c.H, c.base)
            plan = CB.ground_plan(ss, c.grid, c.H, c.base) if hasattr(CB, "ground_plan") else None
            for sp in ss:
                # здание с building:part строится частями (ключ тот же, part=True): берём основной объём, иначе крупнейшую часть
                old = v2.get(sp.key)
                if old is not None and (old["part"] < sp.part or old["part"] == sp.part and old["area"] >= sp.poly.area):
                    continue
                v2[sp.key] = {"part": sp.part, "arch": sp.arch, "plinth": sp.plinth, "fh": sp.fh, "levels": sp.levels,
                              "sections": sp.sections, "S": STYLE[sp.arch][2], "ww": WIN_W.get(sp.arch, 1.4),
                              "base": base, "floor": base + sp.plinth, "area": sp.poly.area, "plan": plan}
        self.v2 = v2
        # части building:part имеют свои ключи (путь части) — для зданий, построенных частями, ищем по геометрии
        self.v2_parts = [(sp.poly, v2[sp.key]) for sp in specs if sp.part and sp.key in v2]
        self.v2_ptree = shapely.STRtree([p for p, _ in self.v2_parts]) if self.v2_parts else None
        self.stats["v2_buildings"] = len(v2)

    def v2_for(self, key, poly):
        v = self.v2.get(key)
        if v is not None or self.v2_ptree is None:
            return v
        best = None
        for i in self.v2_ptree.query(poly, predicate="intersects"):
            pp, info = self.v2_parts[i]
            if poly.contains(pp.representative_point()) and (best is None or pp.area > best[0]):
                best = (pp.area, info)
        return best[1] if best else None

    def grid_of(self, e):
        """Сетка окон стены e как в шейдере зданий v2: (шаг, число колонок, отступ первой колонки, ширина окна) или None."""
        v = self.blds[self.EBI[e]].get("v2")
        if not v or v["ww"] <= 0:
            return None
        S, L = v["S"], self.EL[e]
        n = int(max(L - 1.2, 0.0) // S)
        return S, n, (L - n * S) / 2, v["ww"]

    def snap_door(self, e, s):
        """Дверь — на простенке между колонками окон (ближайший к s), не ближе 0.8 м к углу."""
        gr = self.grid_of(e)
        if gr is None or gr[1] == 0:
            return s
        S, n, st, _ = gr
        piers = st + np.arange(n + 1) * S
        piers = piers[(piers >= 0.8) & (piers <= self.EL[e] - 0.8)]
        if not len(piers):
            return s
        hw = 0.8
        ok = [p for p in piers if self.same_section(e, p - hw - 0.3, p + hw + 0.3)]   # дверь не на стыке секций
        piers = np.array(ok) if ok else piers
        return float(piers[np.argmin(np.abs(piers - s))])

    def floor_at(self, b, p, e=None):
        """Пол 1-го этажа здания v2 у точки стены p (секция со ступенчатым полом на склоне)."""
        v = b["v2"]
        if v.get("plan") is None:
            return v["floor"]
        q = p - self.EN[e] * 0.5 if e is not None else p
        return float(v["plan"].floor_at(float(q[0]), float(q[1])))

    def section_of(self, e, s):
        """Индекс секции плана пола у точки стены (s — м от начала ребра); None без ступенчатого плана."""
        b = self.blds[self.EBI[e]]
        v = b.get("v2")
        plan = v.get("plan") if v else None
        if plan is None or not getattr(plan, "stepped", False) or len(plan.sections) < 2:
            return None
        q = self.edge_point(e, s) - self.EN[e] * 0.5
        pt = Point(float(q[0]), float(q[1]))
        return int(np.argmin([sec[0].distance(pt) for sec in plan.sections]))

    def same_section(self, e, s0, s1):
        a = self.section_of(e, s0 + 0.3)
        return a is None or a == self.section_of(e, s1 - 0.3)

    def door_width(self, e, kind):
        gr = self.grid_of(e)
        w = 1.4 if kind == "podezd" else 1.1
        if gr is not None and gr[1] > 0:
            w = float(np.clip(gr[0] - gr[3] - 0.2, 0.9, w))
        return w

    # ---------------- здания и фасады
    def build_facades(self):
        c = self.c
        self.blds = []
        EA, EB, EN, EL, EBI = [], [], [], [], []
        for poly, tg, oid in c.osm.buildings():
            if tg.get("building") in B.SKIP:
                continue
            rp = poly.representative_point()
            if not c.inside(rp.x, rp.y, 1):
                continue
            key = ("w" if oid in c.osm.ways and c.osm.ways[oid][1] is tg else "r") + str(oid)
            v2 = self.v2_for(key, poly) if self.v2 is not None else None
            if self.v2 is not None and v2 is None:
                continue                 # здания v2 не строят (навесы, стройки, вне мира) — и мы не трогаем
            cat = B.category(tg)
            hgt, _ = B.height_of(tg, cat)
            if v2 is not None:
                hgt = v2["plinth"] + v2["levels"] * v2["fh"]
            parts = [p for p in B.polygons(poly.simplify(0.2, preserve_topology=True)) if p.area >= 4]
            if not parts:
                continue
            bi = len(self.blds)
            lv = B.parse_numbers(tg.get("building:levels")) if hasattr(B, "parse_numbers") else None
            levels = int(max(lv)) if lv else (round((hgt - 1) / 3) if cat != "garage" else 1)
            if v2 is not None:
                levels = v2["levels"]
            b = {"oid": oid, "key": key, "v2": v2, "tags": tg, "cat": cat, "h": hgt, "levels": max(levels, 1), "parts": parts,
                 "poly": poly, "edges": [], "area": sum(p.area for p in parts)}
            ext_all = np.concatenate([np.asarray(p.exterior.coords) for p in parts])
            b["base"] = float(self.terrain(ext_all[:, 0], ext_all[:, 1]).min())
            b["tmax"] = float(self.terrain(ext_all[:, 0], ext_all[:, 1]).max())
            for pi, part in enumerate(parts):
                ring = np.asarray(orient(part, 1.0).exterior.coords)
                a, bb = ring[:-1], ring[1:]
                d = bb - a
                L = np.hypot(*d.T)
                for k in np.nonzero(L >= 1.0)[0]:
                    n = np.array([d[k, 1], -d[k, 0]]) / L[k]     # CCW -> наружу справа
                    b["edges"].append(len(EA))
                    EA.append(a[k]); EB.append(bb[k]); EN.append(n); EL.append(L[k]); EBI.append(bi)
            self.blds.append(b)
        self.EA, self.EB, self.EN = np.array(EA), np.array(EB), np.array(EN)
        self.EL, self.EBI = np.array(EL), np.array(EBI)
        # улица перед каждым ребром: лучи из 3 точек ребра, лучший незаблокированный
        best_d = np.full(len(EA), np.inf); best_r = np.full(len(EA), -1)
        for t in (0.25, 0.5, 0.75):
            P = self.EA + (self.EB - self.EA) * t + self.EN * 0.3
            road, dist, blocked = self.probe(P, self.EN)
            ok = (road >= 0) & ~blocked & (dist < best_d)
            best_d[ok] = dist[ok]; best_r[ok] = road[ok]
        self.Ed, self.Er = best_d, best_r
        self.Erank = self.rank[np.where(best_r >= 0, best_r, len(self.roads))]
        self.part_tree = shapely.STRtree([p for b in self.blds for p in b["parts"]])
        self.part_bi = np.array([bi for bi, b in enumerate(self.blds) for _ in b["parts"]])
        # адреса
        self.addr = defaultdict(list)
        for bi, b in enumerate(self.blds):
            k = _norm_addr(b["tags"].get("addr:street"), b["tags"].get("addr:housenumber"))
            if k:
                self.addr[k].append(bi)
        self.stats["buildings"] = len(self.blds)
        self.stats["facade_edges"] = len(EA)

    def edge_point(self, e, s):
        a, b = self.EA[e], self.EB[e]
        return a + (b - a) * (s / self.EL[e])

    def edge_free(self, e, s0, s1, gap=0.5):
        if s0 < 0.59 or s1 > self.EL[e] - 0.59:
            return False
        return all(s1 + gap <= a or s0 - gap >= b for a, b in self.slots[e])

    def find_slot(self, e, center, width, gap=0.5):
        """Ближайший к center свободный интервал ~width на ребре e -> (s0, s1) или None.
        У зданий v2 витрина занимает целое число пролётов сетки окон (как витрины 1-го этажа в шейдере)."""
        gr = self.grid_of(e)
        if gr is not None:
            S, n, st, _ = gr
            if n == 0:
                return None
            for m in range(int(np.clip(round(width / S), 1, n)), 0, -1):
                ks = np.arange(0, n - m + 1)
                ks = ks[np.argsort(np.abs(st + (ks + m / 2) * S - center), kind="stable")]
                for k in ks:
                    s0, s1 = st + k * S, st + (k + m) * S
                    if self.edge_free(e, s0, s1, 0.05) and self.same_section(e, s0, s1):
                        return float(s0), float(s1)
            return None
        L = self.EL[e]
        if width > L - 1.2:
            return None
        lo, hi = 0.6 + width / 2, L - 0.6 - width / 2
        c0 = float(np.clip(center, lo, hi))
        for d in np.r_[0, np.repeat(np.arange(0.5, L, 0.5), 2) * np.tile([1, -1], len(np.arange(0.5, L, 0.5)))]:
            cc = c0 + d
            if cc < lo or cc > hi:
                continue
            if self.edge_free(e, cc - width / 2, cc + width / 2, gap):
                return cc - width / 2, cc + width / 2
        return None

    # ---------------- витрины
    def sf_record(self, e, s0, s1, b, info):
        a = self.edge_point(e, s0); bpt = self.edge_point(e, s1)
        n = self.EN[e]
        ya, yb = self.terrain([a[0], bpt[0]], [a[1], bpt[1]])
        gf = 3.2 if b["cat"] in ("apartments", "house") else 4.0
        if info.get("category") in ("mall", "department_store", "supermarket"):
            gf = max(gf, 4.5)
        gf = float(min(gf, b["h"] - 0.5)) if b["h"] > 3.5 else float(b["h"] * 0.8)
        v2 = b.get("v2")
        if v2 is not None:
            gf = v2["fh"]
        rd = self.roads[self.Er[e]] if self.Er[e] >= 0 else None
        rec = {"x1": round(float(a[0]), 2), "y1": round(float(ya), 2), "z1": round(float(-a[1]), 2),
               "x2": round(float(bpt[0]), 2), "y2": round(float(yb), 2), "z2": round(float(-bpt[1]), 2),
               "nx": round(float(n[0]), 4), "nz": round(float(-n[1]), 4),
               "width": round(float(s1 - s0), 2), "height": round(gf, 2), "baseY": round(b["base"], 2)}
        if v2 is not None:
            mid_ground = float(self.terrain([(a[0] + bpt[0]) / 2 + n[0]], [(a[1] + bpt[1]) / 2 + n[1]])[0])
            fl = self.floor_at(b, (a + bpt) / 2, e)
            grade = v2["arch"] == "commercial"
            door_y = min(fl, mid_ground + (SHOP_GRADE_LIFT if grade else SHOP_MAX_LIFT)) if fl >= mid_ground else mid_ground
            steps, rise = self._steps_to(door_y, mid_ground)
            rec.update({"floorY": round(fl, 2), "doorY": round(door_y, 2), "steps": steps, "baseY": round(v2["base"], 2)})
            if fl < mid_ground:
                rec["floorBelowGround"] = round(mid_ground - fl, 2)
                self.stats["storefronts_floor_below_ground"] += 1
        rec.update(info)
        if rd is not None and rd.name:
            rec["street"] = rd.name
        elif getattr(self, "ped_edges", {}).get(e):
            rec["street"] = self.ped_edges[e]
        st, hn = b["tags"].get("addr:street"), b["tags"].get("addr:housenumber")
        if st and hn:
            rec["address"] = f"{st}, {hn}"
        rec["building"] = b["oid"]
        self.slots[e].append((s0, s1))
        mid = (a + bpt) / 2
        self.tiles_sf[self.c.tile_key(*mid)].append(rec)
        self.edge_sf[e].append(rec)
        b.setdefault("sf_edges", set()).add(e)
        self.stats["storefronts_generated" if info.get("generated") else "storefronts_osm"] += 1
        return rec

    def storefronts_osm(self, pois):
        """POI OSM -> здание -> фасад к улице -> интервал на фасаде."""
        c = self.c
        by_b = defaultdict(list)
        # POI-полигоны (здания с shop=*, торговые зоны)
        way_pois = []
        oid2bi = {b["oid"]: bi for bi, b in enumerate(self.blds)}
        for wid, (refs, tg) in c.osm.ways.items():
            cat = classify_poi(tg) if tg else None
            if cat is None:
                continue
            if wid in oid2bi:
                b = self.blds[oid2bi[wid]]
                rp = b["poly"].representative_point()
                way_pois.append((rp.x, rp.y, tg, cat, f"way/{wid}", oid2bi[wid]))
            elif len(refs) > 3 and refs[0] == refs[-1]:
                xy = c.osm.way_xy(wid)
                if len(xy) >= 4:
                    p = Polygon(xy)
                    if p.is_valid and p.area > 0:
                        rp = p.representative_point()
                        way_pois.append((rp.x, rp.y, tg, cat, f"way/{wid}", None))
        allp = [(x, y, tg, cat, ref, None) for x, y, tg, cat, ref in pois if cat is not None] + way_pois
        n_unassigned = 0
        for x, y, tg, cat, ref, bi in allp:
            if not c.inside(x, y, 5):
                continue
            if cat in ("kiosk",):
                self.stats["poi_kiosk_skipped"] += 1
                continue
            if bi is None:
                pt = Point(x, y)
                idx = self.part_tree.query(pt, predicate="intersects")
                if len(idx):
                    bi = int(self.part_bi[idx[0]])
                else:
                    near = self.part_tree.query_nearest(pt, max_distance=12.0)
                    if len(near):
                        bi = int(self.part_bi[near[0]])
                if bi is None:
                    k = _norm_addr(tg.get("addr:street"), tg.get("addr:housenumber"))
                    cand = [j for j in self.addr.get(k, []) if self.blds[j]["poly"].distance(pt) < 400]
                    if cand:
                        bi = min(cand, key=lambda j: self.blds[j]["poly"].distance(pt))
                        self.stats["poi_by_address"] += 1
            if bi is None:
                n_unassigned += 1
                continue
            if self.blds[bi]["cat"] == "garage" and cat not in ("car_repair", "tyres", "car_parts"):
                pass
            by_b[bi].append((x, y, tg, cat, ref))
        self.stats["poi_unassigned"] = n_unassigned
        # торговые центры — первыми (большая вывеска), дальше по размеру витрины
        for bi, lst in by_b.items():
            b = self.blds[bi]
            lst.sort(key=lambda t: (-CAT[t[3]][3], t[4]))
            edges = np.array(b["edges"])
            if len(edges) == 0:
                continue
            for j, (x, y, tg, cat, ref) in enumerate(lst):
                kind, label, col, w = CAT[cat]
                ccol, canon = chain_of(tg)
                rng = self.rng(1, bi, j)
                # кандидаты: фасады к улицам (rank>=2) -> к проездам -> любые; ближе к POI — лучше
                p = np.array([x, y])
                A, Bq = self.EA[edges], self.EB[edges]
                d = Bq - A
                t = np.clip(((p - A) * d).sum(1) / np.maximum((d * d).sum(1), 1e-9), 0, 1)
                dist = np.hypot(*(A + d * t[:, None] - p).T)
                street = np.isfinite(self.Ed[edges]) & (self.Ed[edges] <= 40)
                score = dist + np.where(street & (self.Erank[edges] >= 2), 0, np.where(street, 25, 60)) \
                    - self.Erank[edges] * 2 - np.minimum(self.EL[edges], 20) * 0.3
                placed = False
                for k in np.argsort(score, kind="stable")[:6]:
                    e = int(edges[k])
                    if self.EL[e] < 3.0:
                        continue
                    width = float(min(w * rng.uniform(0.85, 1.15), self.EL[e] * 0.8))
                    for wtry in (width, max(3.0, width * 0.6), 3.0):
                        iv = self.find_slot(e, t[k] * self.EL[e], wtry)
                        if iv is not None:
                            break
                    if iv is None:
                        continue
                    name = tg.get("name") or tg.get("brand") or canon or label
                    brand = tg.get("brand") or canon
                    info = {"kind": kind, "category": cat, "label": label, "name": name, "signText": canon or name,
                            "signColor": ccol or col, "generated": False, "osm": ref,
                            "facing": "street" if street[k] and self.Erank[e] >= 2 else ("service" if street[k] else "other")}
                    if brand:
                        info["brand"] = brand
                    if tg.get("opening_hours"):
                        info["hours"] = tg["opening_hours"]
                    self.sf_record(e, iv[0], iv[1], b, info)
                    placed = True
                    break
                if not placed:
                    self.stats["poi_no_room"] += 1

    def storefronts_generated(self):
        """Процедурные витрины на первых этажах вдоль магистралей (tertiary и выше)."""
        table = GENERATED
        wts = np.array([t[5] for t in table], float); wts /= wts.sum()
        ok_build = {"apartments", "residential", "commercial", "retail", "yes", "office", "mixed"}
        for bi, b in enumerate(self.blds):
            tg = b["tags"]
            if tg.get("building", "yes") not in ok_build or b["area"] < 120 or b["levels"] < 2:
                continue
            if tg.get("amenity") in ("school", "kindergarten", "hospital", "university", "college", "place_of_worship") \
                    or tg.get("office") == "government" or tg.get("historic"):
                continue
            has_real = bool(b.get("sf_edges"))
            for e in b["edges"]:
                if self.EL[e] < 7.0 or not np.isfinite(self.Ed[e]) or self.Ed[e] > 30 or self.Erank[e] < 3:
                    continue
                m = self.EA[e] + (self.EB[e] - self.EA[e]) * 0.5
                if not (self.c.m(np.array([m[0]]), np.array([m[1]]))[0] & URBAN):
                    continue
                rk = self.Erank[e]
                p = {5: 0.55, 4: 0.5, 3: 0.32}.get(int(rk), 0.8)     # 6 — пешеходная улица (pedestrian_streets)
                if b["cat"] == "commercial" or tg.get("building") in ("commercial", "retail"):
                    p = min(0.8, p * 1.5)
                if has_real:
                    p *= 0.4
                rng = self.rng(2, bi, e)
                gr = self.grid_of(e)
                if gr is not None:      # v2: группы по 1–3 пролёта сетки окон
                    S, n, st, _ = gr
                    k = int(rng.integers(0, 2))
                    while k < n:
                        j = int(rng.choice(len(table), p=wts))
                        label, kind, cat, col, (w0, w1), _, names, hours = table[j]
                        m = int(np.clip(round(rng.uniform(w0, w1) / S), 1, 3))
                        s0, s1 = st + k * S, st + (k + m) * S
                        if k + m <= n and rng.random() < p and self.edge_free(e, s0, s1, 0.05) and self.same_section(e, s0, s1):
                            name = names[int(rng.integers(len(names)))]
                            ccol, canon = chain_of({"name": name})
                            info = {"kind": kind, "category": cat, "label": label, "name": name, "signText": canon or name,
                                    "signColor": ccol or col, "generated": True, "facing": "street"}
                            if canon:
                                info["brand"] = canon
                            if name.endswith("24"):
                                info["hours"] = "24/7"
                            self.sf_record(e, s0, s1, b, info)
                            k += m + (1 if rng.random() < 0.3 else 0)
                        else:
                            k += 1
                    continue
                s = 0.8 + rng.uniform(0, 3)
                L = self.EL[e]
                while s < L - 3.5:
                    k = int(rng.choice(len(table), p=wts))
                    label, kind, cat, col, (w0, w1), _, names, hours = table[k]
                    w = float(rng.uniform(w0, w1))
                    if s + w > L - 0.8:
                        w = L - 0.8 - s
                        if w < 2.5:
                            break
                    if rng.random() < p and self.edge_free(e, s, s + w):
                        name = names[int(rng.integers(len(names)))]
                        ccol, canon = chain_of({"name": name})
                        info = {"kind": kind, "category": cat, "label": label, "name": name, "signText": canon or name,
                                "signColor": ccol or col, "generated": True, "facing": "street"}
                        if canon:
                            info["brand"] = canon
                        if name.endswith("24"):
                            info["hours"] = "24/7"
                        self.sf_record(e, s, s + w, b, info)
                        s += w + rng.uniform(0.6, 2.5)
                    else:
                        s += w * 0.6 + rng.uniform(1.0, 4.0)

    # ---------------- входы
    @staticmethod
    def _steps_to(floor, ground):
        """Ступени от земли до пола 1-го этажа: (число, фактический подъём м); подъём < 0 — пол ниже земли."""
        rise = floor - ground
        if rise <= 0.05:
            return 0, round(rise, 2)
        return int(min(math.ceil(rise / STEP_RISE), 20)), round(rise, 2)

    def _steps(self, b, ground, kind, p=None, t=None):
        if kind == "podezd":
            # пол первого этажа секции: макс. рельеф у стены в ±8 м от двери + цоколь 0.45 м
            ss = np.linspace(-8, 8, 9)
            q = p[None, :] + ss[:, None] * t[None, :]
            floor = float(self.terrain(q[:, 0], q[:, 1]).max()) + 0.45
        else:
            floor = ground + 0.15
        dh = max(0.0, floor - ground)
        n = int(np.clip(round(dh / 0.15), 0 if kind != "podezd" else 1, 14))
        return n, round(n * 0.15, 2)

    def entrance_record(self, b, e, s, kind, ref=None, osm=None, generated=False, rng=None):
        s = self.snap_door(e, s)
        p = self.edge_point(e, s)
        n = self.EN[e]
        v2 = b.get("v2")
        if v2 is not None:
            # крыльцо: площадка 1.2 м на уровне порога двери + ступени вниз до земли у края крыльца.
            # Порог подъезда — земля + 0.15…0.6 м (по архетипу), не выше пола квартир 1-го этажа (floor_at):
            # остальной подъём — внутри лестничной клетки. Порог не ниже земли у самой стены (+0.15).
            ground = float(self.terrain([p[0] + n[0] * (1.2 + 0.6)], [p[1] + n[1] * (1.2 + 0.6)])[0])
            wall_g = float(self.terrain([p[0] + n[0] * 0.2], [p[1] + n[1] * 0.2])[0])
            fl = self.floor_at(b, p, e)
            lift = PODEZD_LIFT.get(v2["arch"], 0.3) if kind == "podezd" else (OFFICE_LIFT if kind == "office" else SHOP_MAX_LIFT)
            door_y = max(ground + lift, wall_g + 0.15)
            if fl >= ground:
                door_y = min(door_y, max(fl, wall_g + 0.15))
            steps, sh = self._steps_to(door_y, ground)
            if fl < ground:
                self.stats["entrances_floor_below_ground"] += 1
        else:
            ground = float(self.terrain([p[0] + n[0] * 1.0], [p[1] + n[1] * 1.0])[0])
            steps, sh = self._steps(b, ground, kind, p, (self.EB[e] - self.EA[e]) / self.EL[e])
        rng = rng or self.rng(3, b["oid"] % 100000, e, int(s * 10))
        canopy = rng.random() < {"podezd": 0.9, "office": 0.5, "shop": 0.35}[kind]
        lamp = rng.random() < {"podezd": 0.85, "office": 0.5, "shop": 0.4}[kind]
        rec = {"type": kind, "x": round(float(p[0]), 2), "y": round(ground, 2), "z": round(float(-p[1]), 2),
               "rotY": round(float(rot_of(*n)), 3), "nx": round(float(n[0]), 4), "nz": round(float(-n[1]), 4),
               "width": self.door_width(e, kind), "height": 2.1, "canopy": bool(canopy), "lamp": bool(lamp),
               "steps": steps, "stepsHeight": max(sh, 0.0), "generated": generated, "building": b["oid"]}
        if v2 is not None:
            rec.update({"doorY": round(door_y, 2), "floorY": round(fl, 2), "porchDepth": 1.2 if steps > 0 else 0.0,
                        "stepRise": round(sh / steps, 3) if steps else 0.0, "stepDepth": 0.3})
            if fl < ground:     # склон: земля у двери выше пола 1-го этажа здания v2
                rec["floorBelowGround"] = round(ground - fl, 2)
        if ref:
            rec["ref"] = str(ref)
        if osm:
            rec["osm"] = osm
        self.tiles_ent[self.c.tile_key(*p)].append(rec)
        self.slots[e].append((s - 0.9, s + 0.9))
        b.setdefault("entrances", []).append((e, s, kind))
        self.stats[f"entrances_{kind}_{'gen' if generated else 'osm'}"] += 1
        return rec

    def entrances_osm(self):
        c = self.c
        for j, (x, y, tg) in enumerate(c.points.of("entrance")):
            if not c.inside(x, y, 3) or tg.get("entrance") in ("emergency", "service", "garage", "no"):
                continue
            pt = Point(x, y)
            near = self.part_tree.query_nearest(pt, max_distance=4.0)
            if len(near) == 0:
                continue
            bi = int(self.part_bi[near[0]])
            b = self.blds[bi]
            edges = np.array(b["edges"])
            A, Bq = self.EA[edges], self.EB[edges]
            d = Bq - A
            t = np.clip(((np.array([x, y]) - A) * d).sum(1) / np.maximum((d * d).sum(1), 1e-9), 0, 1)
            dist = np.hypot(*(A + d * t[:, None] - [x, y]).T)
            k = int(np.argmin(dist))
            e = int(edges[k])
            s = float(np.clip(t[k] * self.EL[e], 0.7, max(self.EL[e] - 0.7, 0.7)))
            ent = tg.get("entrance")
            if ent == "staircase" or (b["cat"] == "apartments" and ent in ("yes", "home", "main")):
                kind = "podezd"
            elif b.get("sf_edges") or tg.get("shop"):
                kind = "shop"
            else:
                kind = "office"
            self.entrance_record(b, e, s, kind, ref=tg.get("ref") or tg.get("addr:flats"), osm=f"entrance#{j}",
                                 rng=self.rng(4, j))

    def entrances_inferred(self):
        """Подъезды многоквартирных домов без входов в OSM: со стороны двора, по секциям."""
        c = self.c
        out = []
        for bi, b in enumerate(self.blds):
            v2 = b.get("v2")
            if v2 is not None:
                resid = v2["arch"] in PODEZD_ARCH or (v2["arch"] in ("stalinka", "modern", "other")
                                                       and b["tags"].get("building") in APART_TAGS)
                if not resid or b["area"] < 150 or b.get("entrances"):
                    continue
            elif b["cat"] != "apartments" or b["area"] < 150 or b.get("entrances"):
                continue
            part = max(b["parts"], key=lambda p: p.area)
            mrr = np.asarray(part.minimum_rotated_rectangle.exterior.coords)
            e1, e2 = mrr[1] - mrr[0], mrr[2] - mrr[1]
            l1, l2 = np.hypot(*e1), np.hypot(*e2)
            if l1 < 1 or l2 < 1:
                continue
            u, L, W = (e1 / l1, l1, l2) if l1 >= l2 else (e2 / l2, l2, l1)
            v = np.array([-u[1], u[0]])
            ctr = mrr[:4].mean(0)
            lv = b["levels"]
            sec = 15.0 if lv <= 5 else 18.0 if lv <= 8 else 24.0 if lv <= 12 else 27.0
            n = 1 if (lv >= 12 and L < 35) else max(1, int(round(L / sec)))
            if v2 is not None:
                n = int(max(1, v2["sections"]))     # реестр ЖКХ (entrances) или длина / секция архетипа
            edges = [e for e in b["edges"] if self.EL[e] >= 3.0]
            if not edges:
                continue
            # сторона двора: меньше «улицы» (класс и длина фасадов к дорогам residential+), витрины — точно улица
            scores = []
            for sv in (v, -v):
                sc = 0.0
                for e in edges:
                    if self.EN[e] @ sv < 0.7:
                        continue
                    if e in b.get("sf_edges", ()):
                        sc += 1000
                    if np.isfinite(self.Ed[e]) and self.Ed[e] <= 40:
                        rk = self.Erank[e]
                        sc += self.EL[e] * (rk if rk >= 2 else -0.7) * (1.0 - self.Ed[e] / 60)
                scores.append(sc)
            rng = self.rng(5, bi)
            if abs(scores[0] - scores[1]) < 1e-6:
                sv = v if rng.random() < 0.5 else -v
            else:
                sv = v if scores[0] < scores[1] else -v
            side_edges = [e for e in edges if self.EN[e] @ sv >= 0.7]
            if not side_edges:
                continue
            ring = part.exterior
            got = []
            for k in range(n):
                tk = -L / 2 + (k + 0.5) * L / n
                o = ctr + u * tk
                ray = LineString([o - sv * (W + 5), o + sv * (W + 5)])
                x = ray.intersection(ring)
                pts = [np.array(g.coords[0]) for g in getattr(x, "geoms", [x]) if g.geom_type == "Point"] if not x.is_empty else []
                if not pts:
                    continue
                q = max(pts, key=lambda p: (p - o) @ sv)
                # ребро, на котором лежит точка
                best = None
                for e in side_edges:
                    a, bq = self.EA[e], self.EB[e]
                    dd = bq - a
                    t = float(np.clip((q - a) @ dd / (dd @ dd), 0, 1))
                    dist = np.hypot(*(a + dd * t - q))
                    if dist < 0.3 and (best is None or dist < best[0]):
                        best = (dist, e, t * self.EL[e])
                if best is None:
                    continue
                _, e, s = best
                if s < 1.0 or s > self.EL[e] - 1.0:
                    continue
                s = self.snap_door(e, s)
                if any(e == e2 and abs(s - s2) < 1.0 for e2, s2 in got) or not self.edge_free(e, s - 0.9, s + 0.9, 0.1):
                    continue
                p = self.edge_point(e, s) + self.EN[e] * 1.5
                if not self.free(p[0], p[1], BLD | WATER | ROAD)[0]:
                    continue
                got.append((e, s))
            # нумерация вдоль дома
            got.sort(key=lambda es: float(self.edge_point(*es) @ u))
            for k, (e, s) in enumerate(got):
                rec = self.entrance_record(b, e, s, "podezd", ref=k + 1, generated=True, rng=self.rng(6, bi, k))
                out.append((bi, e, s, rec))
            if got:
                b["yard_side"] = sv
        return out

    def entrance_furniture(self, ents):
        """Лавочки, урны и клумбы у выведенных подъездов (у подъездов из OSM лавочки ставит props.py)."""
        F = BLD | WATER | ROAD | CORR | PROP | PARKING
        for bi, e, s, rec in ents:
            rng = self.rng(7, bi, e, int(s * 10))
            p = self.edge_point(e, s); n = self.EN[e]
            t = (self.EB[e] - self.EA[e]) / self.EL[e]
            side = 1 if rng.random() < 0.5 else -1
            if rng.random() < 0.65:
                q = p + n * 2.3 + t * side * 2.2
                if self.free(q[0], q[1], F, 0.8)[0]:
                    self.add("bench", q[0], q[1], float(rot_of(*n)), clear=1.3, stamp=1.0)
            if rng.random() < 0.5:
                q = p + n * 1.7 - t * side * 1.5
                if self.free(q[0], q[1], F, 0.3)[0]:
                    self.add("trash_bin", q[0], q[1], float(rot_of(*n)), clear=0.6, stamp=0.5)
            if rng.random() < 0.25:
                q = p + n * 1.8 + t * side * 4.8
                if self.free(q[0], q[1], F | HARD, 1.2)[0]:
                    border = "tire" if rng.random() < 0.35 else ("brick" if rng.random() < 0.5 else "concrete")
                    self.add("flowerbed", q[0], q[1], float(rot_of(*n)), clear=1.8, stamp=1.2, shape="rect",
                             length=round(float(rng.uniform(2.0, 3.5)), 2), width=1.2, height=0.25, border=border,
                             flowers=int(rng.integers(FLOWER_PALETTES)))
                    self.stats["flowerbed_podezd"] += 1

    def palisades(self):
        """Низкие крашеные заборчики палисадников вдоль подъездной стороны дома (между подъездами)."""
        F = BLD | WATER | ROAD | CORR | PARKING | HARD | PROP
        for bi, b in enumerate(self.blds):
            ents = [(e, s) for e, s, k in b.get("entrances", []) if k == "podezd"]
            if len(ents) < 2:
                continue
            rng = self.rng(8, bi)
            if rng.random() > 0.45:
                continue
            style = _pick(rng, LAWN_FENCE_STYLES)
            h = round(float(rng.uniform(0.5, 0.75)), 2)
            dist = float(rng.uniform(3.0, 4.5))
            by_e = defaultdict(list)
            for e, s in ents:
                by_e[e].append(s)
            for e, ss in by_e.items():
                L = self.EL[e]
                if L < 8:
                    continue
                t = (self.EB[e] - self.EA[e]) / L; n = self.EN[e]
                # интервалы забора: от 1 м до L-1 м, минус проходы 1.6 м вокруг каждой двери
                cuts = sorted(ss)
                spans, a0 = [], 1.0
                for s in cuts:
                    if s - 1.6 - a0 >= 2.0:
                        spans.append((a0, s - 1.6))
                    a0 = s + 1.6
                if L - 1.0 - a0 >= 2.0:
                    spans.append((a0, L - 1.0))
                for s0, s1 in spans:
                    ss_ = np.arange(s0, s1 + 1e-6, 0.5)
                    pts = self.EA[e] + np.outer(ss_, t) + n * dist
                    ok = self.free(pts[:, 0], pts[:, 1], F, 0.2)
                    # непрерывные куски
                    runs, cur = [], []
                    for kk, o in enumerate(ok):
                        if o:
                            cur.append(kk)
                        elif cur:
                            runs.append(cur); cur = []
                    if cur:
                        runs.append(cur)
                    for run in runs:
                        if len(run) < 5:
                            continue
                        P = pts[run]
                        line = [self.EA[e] + t * ss_[run[0]] + n * 0.8] + list(P) + [self.EA[e] + t * ss_[run[-1]] + n * 0.8]
                        self.polyline_segs("lawn_fence", np.array(line), self.terrain, h, seg_len=3.0, style=style)
                        self.stats["palisade_runs"] += 1

    # ---------------- клумбы
    def flowerbed(self, x, y, rot, shape, rng, size, border="granite", height=0.35, palette=None, src="?", forbid=None):
        forbid = forbid if forbid is not None else (BLD | WATER | ROAD | CORR | PROP | PARKING | PATH)
        rad = size if shape == "round" else max(size) / 2
        chk = rad if shape == "round" else min(size) / 2
        if not self.free(x, y, forbid, chk)[0]:
            return False
        if shape != "round":      # длинная сторона — вдоль локальной X модели
            ax_ = np.array([math.cos(rot), math.sin(rot)])          # локальная +X в мировых (x, y) при rotation.y = rot
            for f in (-0.5, -0.25, 0.25, 0.5):
                q = np.array([x, y]) + ax_ * size[0] * f
                if not self.free(q[0], q[1], forbid, chk)[0]:
                    return False
        extra = {"shape": shape, "height": height, "border": border,
                 "flowers": int(palette if palette is not None else rng.integers(FLOWER_PALETTES))}
        if shape == "round":
            extra["radius"] = round(float(size), 2)
        else:
            extra["length"] = round(float(size[0]), 2); extra["width"] = round(float(size[1]), 2)
        self.add("flowerbed", x, y, float(rot), clear=rad + 0.8, stamp=rad, **extra)
        self.stats["flowerbed_" + src] += 1
        return True

    def flowerbeds_plazas(self, pois):
        """Площади (place=square, пешеходные зоны): клумбы вокруг фонтана/памятника или в центре и по сетке."""
        g = self.g
        monuments = [(x, y, tg) for x, y, tg, cat, ref in pois if cat is None and
                     (tg.get("historic") in ("memorial", "monument") or tg.get("amenity") == "fountain")]
        for wid, (refs, tg) in self.c.osm.ways.items():
            if tg.get("amenity") == "fountain" or tg.get("historic") in ("memorial", "monument") and "building" not in tg:
                xy = self.c.osm.way_xy(wid)
                if len(xy) >= 1:
                    q = xy.mean(0) if len(xy) < 4 else np.array(Polygon(xy).representative_point().coords[0]) \
                        if Polygon(xy).is_valid else xy.mean(0)
                    monuments.append((float(q[0]), float(q[1]), tg))
        for wp in self.c.water:
            if wp.area < 1500:
                q = wp.representative_point()
                monuments.append((q.x, q.y, {"amenity": "fountain"}))
        mxy = np.array([(x, y) for x, y, _ in monuments]) if monuments else np.zeros((0, 2))
        used_m = set()
        F = BLD | WATER | ROAD | CORR | PROP | PARKING
        for i, poly in enumerate(g["paving"]):
            for part in B.polygons(poly):
                if part.area < 1200:
                    continue
                c0 = part.representative_point()
                if not (self.c.m(np.array([c0.x]), np.array([c0.y]))[0] & URBAN):
                    continue
                rng = self.rng(10, i, int(part.area))
                inner = part.buffer(-5.0)
                if inner.is_empty:
                    continue
                full = Polygon(part.exterior).buffer(-5.0)       # фонтан часто — дыра (вода) в полигоне площади
                inside_m = [k for k in range(len(mxy)) if full.contains(Point(mxy[k]))]
                if inside_m:
                    # венок клумб вокруг центрального памятника/фонтана
                    k = min(inside_m, key=lambda k: Point(mxy[k]).distance(part.centroid))
                    used_m.add(k)
                    cx, cy = mxy[k]
                    R = float(np.clip(math.sqrt(part.area) / 6, 7, 14))
                    wr = [math.sqrt(wp.area / math.pi) for wp in self.c.water if wp.area < 1500 and wp.distance(Point(cx, cy)) < 1]
                    if wr:
                        R = max(R, wr[0] + 5.0)
                    nb = int(np.clip(round(2 * math.pi * R / 7), 6, 12))
                    pal = int(rng.integers(FLOWER_PALETTES))
                    for j in range(nb):
                        a = 2 * math.pi * j / nb
                        x, y = cx + R * math.cos(a), cy + R * math.sin(a)
                        if inner.contains(Point(x, y)):
                            self.flowerbed(x, y, -a, "round", rng, 1.6, "granite", 0.4, pal, "plaza", F)
                    inner = inner.difference(Point(cx, cy).buffer(R + 4))
                else:
                    lab = polylabel(inner, tolerance=1.0) if inner.geom_type == "Polygon" else inner.representative_point()
                    r0 = float(np.clip(math.sqrt(part.area) / 10, 2.5, 6.0))
                    self.flowerbed(lab.x, lab.y, 0.0, "round", rng, r0, "granite", 0.45, None, "plaza", F)
                # сетка небольших клумб (прямоугольных вдоль длинной оси площади)
                mrr = np.asarray(part.minimum_rotated_rectangle.exterior.coords)
                e = mrr[1] - mrr[0] if np.hypot(*(mrr[1] - mrr[0])) >= np.hypot(*(mrr[2] - mrr[1])) else mrr[2] - mrr[1]
                ang = math.atan2(e[1], e[0])
                x0, y0, x1, y1 = inner.bounds
                step = 24.0
                for gx in np.arange(x0 + step / 2, x1, step):
                    for gy in np.arange(y0 + step / 2, y1, step):
                        if rng.random() > 0.45 or not inner.contains(Point(gx, gy)):
                            continue
                        jx, jy = gx + rng.uniform(-3, 3), gy + rng.uniform(-3, 3)
                        if len(mxy) and np.hypot(*(mxy - [jx, jy]).T).min() < 6:
                            continue
                        self.flowerbed(jx, jy, float(rot_of(math.cos(ang), math.sin(ang))) + math.pi / 2, "rect", rng,
                                       (float(rng.uniform(6, 10)), float(rng.uniform(1.6, 2.6))), "granite", 0.35,
                                       None, "plaza", F)
        return monuments, used_m

    def flowerbeds_monuments(self, monuments, used):
        F = BLD | WATER | ROAD | CORR | PROP | PARKING | PATH
        for k, (x, y, tg) in enumerate(monuments):
            if k in used or not self.c.inside(x, y, 5):
                continue
            if tg.get("memorial") in ("plaque", "stolperstein", "blue_plaque") or tg.get("historic") == "memorial" and \
                    tg.get("memorial") in (None, "plaque"):
                continue
            rng = self.rng(11, k)
            if not (self.c.m(np.array([x]), np.array([y]))[0] & URBAN):
                continue
            # пара клумб перед памятником (к ближайшей дороге) + пара по бокам
            road, dist, _ = self.probe(np.array([[x, y]] * 8),
                                       np.array([[math.cos(a), math.sin(a)] for a in np.arange(8) * math.pi / 4]), 40, 1.0, 1.0)
            j = int(np.argmin(dist)) if np.isfinite(dist).any() else int(rng.integers(8))
            f = np.array([math.cos(j * math.pi / 4), math.sin(j * math.pi / 4)])
            sdir = np.array([-f[1], f[0]])
            pal = int(rng.integers(FLOWER_PALETTES))
            for off in (f * 4.5 + sdir * 2.5, f * 4.5 - sdir * 2.5, sdir * 4.5, -sdir * 4.5):
                q = np.array([x, y]) + off
                self.flowerbed(q[0], q[1], float(rot_of(*f)), "rect", rng, (2.4, 1.4), "granite", 0.35, pal, "monument", F)

    def flowerbeds_admin(self):
        F = BLD | WATER | ROAD | CORR | PROP | PARKING | PATH
        for bi, b in enumerate(self.blds):
            tg = b["tags"]
            gov = tg.get("office") == "government" or tg.get("amenity") in ("townhall", "courthouse") or "government" in tg \
                or tg.get("building") in ("government", "civic", "public")
            if not gov or b["area"] < 300:
                continue
            edges = [e for e in b["edges"] if self.EL[e] >= 12 and np.isfinite(self.Ed[e]) and self.Ed[e] <= 40]
            if not edges:
                continue
            e = max(edges, key=lambda e: (self.Erank[e], self.EL[e]))
            rng = self.rng(12, bi)
            t = (self.EB[e] - self.EA[e]) / self.EL[e]; n = self.EN[e]
            Lb = float(min(self.EL[e] * 0.35, 18))
            for sgn in (-1, 1):
                q = self.EA[e] + t * (self.EL[e] / 2 + sgn * (Lb / 2 + 2.5)) + n * 3.5
                self.flowerbed(q[0], q[1], float(rot_of(*n)), "rect", rng, (Lb, 1.8), "granite", 0.4, None, "admin", F)

    def flowerbeds_yards(self, spacing=90.0):
        """Круглые клумбы в центре дворов: максимум расстояния до препятствий в зоне многоэтажек."""
        c = self.c
        bad = BLD | NEAR_BLD | ROAD | CORR | WATER | PARKING | HARD | PATH | PROP | WOOD
        zone = (c.M & APT40) != 0
        rows = np.nonzero(zone.any(1))[0]; cols = np.nonzero(zone.any(0))[0]
        if len(rows) == 0:
            return
        r0, r1, c0, c1 = rows[0], rows[-1] + 1, cols[0], cols[-1] + 1
        sub = c.M[r0:r1, c0:c1]
        free = ((sub & bad) == 0) & ((sub & APT40) != 0)
        D = distance_transform_edt(free).astype(np.float32) * RES
        mx = maximum_filter(D, size=25)
        rr, cc = np.nonzero((D == mx) & (D >= 5.0))
        xs = c.min_x + (cc + c0 + 0.5) * RES; ys = c.max_y - (rr + r0 + 0.5) * RES
        dv = D[rr, cc]
        rng = self.rng(13, 0)
        order = np.argsort(-dv + rng.random(len(dv)) * 3, kind="stable")
        acc = []
        for i in order:
            x, y = xs[i], ys[i]
            if acc and min((x - a) ** 2 + (y - b_) ** 2 for a, b_ in acc) < spacing ** 2:
                continue
            if rng.random() > 0.6:
                acc.append((x, y))
                continue
            rad = float(min(dv[i] - 2.0, 3.5))
            if rad < 1.5:
                continue
            # настоящий двор: дома не меньше чем в 5 из 8 направлений в пределах 70 м
            dirs = np.array([[math.cos(a), math.sin(a)] for a in np.arange(8) * math.pi / 4])
            ds = np.arange(2.0, 70.0, 2.0)
            hit = (c.m(x + dirs[:, 0, None] * ds, y + dirs[:, 1, None] * ds) & BLD) != 0
            if hit.any(1).sum() < 5:
                continue
            if self.flowerbed(x, y, 0.0, "round", rng, rad, "concrete" if rng.random() < 0.6 else "brick", 0.3, None, "yard"):
                acc.append((x, y))

    # ---------------- медианы
    def medians(self):
        """Разделительные полосы между встречными односторонними проезжими частями (primary..tertiary)."""
        c = self.c
        ow = [r for r in self.roads if r.bwd is None and base_class(r.hw) in ("primary", "secondary", "tertiary")
              and not r.hw.endswith("_link") and not r.bridge and not r.tunnel and len(r.axis) >= 2]
        lines = {r.id: LineString(r.axis) for r in self.roads if len(r.axis) >= 2}
        runs = []
        for r in ow:
            L = cumlen(r.axis)[-1]
            if L < 20:
                continue
            P = resample(r.axis, 1.0)
            s = cumlen(P)
            ss = np.arange(6.0, s[-1] - 6.0, 6.0)
            if len(ss) == 0:
                continue
            X = np.interp(ss, s, P[:, 0]); Y = np.interp(ss, s, P[:, 1])
            i = np.clip(np.searchsorted(s, ss) - 1, 0, len(P) - 2)
            T = P[i + 1] - P[i]; T /= np.maximum(np.hypot(*T.T), 1e-9)[:, None]
            NL = np.c_[-T[:, 1], T[:, 0]]
            E = np.c_[X, Y] + NL * (r.Wf / 2)
            ds = np.arange(0.3, 30.0, 0.25)
            QX = E[:, 0, None] + NL[:, 0, None] * ds; QY = E[:, 1, None] + NL[:, 1, None] * ds
            rid = self.rid_at(QX, QY) - 1
            jn = (c.m(QX, QY) & (JUNC | BLD)) != 0
            other = (rid >= 0) & (rid != r.id)
            res = []
            for k in range(len(ss)):
                h = np.nonzero(other[k])[0]
                if len(h) == 0:
                    res.append(None); continue
                h0 = h[0]
                if jn[k, :h0 + 1].any():
                    res.append(None); continue
                o = self.roads[rid[k, h0]]
                if o.bwd is not None or base_class(o.hw) not in ("primary", "secondary", "tertiary") or o.id < r.id:
                    res.append(None); continue
                ln = lines[o.id]
                d = ln.project(Point(QX[k, h0], QY[k, h0]))
                a = np.array(ln.interpolate(max(d - 1, 0)).coords[0]); bq = np.array(ln.interpolate(min(d + 1, ln.length)).coords[0])
                to = bq - a
                to /= max(np.hypot(*to), 1e-9)
                if to @ T[k] > -0.7:
                    res.append(None); continue
                gap = ds[h0] - 0.3 + 0.3   # от кромки до кромки
                res.append(gap)
            # непрерывные участки с похожей шириной
            cur = []
            for k, gp in enumerate(res):
                if gp is not None and (not cur or abs(gp - cur[-1][1]) < 2.0):
                    cur.append((k, gp))
                else:
                    if len(cur) >= 2:
                        runs.append((r, [(E[kk] + NL[kk] * g_ / 2, g_, T[kk]) for kk, g_ in cur]))
                    cur = [(k, gp)] if gp is not None else []
            if len(cur) >= 2:
                runs.append((r, [(E[kk] + NL[kk] * g_ / 2, g_, T[kk]) for kk, g_ in cur]))
        self.median_runs = runs
        self.stats["median_runs"] = len(runs)
        self.stats["median_m"] = int(sum(6.0 * (len(p) - 1) for _, p in runs))
        return runs

    def median_furniture(self, runs):
        c = self.c
        lamp_pts = []
        for ri, (r, pts) in enumerate(runs):
            cls = base_class(r.hw)
            C = np.array([p for p, _, _ in pts]); Wd = np.array([w for _, w, _ in pts]); T = np.array([t for _, _, t in pts])
            rng = self.rng(20, r.id, ri)
            wmed = float(np.median(Wd))
            self.stats[f"median_w_{'<1' if wmed < 1 else '1-3' if wmed < 3 else '3-6' if wmed < 6 else '6+'}"] += 1
            yf = lambda x, y: self.terrain(x, y) + ROAD_LIFT
            # узкая: барьер по оси
            if 1.5 <= wmed < 3.0:
                if cls == "primary" and MEDIAN_GUARDRAIL:
                    self.polyline_segs("guardrail", C, yf, 0.75, seg_len=4.0, style="w_beam_median")
                    self.stats["guardrail_median_runs"] += 1
                elif cls == "secondary" and rng.random() < 0.6:
                    self.polyline_segs("ped_fence", C, yf, 1.0, seg_len=3.0, style="grey")
                    self.stats["ped_fence_median_runs"] += 1
                continue
            if wmed < 2.5:
                continue
            # фонари с двумя консолями по оси, шаг ~35 м
            s = cumlen(C)
            for d in np.arange(rng.uniform(5, 20), s[-1], 35.0):
                k = int(np.clip(np.searchsorted(s, d), 0, len(C) - 1))
                x, y = C[k]
                if not self.free(x, y, BLD | WATER | ROAD | JUNC | PROP, 0.5)[0]:
                    continue
                self.add("street_lamp_double", x, y, float(rot_of(*np.array([-T[k, 1], T[k, 0]]))), clear=1.5, stamp=0.6)
                lamp_pts.append((x, y))
            lamp_pts.extend([])
            # клумбы на широких медианах (в городе)
            if wmed >= 4.5:
                for d in np.arange(rng.uniform(15, 30), s[-1] - 8, 45.0):
                    k = int(np.clip(np.searchsorted(s, d), 0, len(C) - 1))
                    x, y = C[k]
                    if not (c.m(np.array([x]), np.array([y]))[0] & URBAN):
                        continue
                    w = float(min(Wd[k] - 2.0, 4.0))
                    if w < 1.5:
                        continue
                    self.flowerbed(x, y, float(rot_of(*T[k])) + math.pi / 2, "rect", rng, (float(rng.uniform(8, 14)), w),
                                   "granite", 0.3, None, "median", BLD | WATER | ROAD | PROP | PATH | JUNC)
        # одиночные фонари, попавшие на медиану с двойными, — убрать
        if runs:
            M = np.array([p for _, pts in runs for p, w, _ in pts if w >= 2.5])
            Wm = np.array([w for _, pts in runs for p, w, _ in pts if w >= 2.5])
            if len(M):
                kd = cKDTree(M)
                removed = 0
                for key, lst in c.tiles_props.items():
                    keep = []
                    for rec in lst:
                        if rec["type"] == "street_lamp":
                            d, j = kd.query([rec["x"], -rec["z"]])
                            if d < Wm[j] / 2 + 0.5 and d < 4.5:
                                removed += 1
                                continue
                        keep.append(rec)
                    lst[:] = keep
                self.stats["street_lamp_removed_on_median"] = removed

    # ---------------- ограждения
    def _axis_frame(self, r):
        P = resample(r.axis, 0.5)
        s = cumlen(P)
        T = np.gradient(P, axis=0)
        T /= np.maximum(np.hypot(*T.T), 1e-9)[:, None]
        return P, s, T, np.c_[-T[:, 1], T[:, 0]]

    def ped_fence_run(self, r, s0, s1, style, frame, avoid, key):
        P, s, T, NL = frame
        sel = (s >= s0) & (s <= s1)
        if sel.sum() < 4:
            return 0
        n = 0
        for sg, edge in ((-1, r.Wf if r.bwd is not None else r.Wf / 2), (1, r.Wb if r.bwd is not None else r.Wf / 2)):
            Q = P[sel] + NL[sel] * sg * (edge + 0.45)
            m = self.c.m(Q[:, 0], Q[:, 1])
            hard = (m & (JUNC | BLD | WATER)) != 0
            if avoid is not None:
                hard |= shapely.contains_xy(avoid, Q[:, 0], Q[:, 1])
            soft = ((m & CORR) != 0) & (self.rid_at(Q[:, 0], Q[:, 1]) == 0)
            # дырки «мягкой» проверки (кромка ленты гуляет на изгибах) до 3 м заполняем; въезды шире — разрыв
            ok = soft.copy()
            k = 0
            while k < len(ok):
                if not ok[k]:
                    j = k
                    while j < len(ok) and not ok[j]:
                        j += 1
                    if 0 < k and j < len(ok) and j - k <= 6:
                        ok[k:j] = True
                    k = j
                else:
                    k += 1
            ok &= ~hard
            runs, cur = [], []
            for k, o in enumerate(ok):
                if o:
                    cur.append(k)
                elif cur:
                    runs.append(cur); cur = []
            if cur:
                runs.append(cur)
            for run in runs:
                if len(run) < 8:     # < 4 м
                    continue
                n += self.polyline_segs("ped_fence", Q[run], lambda x, y: self.terrain(x, y) + SIDEWALK_TOP, 1.0,
                                        seg_len=3.0, style=style)
        return n

    def ped_fences(self):
        """Пешеходные ограждения у светофорных перекрёстков и наземных переходов на магистралях."""
        from .markings import crossing_rect
        c = self.c
        cr_rects = [crossing_rect(cr, 1.0, 4.0) for cr in self.crossings]
        bus = [(rec["x"], -rec["z"]) for lst in c.tiles_props.values() for rec in lst if rec["type"] == "bus_stop"]
        avoid_geoms = cr_rects + [Point(p).buffer(14.0) for p in bus]
        avoid_tree = shapely.STRtree(avoid_geoms) if avoid_geoms else None
        tls = {j for j, J in c.net.junctions.items() if (J.get("type") or "").startswith("traffic_light")}
        frames = {}
        for r in self.roads:
            cls = base_class(r.hw)
            if cls not in ("primary", "secondary", "tertiary") or r.hw.endswith("_link") or r.bridge or r.tunnel:
                continue
            L = cumlen(r.axis)[-1]
            for end, j in ((0, r.frm), (1, r.to)):
                if j not in tls:
                    continue
                rng = self.rng(30, r.id, end)
                if cls == "tertiary" and rng.random() > 0.5:
                    continue
                Lf = {"primary": rng.uniform(60, 150), "secondary": rng.uniform(45, 100), "tertiary": rng.uniform(25, 60)}[cls]
                s0, s1 = (3.0, min(3.0 + Lf, L * 0.55)) if end == 0 else (max(L - 3.0 - Lf, L * 0.45), L - 3.0)
                if s1 - s0 < 6:
                    continue
                fr = frames.setdefault(r.id, self._axis_frame(r))
                region = LineString(r.axis).buffer(30)
                avoid = None
                if avoid_tree is not None:
                    idx = avoid_tree.query(region, predicate="intersects")
                    avoid = shapely.union_all([avoid_geoms[i] for i in idx]) if len(idx) else None
                style = _pick(self.rng(31, hash(j) % 100000), PED_FENCE_STYLES)
                if self.ped_fence_run(r, s0, s1, style, fr, avoid, j):
                    self.stats["ped_fence_tl_approaches"] += 1
        # переходы вне светофоров на primary/secondary
        for k, cr in enumerate(self.crossings):
            r = cr["road"]
            if base_class(r.hw) not in ("primary", "secondary") or not cr["marked"] or r.bridge:
                continue
            if r.frm in tls and cr["s"] < 35 or r.to in tls and cumlen(r.axis)[-1] - cr["s"] < 35:
                continue
            rng = self.rng(32, k)
            Lf = rng.uniform(12, 25)
            fr = frames.setdefault(r.id, self._axis_frame(r))
            avoid = crossing_rect(cr, 1.0, 4.0)
            if self.ped_fence_run(r, cr["s"] - 4 - Lf, cr["s"] + 4 + Lf, _pick(rng, PED_FENCE_STYLES), fr, avoid, k):
                self.stats["ped_fence_crossings"] += 1

    def guardrails(self):
        """W-образные барьеры: края мостов и высокие насыпи у дорог без тротуара; бетонные блоки в тупиках."""
        c = self.c
        from .bridges import surface
        for r in self.roads:
            if len(r.axis) < 2 or r.tunnel:
                continue
            cls = base_class(r.hw)
            if r.bridge:
                P = resample(r.axis, 2.0)
                s = cumlen(P) * (r.s_axis[-1] / max(cumlen(P)[-1], 1e-9))
                T = np.gradient(P, axis=0); T /= np.maximum(np.hypot(*T.T), 1e-9)[:, None]
                NL = np.c_[-T[:, 1], T[:, 0]]
                for sg, edge in ((-1, r.Wf if r.bwd is not None else r.Wf / 2), (1, r.Wb if r.bwd is not None else r.Wf / 2)):
                    Q = P + NL * sg * (edge + 0.35)
                    y = surface(r, s, Q[:, 0], Q[:, 1], c.H, c.grid, c.base, ROAD_LIFT)
                    Q4, y4 = Q[::2], y[::2]
                    if len(Q) % 2 == 0:
                        Q4 = np.r_[Q4, Q[-1:]]; y4 = np.r_[y4, y[-1:]]
                    for i in range(len(Q4) - 1):
                        self.seg("guardrail", Q4[i], Q4[i + 1], y4[i], y4[i + 1], 0.75, clear=False, style="w_beam_bridge")
                self.stats["guardrail_bridges"] += 1
                continue
            if cls not in ("primary", "secondary", "tertiary", "unclassified"):
                continue
            fr = self._axis_frame(r)
            P, s, T, NL = fr
            idx = np.arange(0, len(P), 6)       # 3 м
            for sg, edge in ((-1, r.Wf if r.bwd is not None else r.Wf / 2), (1, r.Wb if r.bwd is not None else r.Wf / 2)):
                Q = P[idx] + NL[idx] * sg * (edge + 0.5)
                No = NL[idx] * sg
                ye = self.terrain(Q[:, 0], Q[:, 1])
                t5 = self.terrain(Q[:, 0] + No[:, 0] * 4, Q[:, 1] + No[:, 1] * 4)
                t8 = self.terrain(Q[:, 0] + No[:, 0] * 8, Q[:, 1] + No[:, 1] * 8)
                drop = ye - np.minimum(t5, t8)
                m1 = c.m(Q[:, 0] + No[:, 0] * 1.0, Q[:, 1] + No[:, 1] * 1.0)
                m0 = c.m(Q[:, 0], Q[:, 1])
                ok = (drop >= 2.5) & ((m1 & (CORR | BLD)) == 0) & ((m0 & (JUNC | BLD | WATER)) == 0)
                ok &= self.rid_at(Q[:, 0], Q[:, 1]) == 0
                runs, cur = [], []
                for k, o in enumerate(ok):
                    if o:
                        cur.append(k)
                    elif cur:
                        runs.append(cur); cur = []
                if cur:
                    runs.append(cur)
                for run in runs:
                    if len(run) < 5:     # < 12 м
                        continue
                    run = list(range(max(run[0] - 2, 0), min(run[-1] + 3, len(Q))))   # выпуск по 6 м
                    self.polyline_segs("guardrail", Q[run], lambda x, y: self.terrain(x, y) + ROAD_LIFT, 0.75, seg_len=4.0,
                                       style="w_beam")
                    self.stats["guardrail_embankment_runs"] += 1

    def jersey(self, pois):
        """Бетонные блоки: barrier=block из OSM, тупики дорог, края строек вдоль дорог."""
        c = self.c
        rs = [r for r in self.roads if len(r.axis) >= 2 and not r.tunnel]
        tree = shapely.STRtree([LineString(r.axis) for r in rs])
        for k, (x, y, tg, cat, ref) in enumerate(pois):
            if cat is not None or tg.get("barrier") != "block" or not c.inside(x, y, 3):
                continue
            idx = tree.query_nearest(Point(x, y), max_distance=8.0)
            if len(idx):
                ln = LineString(rs[int(idx[0])].axis)
                d = ln.project(Point(x, y))
                a = np.array(ln.interpolate(max(d - 1, 0)).coords[0]); b = np.array(ln.interpolate(min(d + 1, ln.length)).coords[0])
                t = (b - a) / max(np.hypot(*(b - a)), 1e-9)
                n = np.array([-t[1], t[0]])
            else:
                n = np.array([1.0, 0.0])
            a, b = np.array([x, y]) - n * 1.0, np.array([x, y]) + n * 1.0
            ya, yb = self.terrain([a[0], b[0]], [a[1], b[1]])
            self.seg("jersey_barrier", a, b, ya, yb, 0.8, style="concrete")
        # тупики (dead_end SUMO) на дорогах residential+, не у границы мира
        deg = defaultdict(list)
        for r in self.roads:
            deg[r.frm].append((r, 0)); deg[r.to].append((r, 1))
        for j, J in c.net.junctions.items():
            if J.get("type") != "dead_end" or len(deg[j]) != 1:
                continue
            r, end = deg[j][0]
            if RANK.get(base_class(r.hw), 1) < 2 or r.bridge or not c.inside(J["x"], J["y"], 30):
                continue
            rng = self.rng(40, r.id, end)
            if rng.random() > 0.5:
                continue
            P = r.axis if end == 1 else r.axis[::-1]
            if len(P) < 2:
                continue
            t = P[-1] - P[-2]; t /= max(np.hypot(*t), 1e-9)
            n = np.array([-t[1], t[0]])
            hw = (max(r.Wf, r.Wb) if r.bwd is not None else r.Wf / 2) + 0.3
            ctr = P[-1] - t * 0.8
            pts = [ctr - n * hw + n * 2 * hw * f for f in np.linspace(0, 1, max(2, int(2 * hw / 2) + 1))]
            for a, b in zip(pts[:-1], pts[1:]):
                ya, yb = self.terrain([a[0], b[0]], [a[1], b[1]]) + ROAD_LIFT
                self.seg("jersey_barrier", a, b, ya, yb, 0.8, style="concrete" if rng.random() < 0.6 else "red_white_plastic")
            self.stats["jersey_dead_ends"] += 1
        # стройки: участки границы в 1..6 м от проезжей части
        for wid, (refs, tg) in c.osm.ways.items():
            if tg.get("landuse") != "construction" or len(refs) < 4 or refs[0] != refs[-1]:
                continue
            xy = c.osm.way_xy(wid)
            if len(xy) < 4:
                continue
            Q = resample(xy, 2.0)
            m = c.m(Q[:, 0], Q[:, 1])
            near = np.zeros(len(Q), bool)
            for ang in np.arange(8) * math.pi / 4:
                for d in (1.5, 3.0, 5.0):
                    near |= (self.rid_at(Q[:, 0] + d * math.cos(ang), Q[:, 1] + d * math.sin(ang)) > 0)
            ok = near & ((m & (ROAD | BLD | JUNC)) == 0) & c.inside(Q[:, 0], Q[:, 1], 3)
            for i in range(len(Q) - 1):
                if ok[i] and ok[i + 1]:
                    ya, yb = self.terrain([Q[i, 0], Q[i + 1, 0]], [Q[i, 1], Q[i + 1, 1]])
                    self.seg("jersey_barrier", Q[i], Q[i + 1], ya, yb, 0.8, style="concrete")

    def bollards(self, pois):
        c = self.c
        g = self.g
        n_osm = 0
        for k, (x, y, tg, cat, ref) in enumerate(pois):
            if cat is None and tg.get("barrier") == "bollard" and c.inside(x, y, 3) and self.free(x, y, BLD | WATER)[0]:
                self.add("bollard", x, y, 0.0, clear=0.6, stamp=0.3)
                n_osm += 1
        self.stats["bollard_osm"] = n_osm
        # края площадей, примыкающие к проезжей части/парковке
        for i, poly in enumerate(g["paving"]):
            for part in B.polygons(poly):
                if part.area < 800:
                    continue
                ring = orient(part, 1.0).exterior
                Q = resample(np.asarray(ring.coords), 2.5)
                if len(Q) < 3:
                    continue
                T = np.gradient(Q, axis=0); T /= np.maximum(np.hypot(*T.T), 1e-9)[:, None]
                No = np.c_[T[:, 1], -T[:, 0]]        # наружу (CCW)
                out = Q + No * 1.6
                mo = c.m(out[:, 0], out[:, 1])
                ins = Q - No * 0.5
                mi = c.m(ins[:, 0], ins[:, 1])
                ok = (self.rid_at(out[:, 0], out[:, 1]) > 0) & ((mi & (ROAD | BLD | WATER | JUNC | PROP)) == 0)
                for k in np.nonzero(ok)[0]:
                    self.add("bollard", ins[k, 0], ins[k, 1], 0.0, clear=0.6, stamp=0.3)
                    self.stats["bollard_plaza"] += 1
        # входы на пешеходные улицы (highway=pedestrian линией) с автодорог
        for i, (ln, w) in enumerate(g["paving_lines"]):
            for part in getattr(ln, "geoms", [ln]):
                if part.geom_type != "LineString" or part.length < 10:
                    continue
                P = np.asarray(part.coords)
                for end in (0, -1):
                    p = P[end]; q = P[1] if end == 0 else P[-2]
                    t = (q - p) / max(np.hypot(*(q - p)), 1e-9)
                    near = any(self.rid_at(np.array([p[0] + t[0] * d]), np.array([p[1] + t[1] * d]))[0] > 0 for d in (-3, -1.5, 0, 1.5))
                    if not near:
                        continue
                    # первая точка внутрь, свободная от проезжей части и тротуара
                    for d in np.arange(2.0, 15.0, 0.5):
                        b0 = p + t * d
                        if (c.m(np.array([b0[0]]), np.array([b0[1]]))[0] & (ROAD | CORR | JUNC)) == 0:
                            break
                    else:
                        continue
                    n = np.array([-t[1], t[0]])
                    k = max(2, int(w / 1.6))
                    for f in np.linspace(-w / 2 + 0.6, w / 2 - 0.6, k):
                        q2 = b0 + n * f
                        if self.free(q2[0], q2[1], BLD | WATER | ROAD | PROP)[0]:
                            self.add("bollard", q2[0], q2[1], float(rot_of(*t)), clear=0.6, stamp=0.3)
                            self.stats["bollard_pedestrian_entry"] += 1

    def lawn_fences(self):
        """Низкие заборчики вокруг детских площадок (часть) — вход со стороны ближайшего дома."""
        g = self.g
        polys = list(g["playground"]) + [p for p, _ in getattr(self.c, "extra_playgrounds", [])]
        F = BLD | WATER | ROAD | CORR | PARKING
        for i, poly in enumerate(polys):
            rng = self.rng(50, i)
            if rng.random() > 0.55:
                continue
            parts = B.polygons(poly)
            if not parts:
                continue
            p = max(parts, key=lambda q: q.area)
            if p.area < 40 or p.area > 5000:
                continue
            ring = orient(p.buffer(0.6, join_style="mitre"), 1.0).exterior
            Q = resample(np.asarray(ring.coords), 0.5)
            ok = self.free(Q[:, 0], Q[:, 1], F)
            # калитка: 1.6 м в точке, ближайшей к ближайшему зданию
            bidx = self.part_tree.query_nearest(p.centroid, max_distance=80)
            if len(bidx):
                bp = self.part_tree.geometries[int(bidx[0])]
                d = shapely.distance(shapely.points(Q), bp)
                g0 = int(np.argmin(d))
                s = cumlen(Q)
                ok &= np.abs(s - s[g0]) > 0.8
            style = _pick(rng, LAWN_FENCE_STYLES)
            h = round(float(rng.uniform(0.6, 0.9)), 2)
            runs, cur = [], []
            for k, o in enumerate(ok):
                if o:
                    cur.append(k)
                elif cur:
                    runs.append(cur); cur = []
            if cur:
                runs.append(cur)
            for run in runs:
                if len(run) >= 4:
                    self.polyline_segs("lawn_fence", Q[run], self.terrain, h, seg_len=3.0, style=style)
            self.stats["lawn_fence_playgrounds"] += 1

    def gates(self, pois):
        """Шлагбаумы: barrier=lift_gate из OSM и процедурно на въездах во дворы с парковками."""
        c = self.c
        rs = [r for r in self.roads if len(r.axis) >= 2 and not r.tunnel and not r.bridge]
        tree = shapely.STRtree([LineString(r.axis) for r in rs])

        def place(r, s_at, inward, key):
            ln = LineString(r.axis)
            p0 = np.array(ln.interpolate(s_at).coords[0])
            a = np.array(ln.interpolate(max(s_at - 1, 0)).coords[0]); b = np.array(ln.interpolate(min(s_at + 1, ln.length)).coords[0])
            t = (b - a) / max(np.hypot(*(b - a)), 1e-9)
            if inward < 0:
                t = -t                          # t — направление въезда
            right = np.array([t[1], -t[0]])
            hw = (max(r.Wf, r.Wb) if r.bwd is not None else r.Wf / 2)
            post = p0 + right * (hw + 0.5)
            if not self.free(post[0], post[1], BLD | WATER)[0]:
                post = p0 - right * (hw + 0.5)
                right = -right
            if not self.free(post[0], post[1], BLD | WATER)[0]:
                return False
            arm = -right
            y = float(self.terrain([post[0]], [post[1]])[0])
            self.add("barrier_gate", post[0], post[1], float(rot_of(*-t)), yv=y, clear=1.0, stamp=0.4,
                     armLength=round(float(2 * hw + 0.6), 2), armDir=[round(float(arm[0]), 4), round(float(-arm[1]), 4)])
            return True

        for k, (x, y, tg, cat, ref) in enumerate(pois):
            if cat is not None or tg.get("barrier") != "lift_gate" or not c.inside(x, y, 3):
                continue
            idx = tree.query_nearest(Point(x, y), max_distance=6.0)
            if len(idx) == 0:
                continue
            r = rs[int(idx[0])]
            ln = LineString(r.axis)
            s = ln.project(Point(x, y))
            if place(r, s, 1 if s > ln.length / 2 else -1, k):
                self.stats["barrier_gate_osm"] += 1
        # процедурные: service-проезд от улицы (residential+) во двор с парковкой
        jcls = defaultdict(int)
        for r in self.roads:
            rk = RANK.get(base_class(r.hw), 1)
            jcls[r.frm] = max(jcls[r.frm], rk); jcls[r.to] = max(jcls[r.to], rk)
        for r in rs:
            if base_class(r.hw) != "service":
                continue
            L = cumlen(r.axis)[-1]
            if L < 25:
                continue
            for end, j in ((0, r.frm), (1, r.to)):
                if jcls[j] < 2:
                    continue
                rng = self.rng(60, r.id, end)
                if rng.random() > 0.3:
                    continue
                s_at = 9.0 if end == 0 else L - 9.0
                # двор с парковкой: дальше по проезду в 40 м есть парковка, и мы в зоне многоэтажек
                ln = LineString(r.axis)
                probe = [np.array(ln.interpolate(s_at + (d if end == 0 else -d)).coords[0]) for d in range(0, 40, 4)]
                pr = np.array(probe)
                mm = c.m(pr[:, 0], pr[:, 1])
                ring = [c.m(pr[:, 0] + dx, pr[:, 1] + dy) for dx, dy in ((6, 0), (-6, 0), (0, 6), (0, -6))]
                has_park = any(((m_ & PARKING) != 0).any() for m_ in ring) or ((mm & PARKING) != 0).any()
                if not has_park or not ((mm & APT40) != 0).any():
                    continue
                if place(r, s_at, 1 if end == 0 else -1, (r.id, end)):
                    self.stats["barrier_gate_yard"] += 1
                break

    # ---------------- фонари
    def collect_lamps(self):
        self.lamps_xy = [(rec["x"], -rec["z"]) for lst in self.c.tiles_props.values() for rec in lst
                         if rec["type"] in ("street_lamp", "street_lamp_double", "park_lamp", "lamp_classic")]

    def lamp_ok(self, kd_pts, x, y, dmin):
        return all((x - a) ** 2 + (y - b) ** 2 >= dmin ** 2 for a, b in kd_pts)

    def park_lamps(self):
        c = self.c
        g = self.g
        base = np.array(self.lamps_xy) if self.lamps_xy else np.zeros((0, 2))
        kd = cKDTree(base) if len(base) else None
        new = defaultdict(list)            # сетка 20 м -> новые фонари

        def far(x, y, dmin):
            if kd is not None and kd.query([x, y])[0] < dmin:
                return False
            gi, gj = int(x // 20), int(y // 20)
            for a in (-1, 0, 1):
                for b in (-1, 0, 1):
                    for px, py in new.get((gi + a, gj + b), ()):
                        if (px - x) ** 2 + (py - y) ** 2 < dmin ** 2:
                            return False
            return True

        def put(x, y, rot, typ="park_lamp", scale=1.0, src="path", **extra):
            self.add(typ, x, y, rot, clear=1.2, stamp=0.5, scale=scale, **extra)
            new[(int(x // 20), int(y // 20))].append((x, y))
            self.stats[f"{typ}_{src}"] += 1

        F = BLD | WATER | ROAD | CORR | PROP | PARKING
        lit = PARK | HARD | APT40 | GROUNDS
        for i, (ln, w) in enumerate(g["path_lines"] + g["paving_lines"]):
            rng = self.rng(70, i)
            for part in getattr(ln, "geoms", [ln]):
                if part.geom_type != "LineString" or part.length < 15:
                    continue
                P = resample(np.asarray(part.coords), 1.0)
                s = cumlen(P)
                for k, d in enumerate(np.arange(rng.uniform(4, 12), s[-1] - 2, 24.0)):
                    j = int(np.clip(np.searchsorted(s, d), 1, len(P) - 1))
                    t = P[j] - P[j - 1]; t /= max(np.hypot(*t), 1e-9)
                    sg = 1 if (k + i) % 2 == 0 else -1
                    nrm = sg * np.array([-t[1], t[0]])
                    q = P[j] + nrm * (w / 2 + 0.6)
                    m = c.m(np.array([q[0]]), np.array([q[1]]))[0]
                    if not (m & lit) or (m & CEMETERY) or ((m & WOOD) and not (m & PARK)):
                        continue
                    if not self.free(q[0], q[1], F, 0.4)[0] or not far(q[0], q[1], 14.0):
                        continue
                    put(q[0], q[1], float(rot_of(*-nrm)))
        # периметр площадей
        for i, poly in enumerate(g["paving"]):
            for part in B.polygons(poly):
                if part.area < 1500:
                    continue
                inner = part.buffer(-2.0)
                for pp in B.polygons(inner):
                    Q = resample(np.asarray(pp.exterior.coords), 25.0)
                    for x, y in Q[:-1]:
                        if self.free(x, y, F, 0.4)[0] and far(x, y, 14.0):
                            put(x, y, 0.0, src="plaza")
        # дворовые проезды (service у многоэтажек): обычный фонарь, scale 0.8, с одной стороны
        for r in self.roads:
            if base_class(r.hw) != "service" or r.bridge or r.tunnel or len(r.axis) < 2:
                continue
            L = cumlen(r.axis)[-1]
            if L < 20:
                continue
            rng = self.rng(71, r.id)
            sg = 1 if r.id % 2 else -1
            hw = (max(r.Wf, r.Wb) if r.bwd is not None else r.Wf / 2)
            P = resample(r.axis, 1.0)
            s = cumlen(P)
            for d in np.arange(rng.uniform(5, 20), s[-1] - 5, 38.0):
                j = int(np.clip(np.searchsorted(s, d), 1, len(P) - 1))
                t = P[j] - P[j - 1]; t /= max(np.hypot(*t), 1e-9)
                nrm = sg * np.array([-t[1], t[0]])
                q = P[j] + nrm * (hw + 0.9)
                m = c.m(np.array([q[0]]), np.array([q[1]]))[0]
                if not (m & APT40) or (m & JUNC):
                    continue
                if not self.free(q[0], q[1], F, 0.4)[0] or not far(q[0], q[1], 18.0):
                    continue
                put(q[0], q[1], float(rot_of(*-nrm)), typ="street_lamp", scale=0.8, src="yard", variant="yard")

    # ---------------- деревья под новыми объектами
    def clear_vegetation(self):
        if not self.clear:
            return
        C = np.array(self.clear)
        kd = cKDTree(C[:, :2])
        rmax = float(C[:, 2].max())
        removed = defaultdict(int)
        for key, lst in self.c.tiles_props.items():
            keep = []
            for rec in lst:
                t = rec["type"]
                if t.startswith("tree_") or t == "shrub":
                    margin = 1.0 if t != "shrub" else 0.6
                    x, y = rec["x"], -rec["z"]
                    idx = kd.query_ball_point([x, y], rmax + margin)
                    if idx and any(math.hypot(x - C[i, 0], y - C[i, 1]) < C[i, 2] + margin for i in idx):
                        removed[t if t == "shrub" else "tree"] += 1
                        self.c.stats[t] -= 1
                        continue
                keep.append(rec)
            lst[:] = keep
        self.stats["removed_trees"] = removed["tree"]
        self.stats["removed_shrubs"] = removed["shrub"]

    # ---------------- запуск
    def run(self):
        log = self.log
        self.build_rid()
        self.load_v2()
        self.build_facades()
        from . import pedestrian_streets as PS   # пешеходные улицы: фасады к зоне — «улица» (docs/stage2/pochtovaya.md)
        PS.mark_facades(self)
        pois = parse_pois(self.osm_path)
        self.stats["poi_nodes"] = sum(1 for p in pois if p[3] is not None)
        log(f"улица: зданий {len(self.blds)}, рёбер фасадов {len(self.EA)}, POI {self.stats['poi_nodes']}")
        self.entrances_osm()
        self.storefronts_osm(pois)
        self.storefronts_generated()
        ents = self.entrances_inferred()
        self.entrance_furniture(ents)
        log(f"улица: пешеходные улицы {PS.furnish(self, pois)}")
        log(f"улица: витрин OSM {self.stats['storefronts_osm']}, процедурных {self.stats['storefronts_generated']}; "
            f"входов OSM {sum(v for k, v in self.stats.items() if k.startswith('entrances_') and k.endswith('_osm'))}, "
            f"выведенных подъездов {self.stats['entrances_podezd_gen']}")
        self.collect_lamps()
        runs = self.medians()
        self.median_furniture(runs)
        self.collect_lamps()
        self.park_lamps()
        monuments, used = self.flowerbeds_plazas(pois)
        self.flowerbeds_monuments(monuments, used)
        self.flowerbeds_admin()
        self.flowerbeds_yards()
        self.ped_fences()
        self.guardrails()
        self.jersey(pois)
        self.bollards(pois)
        self.lawn_fences()
        self.palisades()
        self.gates(pois)
        self.clear_vegetation()
        del self.RID
        keys = ["flowerbed", "bollard", "barrier_gate", "park_lamp", "street_lamp_double", "bench", "trash_bin",
                "ped_fence", "guardrail", "jersey_barrier", "lawn_fence"]
        log("улица: " + ", ".join(f"{k} {self.stats.get(k, 0)}" for k in keys) +
            f"; убрано деревьев {self.stats['removed_trees']}, кустов {self.stats['removed_shrubs']}")
        return self

    def summary(self):
        return {k: (round(v, 1) if isinstance(v, float) else v) for k, v in sorted(self.stats.items())}

    def write(self, out_dir, files):
        """Дописывает storefronts/entrances в props/{ix}_{iz}.json (создаёт файл, если пропсов в тайле не было)."""
        files = dict(files)
        keys = set(self.tiles_sf) | set(self.tiles_ent)
        for k in sorted(keys):
            f = files.get(k) or f"props/{k[0]}_{k[1]}.json"
            p = out_dir / f
            js = json.loads(p.read_text()) if p.exists() else {"version": 1, "ix": k[0], "iz": k[1], "instances": [], "segments": []}
            if self.tiles_sf.get(k):
                js["storefronts"] = self.tiles_sf[k]
            if self.tiles_ent.get(k):
                js["entrances"] = self.tiles_ent[k]
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(json.dumps(js, ensure_ascii=False, separators=(",", ":")))
            files[k] = f
        return files


def build(yctx, mctx, crossings, osm_path, log=print, v2=True):
    """Точка входа из build_world.py (после world/yards.py, до записи props/*.json)."""
    dump = os.environ.get("STREETLIFE_DUMP")
    if dump:
        import pickle
        keep = {k: mctx[k] for k in ("sidewalk_footprints",) if k in mctx}
        with open(dump, "wb") as f:
            pickle.dump((yctx, keep, crossings, str(osm_path)), f, protocol=5)
        log(f"улица: входные данные сохранены в {dump}")
    return StreetLife(yctx, mctx, crossings, osm_path, log, v2).run()

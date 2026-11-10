"""Озвучка ругани пешеходов (docs/stage2/audio.md): macOS `say` (русский голос) → AIFF → AAC m4a + swear.json.

Запуск: python3 -I assets/scripts/audio/build_swear.py  (только macOS: нужны say и afconvert).
Мужские/пожилые голоса делаются из того же женского голоса: в игре такие реплики проигрываются с playbackRate < 1
(ниже тон), поэтому здесь они синтезируются быстрее (rate), чтобы итоговый темп остался естественным.
Если установить дополнительные русские голоса (Системные настройки → Универсальный доступ → Устная речь →
Системный голос → Управление голосами → Русский), скрипт возьмёт их автоматически: мужской голос — для man/elder_m.
"""
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "game" / "public" / "assets" / "audio" / "swear"

# Реплики по ситуациям. who: man, woman, elder_m, elder_w, kid. kind: miss (едва не сбили / подрезали),
# hit (сбили и человек встаёт), rob (ограбили), bump (толкнули пешком), any (подходит везде).
LINES = {
    "man": {
        "miss": ["Куда прёшь, придурок?!", "Ты чё, охренел?!", "Смотри куда едешь, мудак!", "Права купил, что ли?!",
                 "Э, ты слепой, что ли?!", "Совсем страх потерял?!", "Ну ты и козёл!", "Тормози, баран!",
                 "Ёб твою мать, куда летишь?!", "Да чтоб тебя!"],
        "hit": ["Ты чё творишь, сука?!", "Я тебя запомнил, урод!", "Твою ж мать, больно же!", "Ну всё, тебе конец!",
                "Охренеть, он меня сбил!", "Номер записал, понял?!"],
        "rob": ["Отдай, гнида!", "Полиция! Грабят!", "Ах ты сволочь!"],
        "bump": ["Э, полегче!", "Глаза разуй!", "Ты чё толкаешься?!", "Нарываешься, что ли?"],
    },
    "woman": {
        "miss": ["Ты куда едешь, идиот?!", "Совсем больной?!", "Смотри куда прёшь, дебил!", "Ненормальный!",
                 "Козёл! Тут люди ходят!", "Ну и урод!", "Господи, чуть не задавил!"],
        "hit": ["Ты что, совсем охренел?!", "Скотина! Я в полицию пойду!", "Да чтоб у тебя колёса отвалились!",
                "Больно же, кретин!"],
        "rob": ["Помогите! Грабят!", "Отдай сумку, сволочь!"],
        "bump": ["Осторожнее можно?!", "Хам!", "Смотреть надо!"],
    },
    "elder_m": {
        "miss": ["Хулиган!", "Ишь, носится!", "Куда несёшься, бестолочь?!", "Совсем молодёжь распустилась!",
                 "Вот я тебе сейчас палкой!"],
        "hit": ["Милицию вызову!", "Бандит! Я на тебя управу найду!", "Ох, спина моя!"],
        "rob": ["Караул! Грабят!"],
        "bump": ["Не толкайся, сопляк!"],
    },
    "elder_w": {
        "miss": ["Бессовестный!", "Батюшки, чуть не задавил!", "Совсем совести нет!", "Наркоман, что ли?!",
                 "Понаехали тут!"],
        "hit": ["Ой, убили! Люди добрые!", "Ирод окаянный!", "Я на тебя в администрацию напишу!"],
        "rob": ["Караул! Милиция!"],
        "bump": ["Ишь, расталкивается!"],
    },
    "kid": {
        "miss": ["Дурак!", "Мама, он чуть меня не сбил!", "Эй, осторожно!"],
        "hit": ["Ай! Я маме скажу!", "Дурак, больно!"],
        "rob": ["Отдай!"],
        "bump": ["Эй!"],
    },
}

# Скорость синтеза (слов в минуту) и итоговый playbackRate в игре по типу говорящего.
STYLE = {
    "man": {"rate": 265, "play": 0.74},
    "elder_m": {"rate": 220, "play": 0.78},
    "woman": {"rate": 210, "play": 1.0},
    "elder_w": {"rate": 175, "play": 0.95},
    "kid": {"rate": 190, "play": 1.3},
}


def russian_voices() -> tuple[str, str | None]:
    out = subprocess.run(["say", "-v", "?"], capture_output=True, text=True).stdout
    names = [ln.split(" (")[0].split("  ")[0].strip() for ln in out.splitlines() if "ru_RU" in ln]
    if not names:
        sys.exit("нет русских голосов в say")
    male = next((n for n in names if n.split()[0] in ("Yuri", "Юрий")), None)
    female = next((n for n in names if n.split()[0] not in ("Yuri", "Юрий")), names[0])
    return female, male


def main() -> None:
    female, male = russian_voices()
    print("голоса:", female, "| мужской:", male or "нет (понижение тона)")
    OUT.mkdir(parents=True, exist_ok=True)
    for f in OUT.glob("*.m4a"):
        f.unlink()
    entries = []
    with tempfile.TemporaryDirectory() as tmp:
        for who, kinds in LINES.items():
            st = dict(STYLE[who])
            voice = female
            if male and who in ("man", "elder_m"):
                voice, st = male, {"rate": STYLE[who]["rate"] - 60, "play": 0.95}
            for kind, lines in kinds.items():
                for k, text in enumerate(lines):
                    name = f"{who}_{kind}_{k}"
                    aiff = Path(tmp) / f"{name}.aiff"
                    m4a = OUT / f"{name}.m4a"
                    subprocess.run(["say", "-v", voice, "-r", str(st["rate"]), "-o", str(aiff), text], check=True)
                    subprocess.run(["afconvert", "-f", "m4af", "-d", "aac", "-b", "64000", str(aiff), str(m4a)], check=True)
                    entries.append({"id": name, "file": m4a.name, "who": who, "kind": kind, "rate": st["play"],
                                    "text": text})
    (OUT / "swear.json").write_text(json.dumps({"voice": female, "male": male, "lines": entries}, ensure_ascii=False, indent=1))
    size = sum(f.stat().st_size for f in OUT.glob("*.m4a"))
    print(f"реплик: {len(entries)}, {size / 1e6:.2f} МБ → {OUT}")


if __name__ == "__main__":
    main()

"""Покров по спутнику (docs/stage3/landcover.md).

    cd pipeline
    uv run python build_landcover.py              # всё: context → train → predict → post → export
    uv run python build_landcover.py context      # слои OSM/рельефа 1 м (кэш data/processed/landcover/context.npz)
    uv run python build_landcover.py train        # слабые метки + ручные → выборка → LightGBM (model.txt)
    uv run python build_landcover.py predict      # предсказание по чанкам → proba (uint8) → чистка → lc_1m.tif
    uv run python build_landcover.py export       # game/public/world-veg/landcover.png (+ .json), деревья/заросли (canopy.npz)
    uv run python build_landcover.py validate     # точность по ручным точкам data/landcover/validation_points.json
    uv run python build_landcover.py crops        # картинки проверки data/processed/landcover/check/*.png
    uv run python build_landcover.py sheets       # листы точек-кандидатов для ручной проверки (val_sheets/)
"""
import sys
import time

T0 = time.time()


def log(*a):
    print(f"[{time.time() - T0:6.1f}s]", *a, flush=True)


def main(steps):
    from landcover import context, model, post, export, viz
    if "context" in steps:
        context.build(log)
    if "shadowdir" in steps:
        model.shadow_dirs(log)
    if "train" in steps:
        model.train(log)
    if "predict" in steps:
        model.predict(log)
    if "post" in steps:
        post.run(log)
    if "export" in steps:
        export.run(log)
    if "validate" in steps:
        viz.validate(log)
    if "crops" in steps:
        viz.crops(log)
    if "sheets" in steps:
        viz.sheets(log)
    if "trainsheets" in steps:   # точки для ручной разметки обучения (не рядом с точками проверки)
        viz.sheets(log, n_per_class=40, seed=23, kind="train")


if __name__ == "__main__":
    a = sys.argv[1:] or ["context", "train", "predict", "post", "export", "validate", "crops"]
    main(a)

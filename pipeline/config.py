"""Общие константы пайплайна: регион и система координат мира."""
from pathlib import Path

from pyproj import CRS, Transformer

ROOT = Path(__file__).resolve().parent.parent
DATA_RAW = ROOT / "data" / "raw"
DATA_PROCESSED = ROOT / "data" / "processed"

# Рабочий bbox MVP-региона: (south, west, north, east), WGS84
BBOX = (54.600, 39.700, 54.665, 39.810)

# Начало координат мира: Рязанский кремль. 1 юнит = 1 м.
ORIGIN_LAT, ORIGIN_LON = 54.6363, 39.7496

# Локальная поперечная Меркатора с центром в начале координат: x — восток, y — север (метры)
WORLD_CRS = CRS.from_proj4(
    f"+proj=tmerc +lat_0={ORIGIN_LAT} +lon_0={ORIGIN_LON} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs"
)
WGS84 = CRS.from_epsg(4326)

to_world = Transformer.from_crs(WGS84, WORLD_CRS, always_xy=True)  # (lon, lat) -> (x, y)
to_wgs84 = Transformer.from_crs(WORLD_CRS, WGS84, always_xy=True)  # (x, y) -> (lon, lat)

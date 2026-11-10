"""Проекция мировых точек в эквипрямоугольную панораму Яндекса."""
import numpy as np

from config import to_world

CAM_H = 2.6  # высота камеры над землёй, м (машина Яндекса)
CAM_H_SPHERE = 2.0  # полносферные панорамы (пешеходные/рюкзачные/сторонние)


class PanoCam:
    def __init__(self, info, W, y0=0, ground_z=0.0, H=None):
        self.info = info
        self.W = W
        self.ppd = W / 360.0
        self.y0 = y0
        self.x, self.y = to_world.transform(info["lon"], info["lat"])
        self.heading = info["heading"]
        self.z = ground_z + (CAM_H_SPHERE if H is not None and H >= 0.48 * W else CAM_H)

    def bearing(self, X, Y):
        """Азимут (град, по часовой от севера) на мировые точки."""
        return np.degrees(np.arctan2(np.asarray(X) - self.x, np.asarray(Y) - self.y)) % 360.0

    def project(self, X, Y, Z):
        """-> (u, v) в пикселях полосы (v уже со сдвигом y0), d — горизонтальная дальность."""
        X, Y, Z = map(np.asarray, (X, Y, Z))
        d = np.hypot(X - self.x, Y - self.y)
        b = self.bearing(X, Y)
        elev = np.degrees(np.arctan2(Z - self.z, d))
        u = ((b - self.heading) % 360.0) * self.ppd
        v = (90.0 - elev) * self.ppd - self.y0
        return u, v, d

    def u_of_bearing(self, b):
        return ((np.asarray(b) - self.heading) % 360.0) * self.ppd

    def v_of_elev(self, e):
        return (90.0 - np.asarray(e)) * self.ppd - self.y0

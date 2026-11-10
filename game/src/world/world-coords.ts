/**
 * COORDINATE SYSTEMS
 *
 * Pipeline (docs/TZ.md, data pipeline): local metric frame, x = east, y = north, z/height = up.
 * Game (three.js, Y-up, right-handed), 1 unit = 1 metre:
 *     three.x =  pipeline.x   (east)
 *     three.y =  height       (up)
 *     three.z = -pipeline.y   (so north = -Z, south = +Z)
 *
 * Car local frame: forward = -Z, right = +X, up = +Y.
 */
import * as THREE from 'three';

export const pipelineToThree = (x: number, y: number, height = 0, out = new THREE.Vector3()) =>
  out.set(x, height, -y);

export const threeToPipeline = (v: THREE.Vector3) => ({ x: v.x, y: -v.z, height: v.y });

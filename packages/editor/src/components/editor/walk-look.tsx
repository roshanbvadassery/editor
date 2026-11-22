'use client'

import {
  type AnyNode,
  type PointContext,
  resolveLevelId,
  sceneRegistry,
  useScene,
} from '@pascal-app/core'
import { useViewer } from '@pascal-app/viewer'
import { useThree } from '@react-three/fiber'
import { useEffect } from 'react'
import { type Object3D, PerspectiveCamera, Vector2, Vector3 } from 'three'
import { buildPointContext } from '../../lib/point-ask/build-context'

// Look-and-ask from the walkthrough: what sits under the crosshair, as the same `PointContext`
// point-and-ask sends, so a host's chat can say "this wall" by id from where the person stands.

const CENTER = new Vector2(0, 0)
/** How far ahead of the eye the camera target is put when nothing is hit (m). */
const LOOK_AHEAD_M = 3

type Capture = () => PointContext | null
let capture: Capture | null = null

/**
 * What the walker is looking at: the element under the crosshair (with the hit point and face
 * normal) and the eye pose. Null outside a walkthrough.
 */
export function captureWalkLook(): PointContext | null {
  return capture?.() ?? null
}

/** Mounted in first person: lends `captureWalkLook` the walk camera. */
export function WalkLookSystem() {
  const camera = useThree((s) => s.camera)
  const raycaster = useThree((s) => s.raycaster)
  const size = useThree((s) => s.size)

  useEffect(() => {
    const run: Capture = () => {
      const nodes = useScene.getState().nodes as Record<string, AnyNode>
      raycaster.setFromCamera(CENTER, camera)
      const owners = new Map<Object3D, string>()
      for (const [id, object] of sceneRegistry.nodes) owners.set(object, id)

      let target: { id: string; hit?: PointContext['targets'][number]['hit'] } | null = null
      let point: Vector3 | null = null
      for (const hit of raycaster.intersectObjects([...owners.keys()], true)) {
        let hidden = false
        let id: string | undefined
        for (let o: Object3D | null = hit.object; o; o = o.parent) {
          if (!o.visible) hidden = true
          id ??= owners.get(o)
        }
        const node = id ? nodes[id] : undefined
        // Zones are an area, not a surface: the wall, floor or item in front is what is meant.
        if (hidden || !node || node.type === 'zone') continue
        const normal = hit.face
          ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld)
          : null
        point = hit.point
        target = {
          id: node.id,
          ...(normal
            ? {
                hit: {
                  point: [hit.point.x, hit.point.y, hit.point.z],
                  normal: [normal.x, normal.y, normal.z],
                },
              }
            : {}),
        }
        break
      }

      const eye = camera.getWorldPosition(new Vector3())
      const ahead = point
        ? point.clone()
        : eye.clone().add(camera.getWorldDirection(new Vector3()).multiplyScalar(LOOK_AHEAD_M))
      const levelId =
        (target ? resolveLevelId(nodes[target.id]!, nodes) : null) ??
        useViewer.getState().selection.levelId
      if (!levelId) return null

      return buildPointContext({
        askId: `ask_${Date.now().toString(36)}`,
        gesture: 'click',
        nodes,
        levelId,
        targets: target ? [target] : [],
        camera: {
          position: [eye.x, eye.y, eye.z],
          target: [ahead.x, ahead.y, ahead.z],
          fov: camera instanceof PerspectiveCamera ? camera.fov : 60,
          aspect: size.width / Math.max(1, size.height),
          projection: 'perspective',
        },
      })
    }
    capture = run
    return () => {
      if (capture === run) capture = null
    }
  }, [camera, raycaster, size])

  return null
}

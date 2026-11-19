'use client'

// Furnishing from inside the walkthrough. P frees the cursor (the walk pauses); a furniture tray
// appears, and the room can be furnished from where you stand:
//   - drag a piece from the tray onto the floor: it lands where the cursor ray meets the floor,
//     facing you;
//   - click a piece to select it, drag it along the floor, R / Shift+R to turn it 15°, Delete to
//     remove it, click empty floor to let go of it;
//   - click empty space (nothing selected) or press P to walk again.
// Each drop, move, turn and removal is one undo step. Editor-only: the viewer route never places.

import {
  type AnyNodeId,
  type AssetInput,
  ItemNode,
  resolveSupportSlabPatch,
  sceneRegistry,
  useScene,
} from '@pascal-app/core'
import { isTypingTarget, useViewer } from '@pascal-app/viewer'
import { useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BoxHelper,
  type Intersection,
  type Object3D,
  Plane,
  Raycaster,
  Vector2,
  Vector3,
} from 'three'
import { create } from 'zustand'
import useEditor from '../../store/use-editor'
import { CATALOG_ITEMS, type CatalogItem } from '../ui/item-catalog/catalog-items'

const TURN = Math.PI / 12 // 15°
const DRAG_MIME = 'application/x-pascal-walk-asset'
/** How far in front of a wall a piece dropped on it lands (m). */
const WALL_CLEARANCE = 0.6

type WalkFurnishState = {
  /** The tile being dragged from the tray (dataTransfer can't be read during dragover). */
  dragging: CatalogItem | null
  selectedId: AnyNodeId | null
  setDragging: (asset: CatalogItem | null) => void
  select: (id: AnyNodeId | null) => void
}

export const useWalkFurnish = create<WalkFurnishState>((set) => ({
  dragging: null,
  selectedId: null,
  setDragging: (dragging) => set({ dragging }),
  select: (selectedId) => set({ selectedId }),
}))

/** Whether the walk is paused (cursor free) in the editor's walk mode: the furnishing window. */
function useFurnishing() {
  const firstPerson = useEditor((s) => s.isFirstPersonMode)
  const walk = useEditor((s) => s.firstPersonMovementMode === 'walk')
  const capture = useEditor((s) => s.isCaptureMode)
  const suspended = useViewer((s) => s.walkthroughSuspended)
  return firstPerson && walk && !capture && suspended
}

/** Floor-standing catalog pieces (wall / ceiling mounts and tool-driven kinds need their own tools). */
function walkCatalog(): CatalogItem[] {
  return CATALOG_ITEMS.filter((item) => !item.tool && !item.attachTo && item.src)
}

function registryByObject(): Map<Object3D, AnyNodeId> {
  const byObject = new Map<Object3D, AnyNodeId>()
  for (const [id, obj] of sceneRegistry.nodes) byObject.set(obj, id as AnyNodeId)
  return byObject
}

/** The nearest scene node an intersected object belongs to, optionally only of `type`. */
function nodeIdOf(object: Object3D | null, type?: string): AnyNodeId | null {
  const byObject = registryByObject()
  const nodes = useScene.getState().nodes
  for (let o: Object3D | null = object; o; o = o.parent) {
    const id = byObject.get(o)
    if (id && (!type || nodes[id]?.type === type)) return id
  }
  return null
}

const itemIdOf = (object: Object3D | null) => nodeIdOf(object, 'item')

/** Drawn: the object and all its ancestors are visible. */
function isVisible(object: Object3D): boolean {
  for (let o: Object3D | null = object; o; o = o.parent) if (!o.visible) return false
  return true
}

export function WalkFurnishSystem() {
  const active = useFurnishing()
  return active ? <WalkFurnishSession /> : null
}

function WalkFurnishSession() {
  const gl = useThree((s) => s.gl)
  const camera = useThree((s) => s.camera)
  const scene = useThree((s) => s.scene)
  const selectedId = useWalkFurnish((s) => s.selectedId)
  const raycaster = useMemo(() => new Raycaster(), [])

  // Selection outline (the model may still be loading when a dropped piece is selected).
  useEffect(() => {
    if (!selectedId) return
    let helper: BoxHelper | null = null
    let frame = 0
    const tick = () => {
      const obj = sceneRegistry.nodes.get(selectedId)
      if (obj && !helper) {
        helper = new BoxHelper(obj, 0x10b981)
        helper.layers.enableAll()
        scene.add(helper)
      }
      helper?.update()
      frame = requestAnimationFrame(tick)
    }
    tick()
    return () => {
      cancelAnimationFrame(frame)
      if (helper) {
        scene.remove(helper)
        helper.dispose()
      }
    }
  }, [selectedId, scene])

  useEffect(() => () => useWalkFurnish.getState().select(null), [])

  useEffect(() => {
    const canvas = gl.domElement
    const ndc = new Vector2()

    const ray = (clientX: number, clientY: number) => {
      const r = canvas.getBoundingClientRect()
      ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1)
      raycaster.setFromCamera(ndc, camera)
      raycaster.layers.enableAll()
      return raycaster
    }

    const levelObject = () => {
      const levelId = useViewer.getState().selection.levelId
      return levelId
        ? { id: levelId as AnyNodeId, obj: sceneRegistry.nodes.get(levelId) ?? null }
        : null
    }

    /**
     * Where the cursor ray meets the walkable floor of the current level, in level-local space.
     * Walls and furniture stop the ray: pointing at a wall puts the piece on the floor in front of
     * it, never in the room behind.
     */
    const floorPoint = (
      clientX: number,
      clientY: number,
      ignore?: AnyNodeId | null,
    ): Vector3 | null => {
      const level = levelObject()
      if (!level?.obj) return null
      const rc = ray(clientX, clientY)
      const floorY = new Vector3().setFromMatrixPosition(level.obj.matrixWorld).y
      const hits = rc
        .intersectObjects(scene.children, true)
        .filter(
          (h) =>
            isVisible(h.object) &&
            !(h.object instanceof BoxHelper) &&
            !(ignore && nodeIdOf(h.object, 'item') === ignore),
        )
      const first = hits[0]
      let world: Vector3 | null = null
      if (first && isFloorLike(first)) {
        world = first.point.clone()
      } else {
        const onPlane = rc.ray.intersectPlane(
          new Plane(new Vector3(0, 1, 0), -floorY),
          new Vector3(),
        )
        if (onPlane && (!first || rc.ray.origin.distanceTo(onPlane) < first.distance)) {
          world = onPlane
        } else if (first) {
          // at the foot of what the ray hit, pulled back toward the viewer
          const back = rc.ray.direction.clone().setY(0).normalize().multiplyScalar(-WALL_CLEARANCE)
          world = first.point.clone().add(back).setY(floorY)
        }
      }
      if (!world) return null
      return level.obj.worldToLocal(world)
    }

    const isFloorLike = (h: Intersection) => {
      if (!h.face) return false
      const n = h.face.normal.clone().transformDirection(h.object.matrixWorld)
      if (n.y < 0.7) return false
      const id = nodeIdOf(h.object)
      const node = id ? useScene.getState().nodes[id] : null
      return !node || node.type === 'slab' || node.type === 'zone' || node.type === 'level'
    }

    const facingYaw = (local: Vector3) => {
      const level = levelObject()
      if (!level?.obj) return 0
      const eye = level.obj.worldToLocal(camera.getWorldPosition(new Vector3()))
      return Math.atan2(eye.x - local.x, eye.z - local.z)
    }

    // --- drop from the tray ------------------------------------------------------------------
    const onDragOver = (e: DragEvent) => {
      if (!useWalkFurnish.getState().dragging) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const onDrop = (e: DragEvent) => {
      const asset = useWalkFurnish.getState().dragging
      if (!asset) return
      e.preventDefault()
      useWalkFurnish.getState().setDragging(null)
      const level = levelObject()
      const at = floorPoint(e.clientX, e.clientY)
      if (!level || !at) return
      const { tool: _tool, ...input } = asset
      const node = ItemNode.parse({
        position: [at.x, 0, at.z],
        rotation: [0, facingYaw(at), 0],
        scale: [1, 1, 1],
        name: asset.name,
        asset: input as AssetInput,
        parentId: level.id,
      })
      useScene.getState().createNode(node, level.id)
      const patch = resolveSupportSlabPatch(node, useScene.getState().nodes)
      if (patch.supportSlabId !== undefined) {
        useScene.temporal.getState().pause()
        useScene.getState().updateNode(node.id, patch as never)
        useScene.temporal.getState().resume()
      }
      useWalkFurnish.getState().select(node.id as AnyNodeId)
    }

    // --- select / drag on the floor ------------------------------------------------------------
    let drag: {
      id: AnyNodeId
      offset: Vector3
      pointerId: number
      start: ItemNode['position']
      moved: boolean
    } | null = null
    let swallowClick = false

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0 || document.pointerLockElement === canvas) return
      const rc = ray(e.clientX, e.clientY)
      const hit = rc
        .intersectObjects(scene.children, true)
        .find((h) => h.object.visible && itemIdOf(h.object))
      const id = hit ? itemIdOf(hit.object) : null
      const { selectedId: current, select } = useWalkFurnish.getState()
      if (!id) {
        // empty space: let go of the selection (the walk resumes only with nothing selected)
        if (current) {
          select(null)
          swallowClick = true
        }
        return
      }
      e.preventDefault()
      e.stopPropagation()
      swallowClick = true
      select(id)
      const node = useScene.getState().nodes[id] as ItemNode | undefined
      const at = floorPoint(e.clientX, e.clientY, id)
      if (!node || !at) return
      drag = {
        id,
        offset: new Vector3(node.position[0] - at.x, 0, node.position[2] - at.z),
        pointerId: e.pointerId,
        start: node.position,
        moved: false,
      }
      useScene.temporal.getState().pause()
      canvas.setPointerCapture(e.pointerId)
    }

    const onPointerMove = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.pointerId) return
      const at = floorPoint(e.clientX, e.clientY, drag.id)
      const node = useScene.getState().nodes[drag.id] as ItemNode | undefined
      if (!at || !node) return
      drag.moved = true
      useScene.getState().updateNode(drag.id, {
        position: [at.x + drag.offset.x, node.position[1], at.z + drag.offset.z],
      } as never)
    }

    const endDrag = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.pointerId) return
      const { id, moved, start } = drag
      drag = null
      canvas.releasePointerCapture(e.pointerId)
      const now = useScene.getState().nodes[id] as ItemNode | undefined
      // One undo step for the whole drag: back to the start untracked, then the drop tracked.
      if (moved && now) useScene.getState().updateNode(id, { position: start } as never)
      useScene.temporal.getState().resume()
      if (moved && now) useScene.getState().updateNode(id, { position: now.position } as never)
    }

    // The walkthrough re-locks the pointer on any canvas click; a click that selected, dragged or
    // let go of a piece is ours.
    const onClick = (e: MouseEvent) => {
      if (!swallowClick) return
      swallowClick = false
      e.stopPropagation()
    }

    // --- keys (before the walkthrough's own: its R opens doors) -----------------------------------
    // Esc stays the editor's (it closes panels, then leaves the walk); clicking the floor lets go.
    const onKeyDown = (e: KeyboardEvent) => {
      const id = useWalkFurnish.getState().selectedId
      if (!id || isTypingTarget(e.target)) return
      const node = useScene.getState().nodes[id] as ItemNode | undefined
      if (!node) return
      if (e.code === 'KeyR') {
        e.preventDefault()
        e.stopImmediatePropagation()
        const yaw = node.rotation[1] + (e.shiftKey ? -TURN : TURN)
        useScene
          .getState()
          .updateNode(id, { rotation: [node.rotation[0], yaw, node.rotation[2]] } as never)
      } else if (e.code === 'Delete' || e.code === 'Backspace') {
        e.preventDefault()
        e.stopImmediatePropagation()
        useWalkFurnish.getState().select(null)
        useScene.getState().deleteNode(id)
      }
    }

    canvas.addEventListener('dragover', onDragOver)
    canvas.addEventListener('drop', onDrop)
    canvas.addEventListener('pointerdown', onPointerDown, true)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', endDrag)
    canvas.addEventListener('pointercancel', endDrag)
    canvas.addEventListener('click', onClick, true)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      canvas.removeEventListener('dragover', onDragOver)
      canvas.removeEventListener('drop', onDrop)
      canvas.removeEventListener('pointerdown', onPointerDown, true)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', endDrag)
      canvas.removeEventListener('pointercancel', endDrag)
      canvas.removeEventListener('click', onClick, true)
      window.removeEventListener('keydown', onKeyDown, true)
      if (drag) useScene.temporal.getState().resume()
    }
  }, [gl, camera, scene, raycaster])

  return null
}

/** The furniture tray, over the paused walk. */
export function WalkFurnishTray() {
  const active = useFurnishing()
  const selectedId = useWalkFurnish((s) => s.selectedId)
  const selectedName = useScene((s) =>
    selectedId ? (s.nodes[selectedId] as ItemNode | undefined)?.name : null,
  )
  const [query, setQuery] = useState('')
  const items = useMemo(() => walkCatalog(), [])
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter((i) =>
      `${i.name} ${(i.tags ?? []).join(' ')} ${i.category}`.toLowerCase().includes(q),
    )
  }, [items, query])
  const scroller = useRef<HTMLDivElement>(null)

  if (!active) return null
  return (
    <div className="pointer-events-auto absolute inset-x-0 bottom-20 z-40 flex justify-center px-4">
      <div className="dark w-full max-w-4xl rounded-2xl border border-border/40 bg-background/90 p-3 text-foreground shadow-2xl backdrop-blur-xl">
        <div className="mb-2 flex items-center gap-3 text-xs">
          <span className="font-medium">Furnish</span>
          <span className="text-muted-foreground">
            {selectedName
              ? `${selectedName}: drag to move · R / Shift+R turn · Delete remove · click the floor to let go`
              : 'Drag a piece into the room · click a piece to move it · P or click the room to walk'}
          </span>
          <input
            className="ml-auto w-40 rounded-md border border-border/50 bg-transparent px-2 py-1 text-xs outline-none placeholder:text-muted-foreground"
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search furniture"
            value={query}
          />
        </div>
        <div
          className="flex gap-2 overflow-x-auto pb-1"
          onWheel={(e) => {
            if (scroller.current && Math.abs(e.deltaY) > Math.abs(e.deltaX))
              scroller.current.scrollLeft += e.deltaY
          }}
          ref={scroller}
        >
          {shown.map((item) => (
            <div
              className="flex w-20 shrink-0 cursor-grab flex-col items-center gap-1 rounded-lg border border-transparent p-1 hover:border-border/60 hover:bg-accent/40 active:cursor-grabbing"
              draggable
              key={item.id}
              onDragEnd={() => useWalkFurnish.getState().setDragging(null)}
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_MIME, item.id ?? item.name)
                e.dataTransfer.effectAllowed = 'copy'
                useWalkFurnish.getState().setDragging(item)
              }}
              title={item.name}
            >
              {item.thumbnail ? (
                <img
                  alt=""
                  className="h-14 w-14 rounded-md object-contain"
                  decoding="async"
                  draggable={false}
                  loading="lazy"
                  src={item.thumbnail}
                />
              ) : (
                <div className="h-14 w-14 rounded-md bg-muted" />
              )}
              <span className="line-clamp-1 w-full text-center text-[10px] text-muted-foreground">
                {item.name}
              </span>
            </div>
          ))}
          {shown.length === 0 && (
            <div className="px-2 py-4 text-muted-foreground text-xs">
              Nothing matches “{query}”.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

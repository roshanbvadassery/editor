'use client'

import { usePascalI18n } from '@pascal-app/core'
import { ArrowBigUp, Blinds, ChevronsDown, DoorClosed, Hand, Move, X } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useRef } from 'react'
import { useWalkthroughInputLifecycle } from '../../hooks/use-walkthrough-input-lifecycle'
import { createWalkthroughInput, onWalkthroughInputClear } from '../../lib/walkthrough-input'
import { useFirstPersonHud } from '../../store/use-first-person-hud'
import useViewer from '../../store/use-viewer'
import { cn } from '../lib/cn'
import { createWalkthroughTouchGestures, STICK_RADIUS } from '../lib/walkthrough-touch'

export type WalkthroughTouchControlsProps = {
  className?: string
  /** Host actions above the context buttons (e.g. an "Ask" button that opens the host's chat). */
  actions?: ReactNode
}

/** Mount outside the canvas. The host chooses touch mode before entering walkthrough. */
export function WalkthroughTouchControls(props: WalkthroughTouchControlsProps) {
  const active = useViewer(
    (state) => state.walkthroughMode && state.walkthroughInputMode === 'touch',
  )
  return active ? <TouchSession {...props} /> : null
}

function TouchSession({ className, actions }: WalkthroughTouchControlsProps) {
  const i18n = usePascalI18n()
  const target = useFirstPersonHud((state) => state.interact)
  const shuttersInView = useFirstPersonHud((state) => state.shuttersInView)
  const canClose = useFirstPersonHud((state) => state.canClose)
  const stickRef = useRef<HTMLDivElement>(null)
  const knobRef = useRef<HTMLDivElement>(null)
  const ghostRef = useRef<HTMLDivElement>(null)
  const gestures = useMemo(
    () =>
      createWalkthroughTouchGestures((visual) => {
        const stick = stickRef.current
        const knob = knobRef.current
        if (!stick || !knob) return
        stick.style.display = visual ? 'block' : 'none'
        // The resting stick shows where to put a thumb; it steps aside while the live one is out.
        if (ghostRef.current) ghostRef.current.style.opacity = visual ? '0' : '1'
        if (visual) {
          stick.style.left = `${visual.x - STICK_RADIUS}px`
          stick.style.top = `${visual.y - STICK_RADIUS}px`
          knob.style.transform = `translate(${visual.dx}px, ${visual.dy}px)`
        }
      }),
    [],
  )
  useWalkthroughInputLifecycle()
  useEffect(() => onWalkthroughInputClear(gestures.reset), [gestures])
  const input = createWalkthroughInput()
  // Glass controls in the viewer's dark style, sized for thumbs (≥ 48px).
  const glass =
    'pointer-events-auto flex items-center justify-center border border-white/15 bg-neutral-950/55 text-white shadow-lg backdrop-blur-xl transition-[transform,background-color] active:scale-95 active:bg-neutral-950/75'
  const pill = cn(glass, 'h-11 gap-2 rounded-full px-4 font-medium text-sm')
  const round = cn(glass, 'flex-col gap-0.5 rounded-full font-medium text-[10px] leading-none')

  return (
    <div
      className={cn('fixed inset-0 z-40 select-none text-foreground', className)}
      data-walkthrough-touch-controls=""
      onLostPointerCapture={gestures.lost}
      onPointerCancel={gestures.cancel}
      onPointerUp={gestures.up}
      style={{ touchAction: 'none' }}
    >
      {/* Drag anywhere to look; the stick only wakes in the bottom-left, where the thumb rests. */}
      <div
        className="absolute inset-0"
        data-walkthrough-look=""
        onPointerDown={gestures.lookDown}
        onPointerMove={gestures.lookMove}
      />
      <div
        className="absolute bottom-0 left-0 h-[40%] w-1/2"
        data-walkthrough-stick=""
        onPointerDown={gestures.stickDown}
        onPointerMove={gestures.stickMove}
      />
      {/* Resting stick: where the thumb goes (the stick itself floats to wherever it lands). */}
      <div
        className="pointer-events-none absolute bottom-[max(2rem,env(safe-area-inset-bottom))] left-[max(2rem,env(safe-area-inset-left))] flex items-center justify-center rounded-full border border-white/20 bg-neutral-950/25 backdrop-blur-sm transition-opacity duration-200"
        ref={ghostRef}
        style={{ width: STICK_RADIUS * 2, height: STICK_RADIUS * 2 }}
      >
        <div className="flex h-12 w-12 items-center justify-center rounded-full border border-white/25 bg-white/15">
          <Move className="h-5 w-5 text-white/80" />
        </div>
      </div>
      <div
        className="pointer-events-none fixed rounded-full border border-white/25 bg-neutral-950/30 backdrop-blur-sm"
        ref={stickRef}
        style={{ display: 'none', width: STICK_RADIUS * 2, height: STICK_RADIUS * 2 }}
      >
        <div
          className="absolute top-1/2 left-1/2 -mt-6 -ml-6 h-12 w-12 rounded-full border border-white/40 bg-white/30 shadow-lg"
          ref={knobRef}
        />
      </div>

      <div className="pointer-events-none absolute right-[max(1.25rem,env(safe-area-inset-right))] bottom-[max(1.5rem,env(safe-area-inset-bottom))] flex flex-col items-end gap-3">
        {actions}
        {/* Context actions appear only when there is something to act on. */}
        {target && (
          <button
            className={cn(
              pill,
              'h-12 max-w-[60vw] border-emerald-300/40 bg-emerald-500/85 text-white active:bg-emerald-600/90',
            )}
            onPointerDown={(event) => {
              if (gestures.buttonDown(event)) input.requestInteract()
            }}
            type="button"
          >
            <Hand className="h-4 w-4 shrink-0" />
            <span className="truncate">
              {target.verb} {target.label}
            </span>
          </button>
        )}
        {canClose && (
          <button
            className={pill}
            onPointerDown={(event) => {
              if (gestures.buttonDown(event)) input.requestClose()
            }}
            type="button"
          >
            <DoorClosed className="h-4 w-4" />
            {i18n._({ id: 'viewer.walkthroughTouch.close', message: 'Close' })}
          </button>
        )}
        {shuttersInView && (
          <button
            className={pill}
            data-walkthrough-shutters=""
            onPointerDown={(event) => {
              if (gestures.buttonDown(event)) input.requestShutters()
            }}
            type="button"
          >
            <Blinds className="h-4 w-4" />
            {i18n._({ id: 'viewer.walkthrough.shutters', message: 'Shutters' })}
          </button>
        )}
        <div className="flex items-end gap-3">
          <button
            className={cn(round, 'h-14 w-14')}
            onPointerDown={gestures.crouchDown}
            type="button"
          >
            <ChevronsDown className="h-5 w-5" />
            {i18n._({ id: 'viewer.walkthroughTouch.crouch', message: 'Crouch' })}
          </button>
          <button
            className={cn(round, 'h-[4.5rem] w-[4.5rem] text-[11px]')}
            onPointerDown={(event) => {
              if (gestures.buttonDown(event)) input.requestJump()
            }}
            type="button"
          >
            <ArrowBigUp className="h-6 w-6" />
            {i18n._({ id: 'viewer.walkthroughTouch.jump', message: 'Jump' })}
          </button>
        </div>
      </div>

      <button
        className={cn(
          pill,
          'absolute top-[max(1rem,env(safe-area-inset-top))] right-[max(1rem,env(safe-area-inset-right))] h-10 px-3.5',
        )}
        onClick={gestures.exit}
        onPointerDown={gestures.buttonDown}
        type="button"
      >
        <X className="h-4 w-4" />
        {i18n._({ id: 'viewer.walkthroughTouch.exit', message: 'Exit' })}
      </button>
    </div>
  )
}

import { flushSync } from 'react-dom'
import useEditor from '../store/use-editor'
import { requestWalkthroughPointerLock } from './walkthrough-pointer-lock'

/**
 * Enter the first-person walkthrough from anywhere in a host's chrome (Zopu Studio's Walk
 * button): the same entry the viewer's controls bar uses, so the editor mounts its first-person
 * controls and HUD, then grabs pointer lock in the same user gesture.
 * `drone` arms free flight before first person, so the walk's collider is never built for it.
 */
export function enterWalkthrough(movement: 'walk' | 'drone' = 'walk') {
  flushSync(() => {
    const editor = useEditor.getState()
    editor.setFirstPersonMovementMode(movement)
    editor.setFirstPersonMode(true)
  })
  requestWalkthroughPointerLock()
}

/** Leave the walkthrough (the HUD's Exit does the same). */
export function exitWalkthrough() {
  if (document.pointerLockElement) document.exitPointerLock()
  useEditor.getState().setFirstPersonMode(false)
}

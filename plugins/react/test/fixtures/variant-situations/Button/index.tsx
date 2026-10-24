import { StaticPart, useVariantKey } from '@visual-editor/react'
import ButtonData from './Button.data'
import type { ButtonProps } from './Button.types'

// The static part and its starting data: development only (left out of production builds).
const preview = import.meta.env.DEV ? { start: () => import('./Button.mock'), part: () => import('./Button.static') } : undefined

/** The chooser: the real part in the app; the static prototype in Preview and the Playground. */
export default function Button(props: ButtonProps) {
  if (useVariantKey() === 'real' || !preview) return <ButtonData {...props} />
  return <StaticPart {...preview} props={props} />
}

export { Button }
export type { ButtonProps, ButtonSituation } from './Button.types'

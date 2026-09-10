// Minimal stroke icon set for the media-studio canvas UI.
//
// Geometry is based on Lucide (ISC) at 24×24 viewBox so it reads the same as
// standard icon sets without pulling a dependency into the client
// bundle (the DSH client loader resolves only react / react-dom; everything
// else is inlined into lib/client.js). Icons inherit currentColor.

import type { ReactNode, SVGProps } from 'react'

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'width' | 'height' | 'stroke'> {
  size?: number
  strokeWidth?: number
}

function makeIcon(children: ReactNode, _label: string) {
  return function Icon({ size = 16, strokeWidth = 1.75, ...rest }: IconProps) {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden={rest['aria-hidden'] ?? true}
        {...rest}
      >
        {children}
      </svg>
    )
  }
}

/** Canvas / layout grid icon — used as the Media Studio sidebar-tab glyph. */
export const IconCanvas = makeIcon(
  <>
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="14" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
  </>,
  'Canvas',
)

export const IconImage = makeIcon(
  <>
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
    <circle cx="8.5" cy="8.5" r="1.5" />
    <polyline points="21 15 16 10 5 21" />
  </>,
  'Image',
)

export const IconFilm = makeIcon(
  <>
    <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18" />
    <line x1="7" y1="2" x2="7" y2="22" />
    <line x1="17" y1="2" x2="17" y2="22" />
    <line x1="2" y1="12" x2="22" y2="12" />
    <line x1="2" y1="7" x2="7" y2="7" />
    <line x1="2" y1="17" x2="7" y2="17" />
    <line x1="17" y1="17" x2="22" y2="17" />
    <line x1="17" y1="7" x2="22" y2="7" />
  </>,
  'Video',
)

export const IconMusic = makeIcon(
  <>
    <path d="M9 18V5l12-2v13" />
    <circle cx="6" cy="18" r="3" />
    <circle cx="18" cy="16" r="3" />
  </>,
  'Voice',
)

export const IconType = makeIcon(
  <>
    <polyline points="4 7 4 4 20 4 20 7" />
    <line x1="9" y1="20" x2="15" y2="20" />
    <line x1="12" y1="4" x2="12" y2="20" />
  </>,
  'Text',
)

export const IconNote = makeIcon(
  <>
    <path d="M15.5 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3z" />
    <polyline points="15 3 15 9 21 9" />
    <line x1="9" y1="14" x2="15" y2="14" />
    <line x1="9" y1="18" x2="13" y2="18" />
  </>,
  'Note',
)

export const IconPlus = makeIcon(
  <>
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </>,
  'Add',
)

export const IconX = makeIcon(
  <>
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </>,
  'Close',
)

export const IconDownload = makeIcon(
  <>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </>,
  'Download',
)

export const IconMaximize2 = makeIcon(
  <>
    <polyline points="15 3 21 3 21 9" />
    <polyline points="9 21 3 21 3 15" />
    <line x1="21" y1="3" x2="14" y2="10" />
    <line x1="3" y1="21" x2="10" y2="14" />
  </>,
  'Expand',
)

export const IconCheck = makeIcon(
  <>
    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
    <polyline points="22 4 12 14.01 9 11.01" />
  </>,
  'Done',
)

export const IconTrash2 = makeIcon(
  <>
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <line x1="10" y1="11" x2="10" y2="17" />
    <line x1="14" y1="11" x2="14" y2="17" />
  </>,
  'Delete',
)

export const IconMoreH = makeIcon(
  <>
    <circle cx="12" cy="12" r="1" />
    <circle cx="19" cy="12" r="1" />
    <circle cx="5" cy="12" r="1" />
  </>,
  'More',
)

export const IconMap = makeIcon(
  <>
    <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6" />
    <line x1="8" y1="2" x2="8" y2="18" />
    <line x1="16" y1="6" x2="16" y2="22" />
  </>,
  'Minimap',
)

export const IconWand = makeIcon(
  <>
    <path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72Z" />
    <path d="m14 7 3 3" />
    <path d="M5 6v4" />
    <path d="M19 14v4" />
    <path d="M10 2v2" />
    <path d="M7 8H3" />
    <path d="M21 16h-4" />
    <path d="M11 3H9" />
  </>,
  'Auto arrange',
)

export const IconMinus = makeIcon(
  <>
    <line x1="5" y1="12" x2="19" y2="12" />
  </>,
  'Zoom out',
)

export const IconZoomIn = makeIcon(
  <>
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </>,
  'Zoom in',
)

export const IconSparkles = makeIcon(
  <>
    <path d="M9.94 15.5a2 2 0 0 0-1.44-1.44l-3.11-.78a1 1 0 0 1 0-1.9l3.1-.78a2 2 0 0 0 1.45-1.44l.78-3.1a1 1 0 0 1 1.9 0l.78 3.1a2 2 0 0 0 1.44 1.44l3.11.78a1 1 0 0 1 0 1.9l-3.1.78a2 2 0 0 0-1.45 1.44l-.78 3.1a1 1 0 0 1-1.9 0z" />
    <path d="M19 3v3" />
    <path d="M17.5 4.5h3" />
  </>,
  'Prompts',
)

export const IconLoader = makeIcon(
  <>
    <line x1="12" y1="2" x2="12" y2="6" />
    <line x1="12" y1="18" x2="12" y2="22" />
    <line x1="4.93" y1="4.93" x2="7.76" y2="7.76" />
    <line x1="16.24" y1="16.24" x2="19.07" y2="19.07" />
    <line x1="2" y1="12" x2="6" y2="12" />
    <line x1="18" y1="12" x2="22" y2="12" />
    <line x1="4.93" y1="19.07" x2="7.76" y2="16.24" />
    <line x1="16.24" y1="7.76" x2="19.07" y2="4.93" />
  </>,
  'Loading',
)

export const IconRefreshCw = makeIcon(
  <>
    <polyline points="23 4 23 10 17 10" />
    <polyline points="1 20 1 14 7 14" />
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
  </>,
  'Refresh',
)

export const IconEraser = makeIcon(
  <>
    <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" />
    <path d="M22 21H7" />
    <path d="m5 11 9 9" />
  </>,
  'Clear',
)

export const IconLock = makeIcon(
  <>
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </>,
  'Lock',
)

/**
 * Topology-flow icon — used by the "arrange by flow" (no-region) button
 * inside the auto-arrange capsule. Three nodes wired head-to-tail, matching
 * the depth-column layout the topology mode produces on canvas.
 */
export const IconFlow = makeIcon(
  <>
    <circle cx="5" cy="6" r="2.5" />
    <circle cx="19" cy="12" r="2.5" />
    <circle cx="5" cy="18" r="2.5" />
    <line x1="7.5" y1="6" x2="16.5" y2="12" />
    <line x1="7.5" y1="18" x2="16.5" y2="12" />
  </>,
  'Flow',
)

/**
 * Topology-with-region icon — used by the "arrange by flow inside regions"
 * button. A dotted container box wrapping the same three-node flow to evoke
 * "preserve existing regions while you tidy the inside".
 */
export const IconFlowRegion = makeIcon(
  <>
    <rect x="2.5" y="3.5" width="19" height="17" rx="2" stroke-dasharray="3 2" />
    <circle cx="8" cy="8" r="1.8" />
    <circle cx="16" cy="12" r="1.8" />
    <circle cx="8" cy="16" r="1.8" />
    <line x1="9.5" y1="8" x2="14.5" y2="12" />
    <line x1="9.5" y1="16" x2="14.5" y2="12" />
  </>,
  'Flow with region',
)

/**
 * AI-smart-arrange icon — used by the capsule's "smart layout" button.
 * Sparkles wrapping a grid evokes "AI divides the canvas into tidy groups".
 */
export const IconAiArrange = makeIcon(
  <>
    <path d="M12 3l1.6 3.4L17 8l-3.4 1.6L12 13l-1.6-3.4L7 8l3.4-1.6z" />
    <path d="M19 14l.9 1.9L21.8 17l-1.9.9L19 19.8l-.9-1.9L16.2 17l1.9-.9z" />
    <rect x="3" y="13" width="6" height="6" rx="1" />
    <rect x="11" y="13" width="6" height="6" rx="1" />
    <rect x="3" y="19" width="6" height="2" rx="1" />
    <rect x="11" y="19" width="6" height="2" rx="1" />
  </>,
  'Smart arrange',
)

export const IconUnlock = makeIcon(
  <>
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
    <path d="M7 11V7a5 5 0 0 1 9.9-1" />
  </>,
  'Unlock',
)

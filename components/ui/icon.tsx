// Self-contained icon set for the Specs plugin.
//
// Deliberately dependency-free: the plugin previously pulled icons from
// @hugeicons/core-free-icons, whose ESM entry imported modules with mismatched
// filename casing (Grid2x2CheckIcon.js vs Grid2X2CheckIcon.js). That resolves
// on case-insensitive filesystems and fails on Linux, which broke managed
// installs during frontend bundling. Keeping the icons here removes the
// dependency and the failure mode entirely.
import type { CSSProperties, ReactNode } from "react";

export type IconName = string;

export interface IconProps {
  name: IconName;
  fallback?: IconName;
  className?: string;
  style?: CSSProperties;
  "aria-hidden"?: boolean | "true" | "false";
  "aria-label"?: string;
}

const ICONS: Record<string, ReactNode> = {
  Archive: (
    <>
      <rect x="3.5" y="4.5" width="17" height="4" rx="1.2" />
      <path d="M5.2 8.5V19a1.5 1.5 0 0 0 1.5 1.5h10.6A1.5 1.5 0 0 0 18.8 19V8.5" />
      <path d="M10 12h4" />
    </>
  ),
  Beaker: (
    <>
      <path d="M9 3.5h6" />
      <path d="M10 3.5v5.2L4.9 18a2 2 0 0 0 1.7 3h10.8a2 2 0 0 0 1.7-3L14 8.7V3.5" />
      <path d="M7.2 14.5h9.6" />
    </>
  ),
  Check: <path d="M4.5 12.5 9.5 17.5 19.5 7" />,
  ChevronDown: <path d="m6 9.5 6 6 6-6" />,
  ChevronRight: <path d="m9.5 6 6 6-6 6" />,
  CircleCheck: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8.5 12.2 2.5 2.5 4.8-5" />
    </>
  ),
  Copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5.5 14.5V6a2 2 0 0 1 2-2H15" />
    </>
  ),
  Edit: (
    <>
      <path d="M4.5 19.5 5.4 15 16.6 3.9a2.05 2.05 0 0 1 2.9 2.9L8.3 18l-3.8 1.5Z" />
      <path d="m14.7 5.8 3.5 3.5" />
    </>
  ),
  FileText: (
    <>
      <path d="M6.5 3h7L19 8.5V19a2 2 0 0 1-2 2H6.5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" />
      <path d="M13 3v6h6" />
      <path d="M8 13h8M8 16.5h5" />
    </>
  ),
  Folder: (
    <path d="M3.5 6.5a2 2 0 0 1 2-2h3.6l2 2.5h7.4a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V6.5Z" />
  ),
  Loading: <path d="M12 3a9 9 0 1 0 8.6 6.3" />,
  MessageCirclePlus: (
    <>
      <path d="M20.5 11.5a8.5 8.5 0 0 1-8.5 8.5H8l-4.5 3v-4.2A8.5 8.5 0 1 1 20.5 11.5Z" />
      <path d="M12 8.5v6M9 11.5h6" />
    </>
  ),
  MessageQuestion: (
    <>
      <path d="M20.5 11.5a8.5 8.5 0 0 1-8.5 8.5H8l-4.5 3v-4.2A8.5 8.5 0 1 1 20.5 11.5Z" />
      <path d="M9.8 9.6a2.3 2.3 0 1 1 3.3 2.1c-.75.4-1.1.85-1.1 1.7v.25" />
      <path d="M12 16.3v.05" />
    </>
  ),
  MessageSquare: (
    <path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-5 4V6Z" />
  ),
  NewTab: (
    <>
      <path d="M14 4h6v6" />
      <path d="M20 4l-8.5 8.5" />
      <path d="M18 13.5V19a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 19V8a1.5 1.5 0 0 1 1.5-1.5H10" />
    </>
  ),
  Plus: <path d="M12 5v14M5 12h14" />,
  Search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </>
  ),
  Target: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3.4" />
    </>
  ),
  Trash2: (
    <>
      <path d="M4.5 7h15" />
      <path d="M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7" />
      <path d="m6.8 7 1 11.8A2 2 0 0 0 9.8 20.5h4.4a2 2 0 0 0 2-1.7l1-11.8" />
      <path d="M10.3 11v5.8M13.7 11v5.8" />
    </>
  ),
  X: <path d="M6 6l12 12M18 6 6 18" />,
  Zap: <path d="M13 2.5 4.8 13h6L10.6 21.5 19 11h-6l0-8.5Z" />,
};

const ICON_NAMES = Object.keys(ICONS);

export function Icon({ name, fallback = "Zap", className, style, ...aria }: IconProps) {
  const content = ICONS[name] ?? ICONS[fallback] ?? ICONS.Zap;
  const label = aria["aria-label"];
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      role={label === undefined ? undefined : "img"}
      aria-label={label}
      aria-hidden={
        label === undefined ? (aria["aria-hidden"] ?? true) : aria["aria-hidden"]
      }
    >
      {content}
    </svg>
  );
}

export function isBuiltinIconName(name: string): boolean {
  return name in ICONS;
}

export function iconNames(): readonly string[] {
  return ICON_NAMES;
}

export function preloadExtendedIcons(): Promise<void> {
  return Promise.resolve();
}

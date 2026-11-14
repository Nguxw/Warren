import type { ReactNode, SVGProps } from "react";

/** A small set of line icons, drawn on a 24-unit grid and coloured by `currentColor`. */

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...props }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export function Plus(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  );
}
export function Search(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.2-4.2" />,
    </Svg>
  );
}
export function Eye(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.8" />,
    </Svg>
  );
}
export function Pencil(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z" />
      <path d="m13.5 6.5 4 4" />,
    </Svg>
  );
}
export function Terminal(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
      <path d="m7.5 10 3 2.5-3 2.5M13 15h4" />,
    </Svg>
  );
}
export function Upload(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 15V4M7.5 8.5 12 4l4.5 4.5" />
      <path d="M4.5 15v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3" />,
    </Svg>
  );
}
export function Sparkle(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3.5 13.8 9 19.5 10.8 13.8 12.7 12 18.5 10.2 12.7 4.5 10.8 10.2 9Z" />,
    </Svg>
  );
}
export function Check(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </Svg>
  );
}
export function Close(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Svg>
  );
}
export function Alert(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 4 2.8 19.5h18.4Z" />
      <path d="M12 10v4M12 17.2v.1" />,
    </Svg>
  );
}
export function Pause(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9 5.5v13M15 5.5v13" />
    </Svg>
  );
}
export function Play(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M7.5 5.2v13.6L18.5 12Z" />
    </Svg>
  );
}
export function Stop(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </Svg>
  );
}
export function History(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.5 12a8.5 8.5 0 1 0 2.5-6" />
      <path d="M3.5 4.5V9H8M12 8v4.5l3 2" />,
    </Svg>
  );
}
export function Branch(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="6.5" cy="5.5" r="2" />
      <circle cx="6.5" cy="18.5" r="2" />
      <circle cx="17.5" cy="7.5" r="2" />
      <path d="M6.5 7.5v9M17.5 9.5c0 4-11 3-11 7" />,
    </Svg>
  );
}
export function PullRequest(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="6.5" cy="5.5" r="2" />
      <circle cx="6.5" cy="18.5" r="2" />
      <circle cx="17.5" cy="18.5" r="2" />
      <path d="M6.5 7.5v9M17.5 16.5V9a2.5 2.5 0 0 0-2.5-2.5h-4M12.5 4.5l-2 2 2 2" />,
    </Svg>
  );
}
export function ChevronRight(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m9.5 6 6 6-6 6" />
    </Svg>
  );
}
export function ArrowUp(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 19V5M6 11l6-6 6 6" />
    </Svg>
  );
}
export function Folder(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.5 7.5a2 2 0 0 1 2-2H10l2 2.5h6.5a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z" />
      ,
    </Svg>
  );
}
export function Gear(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </Svg>
  );
}
export function Key(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="15" r="4" />
      <path d="m10.8 12.2 8.7-8.7M16.5 6.5l2.5 2.5M14 9l2 2" />
    </Svg>
  );
}
export function Copy(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
      <path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" />
    </Svg>
  );
}
export function Reveal(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M13.5 4.5h6v6M19.5 4.5 11 13" />
      <path d="M18 14v3.5a2 2 0 0 1-2 2H6.5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2H10" />
    </Svg>
  );
}
export function Trash(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.5 7h15M9.5 7V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v2M6.5 7l.8 11.2a2 2 0 0 0 2 1.8h5.4a2 2 0 0 0 2-1.8L17.5 7M10 11v5M14 11v5" />
    </Svg>
  );
}
export function Download(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 4.5v10M7.5 10.5 12 15l4.5-4.5M5 19.5h14" />
    </Svg>
  );
}
export function Package(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3.5 19.5 7.5v9L12 20.5 4.5 16.5v-9Z" />
      <path d="M4.5 7.5 12 11.5l7.5-4M12 11.5v9" />
    </Svg>
  );
}
export function Globe(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.5 2.6 3.5 5.4 3.5 8.5s-1 5.9-3.5 8.5c-2.5-2.6-3.5-5.4-3.5-8.5s1-5.9 3.5-8.5Z" />
      ,
    </Svg>
  );
}
export function Offline(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m6 6 12 12" />,
    </Svg>
  );
}
export function Cpu(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="6.5" y="6.5" width="11" height="11" rx="2" />
      <path d="M9.5 3v3.5M14.5 3v3.5M9.5 17.5V21M14.5 17.5V21M3 9.5h3.5M3 14.5h3.5M17.5 9.5H21M17.5 14.5H21" />
      ,
    </Svg>
  );
}
export function Clock(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />,
    </Svg>
  );
}
export function Coin(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M14.5 9.2c-.5-.8-1.4-1.2-2.5-1.2-1.5 0-2.5.8-2.5 2s1 1.6 2.5 2 2.5.8 2.5 2-1 2-2.5 2c-1.2 0-2.1-.5-2.6-1.3M12 6.5V8M12 16v1.5" />
      ,
    </Svg>
  );
}
export function Message(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 18.5 3.5 21V6.5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2Z" />,
    </Svg>
  );
}
export function Shield(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3.5 5 6v5.5c0 4.3 3 7.6 7 9 4-1.4 7-4.7 7-9V6Z" />
    </Svg>
  );
}
export function FileIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5Z" />
      <path d="M14 3.5v5h5" />,
    </Svg>
  );
}

export function Inbox(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.5 13.5h5l1.5 2.5h4l1.5-2.5h5" />
      <path d="M5.5 5.5h13l2 8v4a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-4Z" />
    </Svg>
  );
}

/** Warren's mark: the burrow's arches, as in the app icon. */
export function Logo({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="6">
        <path d="M7 47 A25 25 0 0 1 57 47" />
        <path d="M18 47 A14 14 0 0 1 46 47" />
      </g>
      <path d="M27.5 47 A4.5 4.5 0 0 1 36.5 47 Z" fill="currentColor" />
    </svg>
  );
}

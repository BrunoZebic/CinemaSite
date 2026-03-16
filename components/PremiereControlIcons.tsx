import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function BaseIcon({ children, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      {children}
    </svg>
  );
}

export function ChatBubbleIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path
        d="M6 7.75C6 6.23 7.23 5 8.75 5h6.5C16.77 5 18 6.23 18 7.75v4.5c0 1.52-1.23 2.75-2.75 2.75H11.3L8.2 18.1c-.7.7-1.9.2-1.9-.8V15C5.56 14.67 5 14 5 13.2V7.75Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path
        d="M8.8 9.75h6.4M8.8 12.25h4.2"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </BaseIcon>
  );
}

export function FullscreenEnterIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path
        d="M8 4.75H5.75v2.5M16 4.75h2.25v2.5M8 19.25H5.75v-2.5M16 19.25h2.25v-2.5"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M9.5 6.25 5.75 10M14.5 6.25 18.25 10M9.5 17.75 5.75 14M14.5 17.75 18.25 14"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </BaseIcon>
  );
}

export function FullscreenExitIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path
        d="M8.25 9.75H5.75V7.25M15.75 9.75h2.5v-2.5M8.25 14.25H5.75v2.5M15.75 14.25h2.5v2.5"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M10 8.1 5.75 7.25M14 8.1l4.25-.85M10 15.9l-4.25.85M14 15.9l4.25.85"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </BaseIcon>
  );
}

export function ClosedCaptionsIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <rect
        x="3.5"
        y="5.5"
        width="17"
        height="13"
        rx="3"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <text
        x="7.1"
        y="14.7"
        fill="currentColor"
        fontFamily="Arial, sans-serif"
        fontSize="5.6"
        fontWeight="700"
      >
        CC
      </text>
    </BaseIcon>
  );
}

export function VolumeMutedIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path
        d="M11.5 6 8.3 9H5.75v6h2.55l3.2 3V6Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path
        d="m15.25 9.25 4 5.5M19.25 9.25l-4 5.5"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </BaseIcon>
  );
}

export function VolumeOnIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path
        d="M11.5 6 8.3 9H5.75v6h2.55l3.2 3V6Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path
        d="M15 10.1a3.9 3.9 0 0 1 0 3.8M17.75 8a7 7 0 0 1 0 8"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </BaseIcon>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path
        d="m7 7 10 10M17 7 7 17"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </BaseIcon>
  );
}

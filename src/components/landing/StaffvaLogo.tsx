/**
 * The brand lockup: lowercase "staffva" in the display face with the lime
 * asterisk mark raised after it. The mark here is ALWAYS faceless — Asti
 * (the mark with a face) is the game layer and never appears in the lockup.
 */
export function AsteriskMark({ size = 18, color = "#D6F24D" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 120 120" fill="none" aria-hidden>
      <g fill={color}>
        <rect x="52" y="8" width="16" height="104" rx="8" />
        <rect x="52" y="8" width="16" height="104" rx="8" transform="rotate(60 60 60)" />
        <rect x="52" y="8" width="16" height="104" rx="8" transform="rotate(120 60 60)" />
      </g>
    </svg>
  );
}

export default function StaffvaLogo({ markSize = 15 }: { markSize?: number }) {
  return (
    <>
      <span className="logo-word">staffva</span>
      <span className="logo-asterisk" aria-hidden>
        <AsteriskMark size={markSize} />
      </span>
    </>
  );
}

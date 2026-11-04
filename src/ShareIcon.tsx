// Plateau et flèche du partage, dans les teintes cuivrées de la gemme
export function ShareIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <defs>
        <linearGradient id="share-body" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f5b468" />
          <stop offset="1" stopColor="#b65f2a" />
        </linearGradient>
      </defs>
      <rect
        x="6.5"
        y="16.5"
        width="27"
        height="18"
        rx="5"
        fill="url(#share-body)"
        stroke="#2b1306"
        strokeOpacity="0.35"
      />
      <path
        d="M20 4.5 L27.5 12.5 H22.6 V25.5 a2.6 2.6 0 0 1 -5.2 0 V12.5 H12.5 Z"
        fill="#ffe6c2"
        stroke="#2b1306"
        strokeOpacity="0.35"
        strokeLinejoin="round"
      />
    </svg>
  );
}

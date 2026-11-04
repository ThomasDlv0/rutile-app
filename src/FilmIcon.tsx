// Pellicule du mode Vidéo, dans les teintes cuivrées de la gemme
const SPROCKETS = [9, 15.5, 22, 28.5];

export function FilmIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <defs>
        <linearGradient id="film-body" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f5b468" />
          <stop offset="1" stopColor="#b65f2a" />
        </linearGradient>
      </defs>
      <rect
        x="3.5"
        y="7.5"
        width="33"
        height="25"
        rx="5"
        fill="url(#film-body)"
        stroke="#2b1306"
        strokeOpacity="0.35"
      />
      {SPROCKETS.map((x) => (
        <g key={x} fill="#2b1306" fillOpacity="0.45">
          <rect x={x} y="10" width="3" height="2.6" rx="0.8" />
          <rect x={x} y="27.4" width="3" height="2.6" rx="0.8" />
        </g>
      ))}
      <path d="M17 15.2 L25.5 20 L17 24.8 Z" fill="#ffe6c2" />
    </svg>
  );
}

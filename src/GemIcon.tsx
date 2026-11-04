// Gemme de l'icône de l'app (même géométrie que app-icon.svg, sans le fond)
export function GemIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="222 222 580 580" aria-hidden="true">
      <defs>
        <linearGradient id="gem-table" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffe6c2" />
          <stop offset="1" stopColor="#f2ab5f" />
        </linearGradient>
      </defs>
      <g stroke="#2b1306" strokeOpacity="0.35" strokeWidth="5" strokeLinejoin="round">
        <polygon points="512,232 754.5,372 615.9,452 512,392" fill="#f5b468" />
        <polygon points="754.5,372 754.5,652 615.9,572 615.9,452" fill="#d27a35" />
        <polygon points="754.5,652 512,792 512,632 615.9,572" fill="#8f4320" />
        <polygon points="512,792 269.5,652 408.1,572 512,632" fill="#b65f2a" />
        <polygon points="269.5,652 269.5,372 408.1,452 408.1,572" fill="#e99a52" />
        <polygon points="269.5,372 512,232 512,392 408.1,452" fill="#ffd7a1" />
        <polygon
          points="512,392 615.9,452 615.9,572 512,632 408.1,572 408.1,452"
          fill="url(#gem-table)"
        />
      </g>
    </svg>
  );
}

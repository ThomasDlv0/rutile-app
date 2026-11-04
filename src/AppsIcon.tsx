// Grille d'apps de la roue des apps, dans les teintes cuivrées de la gemme
const TILES = [
  { x: 6, y: 6, fill: "#ffd7a1" },
  { x: 21, y: 6, fill: "#f5b468" },
  { x: 6, y: 21, fill: "#e99a52" },
  { x: 21, y: 21, fill: "#b65f2a" },
];

export function AppsIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      {TILES.map((tile) => (
        <rect
          key={`${tile.x}-${tile.y}`}
          x={tile.x}
          y={tile.y}
          width="13"
          height="13"
          rx="3.5"
          fill={tile.fill}
          stroke="#2b1306"
          strokeOpacity="0.35"
        />
      ))}
    </svg>
  );
}

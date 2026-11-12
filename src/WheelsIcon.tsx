// Roue en quartiers d'une roue personnalisée, dans les teintes cuivrées de la gemme
const QUARTERS = ["#ffd7a1", "#f5b468", "#e99a52", "#b65f2a"];
const CENTER = 20;
const OUTER = 15.5;
const INNER = 6.5;
/** Jour entre deux quartiers, en degrés. */
const GAP = 9;

function point(radius: number, degrees: number): string {
  const radians = ((degrees - 90) * Math.PI) / 180;
  return `${(CENTER + radius * Math.cos(radians)).toFixed(2)} ${(CENTER + radius * Math.sin(radians)).toFixed(2)}`;
}

export function WheelsIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      {QUARTERS.map((fill, index) => {
        const start = index * 90 + GAP / 2;
        const end = (index + 1) * 90 - GAP / 2;
        return (
          <path
            key={fill}
            d={`M ${point(OUTER, start)} A ${OUTER} ${OUTER} 0 0 1 ${point(OUTER, end)} L ${point(INNER, end)} A ${INNER} ${INNER} 0 0 0 ${point(INNER, start)} Z`}
            fill={fill}
            stroke="#2b1306"
            strokeOpacity="0.35"
            strokeLinejoin="round"
          />
        );
      })}
      <circle cx={CENTER} cy={CENTER} r="2.6" fill="#ffd7a1" stroke="#2b1306" strokeOpacity="0.35" />
    </svg>
  );
}

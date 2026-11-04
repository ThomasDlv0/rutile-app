// Dimensions en pixels CSS, la fenêtre fait WINDOW_SIZE × WINDOW_SIZE
export const WINDOW_SIZE = 360;
export const CENTER = WINDOW_SIZE / 2;
export const DISK_RADIUS = 165;
export const HUB_RADIUS = 48;
export const BUTTON_RADIUS = 29;
export const BUTTON_ORBIT = 123;
export const SEPARATOR_START = 52;
export const SEPARATOR_END = 157;

export const SECTOR_COUNT = 6;
const SECTOR_ANGLE = 360 / SECTOR_COUNT;

/** Point à `radius` du centre ; l'angle est en degrés, 0 en haut, sens horaire. */
export function polar(radius: number, degrees: number): [number, number] {
  const radians = ((degrees - 90) * Math.PI) / 180;
  return [CENTER + radius * Math.cos(radians), CENTER + radius * Math.sin(radians)];
}

/** Part située sous un point de la fenêtre, ou `null` dans le cercle central et hors du disque. */
export function sectorAt(x: number, y: number): number | null {
  const dx = x - CENTER;
  const dy = y - CENTER;
  const distance = Math.hypot(dx, dy);
  if (distance < HUB_RADIUS || distance > DISK_RADIUS) return null;
  const degrees = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
  return Math.round(degrees / SECTOR_ANGLE) % SECTOR_COUNT;
}

export function isInsideDisk(x: number, y: number): boolean {
  return Math.hypot(x - CENTER, y - CENTER) <= DISK_RADIUS;
}

export function isInsideHub(x: number, y: number): boolean {
  return Math.hypot(x - CENTER, y - CENTER) < HUB_RADIUS;
}

/** Position du centre du bouton de la part `index`. */
export function buttonCenter(index: number): [number, number] {
  return polar(BUTTON_ORBIT, index * SECTOR_ANGLE);
}

/** Angle des lignes de séparation, entre les parts. */
export function separatorAngles(): number[] {
  return Array.from({ length: SECTOR_COUNT }, (_, i) => i * SECTOR_ANGLE + SECTOR_ANGLE / 2);
}

/** Tracé SVG de la part `index`, en couronne autour du cercle central. */
export function sectorPath(index: number): string {
  const start = index * SECTOR_ANGLE - SECTOR_ANGLE / 2;
  const end = start + SECTOR_ANGLE;
  const outer = DISK_RADIUS - 1;
  const inner = HUB_RADIUS + 4;
  const [x1, y1] = polar(outer, start);
  const [x2, y2] = polar(outer, end);
  const [x3, y3] = polar(inner, end);
  const [x4, y4] = polar(inner, start);
  return [
    `M ${x1} ${y1}`,
    `A ${outer} ${outer} 0 0 1 ${x2} ${y2}`,
    `L ${x3} ${y3}`,
    `A ${inner} ${inner} 0 0 0 ${x4} ${y4}`,
    "Z",
  ].join(" ");
}

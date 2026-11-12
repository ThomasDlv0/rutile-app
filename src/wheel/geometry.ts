// Dimensions en pixels CSS, la fenêtre fait WINDOW_SIZE × WINDOW_SIZE
export const WINDOW_SIZE = 360;
export const CENTER = WINDOW_SIZE / 2;
export const DISK_RADIUS = 165;
export const HUB_RADIUS = 48;
export const BUTTON_RADIUS = 29;
export const BUTTON_ORBIT = 123;
export const SEPARATOR_START = 52;
export const SEPARATOR_END = 157;

/** Parts d'une roue de formats ; celles des apps et du partage en ont de 6 à MAX_SECTORS. */
export const SECTOR_COUNT = 6;
export const MAX_SECTORS = 10;

const sectorAngle = (count: number) => 360 / count;

/** Point à `radius` du centre ; l'angle est en degrés, 0 en haut, sens horaire. */
export function polar(radius: number, degrees: number): [number, number] {
  const radians = ((degrees - 90) * Math.PI) / 180;
  return [CENTER + radius * Math.cos(radians), CENTER + radius * Math.sin(radians)];
}

/** Part située sous un point de la fenêtre, ou `null` dans le cercle central et hors du disque. */
export function sectorAt(x: number, y: number, count = SECTOR_COUNT): number | null {
  const dx = x - CENTER;
  const dy = y - CENTER;
  const distance = Math.hypot(dx, dy);
  if (distance < HUB_RADIUS || distance > DISK_RADIUS) return null;
  const degrees = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
  return Math.round(degrees / sectorAngle(count)) % count;
}

export function isInsideDisk(x: number, y: number): boolean {
  return Math.hypot(x - CENTER, y - CENTER) <= DISK_RADIUS;
}

export function isInsideHub(x: number, y: number): boolean {
  return Math.hypot(x - CENTER, y - CENTER) < HUB_RADIUS;
}

/** Angle du milieu de la part `index`, en degrés depuis le haut. */
export function sectorCenterAngle(index: number, count = SECTOR_COUNT): number {
  return index * sectorAngle(count);
}

/** Position du centre du bouton de la part `index`. */
export function buttonCenter(index: number, count = SECTOR_COUNT): [number, number] {
  return polar(BUTTON_ORBIT, sectorCenterAngle(index, count));
}

/** Angle des lignes de séparation, entre les parts. */
export function separatorAngles(count = SECTOR_COUNT): number[] {
  // Une seule part : rien à séparer
  if (count < 2) return [];
  const angle = sectorAngle(count);
  return Array.from({ length: count }, (_, i) => i * angle + angle / 2);
}

/** Tracé SVG de la part `index`, en couronne autour du cercle central. */
export function sectorPath(index: number, count = SECTOR_COUNT): string {
  const outer = DISK_RADIUS - 1;
  const inner = HUB_RADIUS + 4;
  // Une seule part (une roue personnalisée qui commence) : la couronne entière, qu'un arc de
  // 360° ne sait pas tracer. Deux demi-cercles dehors, deux dedans en sens inverse pour le trou
  if (count < 2) {
    const ring = (radius: number, sweep: 0 | 1) => {
      const [x1, y1] = polar(radius, 0);
      const [x2, y2] = polar(radius, 180);
      const arc = `A ${radius} ${radius} 0 1 ${sweep}`;
      return `M ${x1} ${y1} ${arc} ${x2} ${y2} ${arc} ${x1} ${y1} Z`;
    };
    return `${ring(outer, 1)} ${ring(inner, 0)}`;
  }
  const start = index * sectorAngle(count) - sectorAngle(count) / 2;
  const end = start + sectorAngle(count);
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

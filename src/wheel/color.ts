/** Couleurs choisies dans les réglages : lisibilité du texte et halo de la surbrillance. */

/** Bleu de la part survolée, tant qu'aucune autre couleur n'est choisie (styles.css). */
export const DEFAULT_ACCENT = "#2f7cf6";
export const LIGHT_INK = "#ffffff";
export const DARK_INK = "#1d1d1f";
/** Le texte reste blanc tant qu'il contraste assez : c'est du gras, sur une petite pastille. */
const MIN_WHITE_CONTRAST = 2.3;

export function isHexColor(value: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(value);
}

function channels(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/** Luminance relative, au sens des WCAG. */
export function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/** Texte blanc sur une couleur soutenue, foncé sur une couleur claire. */
export function readableInk(background: string): string {
  return contrast(LIGHT_INK, background) >= MIN_WHITE_CONTRAST ? LIGHT_INK : DARK_INK;
}

/** Halo de la surbrillance : la même couleur, à demi transparente. */
export function glow(hex: string, alpha = 0.55): string {
  const [r, g, b] = channels(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

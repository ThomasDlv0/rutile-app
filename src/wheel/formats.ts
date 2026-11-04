// Ordre des parts, dans le sens horaire en partant du haut
export const OUTPUT_FORMATS = [
  { id: "png", label: "PNG" },
  { id: "jpeg", label: "JPEG" },
  { id: "webp", label: "WebP" },
  { id: "avif", label: "AVIF" },
  { id: "svg", label: "SVG" },
  { id: "ico", label: "ICO" },
] as const;

export type OutputFormat = (typeof OUTPUT_FORMATS)[number]["id"];

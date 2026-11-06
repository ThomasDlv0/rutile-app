// Pictogrammes des parts de la roue Actions, tracés au trait pour se lire sur les pastilles
const PATHS = {
  capture: "M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2M9 12a3 3 0 1 0 6 0 3 3 0 0 0-6 0",
  zone: "M4 4h4M12 4h4M20 4v4M20 12v4M20 20h-4M12 20H8M4 20v-4M4 12V8",
  window: "M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2ZM3 9h18",
  screen: "M3 5a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1ZM9 21h6M12 17v4",
  timer: "M12 13V9M10 2h4M12 22a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z",
  text: "M4 7V5h16v2M12 5v14M9 19h6",
  color: "m14 6 4 4M11 9l4 4-8 8H3v-4l8-8ZM13 7l3-3a2.1 2.1 0 0 1 3 0l1 1a2.1 2.1 0 0 1 0 3l-3 3",
  files: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z",
  zip: "M6 3h9l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM11 3v2M11 8v2M11 13v2M10 17a1 1 0 0 0 2 0v-2h-2Z",
  pdf: "M6 3h9l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM14 3v5h5M8 13h8M8 17h5",
  merge: "M7 4h7l3 3v7a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1ZM18 9h1a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-1",
  rename: "M4 20h4L19 9a2 2 0 0 0-3-3L5 17ZM14 8l3 3M13 20h7",
  number: "M9 4 7 20M17 4l-2 16M4 9h17M3 15h17",
  date: "M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2ZM4 10h16M8 3v4M16 3v4",
  lower: "M4 18c0-4 1-6 3-6s3 2 3 6M10 15H4M14 12v6M14 15a3 3 0 1 0 6 0 3 3 0 0 0-6 0",
  clean: "M12 3 13.8 8.2 19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8ZM19 16v4M17 18h4",
  image: "M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2ZM3 16l5-5 5 5M13 14l2-2 6 6M15 9h.01",
  half: "M5 9V5h4M15 19h4v-4M4 4l7 7M20 20l-7-7",
  full: "M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4",
  compress: "M8 3v4a1 1 0 0 1-1 1H3M21 8h-4a1 1 0 0 1-1-1V3M3 16h4a1 1 0 0 1 1 1v4M16 21v-4a1 1 0 0 1 1-1h4",
  shield: "M12 3 5 6v5c0 5 3 8 7 10 4-2 7-5 7-10V6ZM9 12l2 2 4-4",
  video: "M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2ZM10 9v6l5-3Z",
  gif: "M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2ZM8 3v4M16 3v4M8 17v4M16 17v4",
  music: "M9 18V6l11-2v12M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
  mute: "M11 5 6 9H3v6h3l5 4ZM22 9l-6 6M16 9l6 6",
  left: "M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2ZM12 4v16M5 7h4v10H5Z",
  right: "M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2ZM12 4v16M15 7h4v10h-4Z",
  top: "M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2ZM3 12h18M6 7h12v2H6Z",
  bottom: "M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2ZM3 12h18M6 15h12v2H6Z",
  center: "M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2ZM8 9h8v6H8Z",
  grid: "M4 4h6v6H4ZM14 4h6v6h-6ZM4 14h6v6H4ZM14 14h6v6h-6Z",
  star: "m12 3 2.7 5.6 6.1.8-4.4 4.3 1 6.1L12 17l-5.4 2.8 1-6.1-4.4-4.3 6.1-.8Z",
  wheels: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM12 3v6M12 15v6M3 12h6M15 12h6",
  play: "M7 4v16l13-8Z",
  plus: "M12 5v14M5 12h14",
} as const;

export type GlyphName = keyof typeof PATHS;

export function ActionGlyph({ name, size = 24 }: { name: GlyphName; size?: number }) {
  return (
    <svg
      className="item-glyph"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

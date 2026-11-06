// Éclair de la roue Actions, dans les teintes cuivrées de la gemme
export function ActionsIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <path
        d="M23.5 4.5 8.8 22.3a1.2 1.2 0 0 0 .9 2H18l-2.4 11 14.6-18a1.2 1.2 0 0 0-.9-2H21l2.5-10.8Z"
        fill="#f5b468"
        stroke="#2b1306"
        strokeOpacity="0.35"
        strokeLinejoin="round"
      />
      <path d="M23.5 4.5 21 15.3l-5.5 20L8.8 22.3 23.5 4.5Z" fill="#ffd7a1" opacity="0.65" />
    </svg>
  );
}

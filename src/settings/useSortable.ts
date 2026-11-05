import {
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

/** Liste où l'élément `from` a pris la place `to`. */
export function moved<T>(list: readonly T[], from: number, to: number): T[] {
  const copy = [...list];
  const [item] = copy.splice(from, 1);
  copy.splice(to, 0, item);
  return copy;
}

/** Place visée par une ligne décalée de `offset` : elle passe une voisine dès que son bord
 * en dépasse le milieu. `bounds` : haut et bas de chaque ligne avant le glisser. */
export function dropIndex(bounds: readonly Bounds[], from: number, offset: number): number {
  const top = bounds[from].top + offset;
  const bottom = bounds[from].bottom + offset;
  return bounds.filter((row, index) => {
    const middle = (row.top + row.bottom) / 2;
    if (index < from) return middle < top;
    return index > from && middle < bottom;
  }).length;
}

interface Bounds {
  top: number;
  bottom: number;
}

interface Drag {
  from: number;
  over: number;
  startY: number;
  offset: number;
  bounds: Bounds[];
}

export interface SortableRow {
  ref: (element: HTMLElement | null) => void;
  style?: CSSProperties;
  dragging: boolean;
}

/** Lignes qu'on réordonne en les glissant par leur poignée, ou avec les flèches du clavier
 * quand la poignée a le focus. `onMove` reçoit l'ancienne et la nouvelle place. */
export function useSortable(count: number, onMove: (from: number, to: number) => void) {
  const [drag, setDrag] = useState<Drag | null>(null);
  // Copie lue par les gestionnaires, qui ne doivent pas attendre le rendu suivant
  const dragRef = useRef<Drag | null>(null);
  const rows = useRef<(HTMLElement | null)[]>([]);
  const handles = useRef<(HTMLButtonElement | null)[]>([]);

  const update = (next: Drag | null) => {
    dragRef.current = next;
    setDrag(next);
  };

  const finish = (commit: boolean) => {
    const current = dragRef.current;
    update(null);
    if (commit && current && current.over !== current.from) onMove(current.from, current.over);
  };

  const row = (index: number): SortableRow => {
    let transform: string | undefined;
    if (drag) {
      const { from, over, offset, bounds } = drag;
      const height = bounds[from].bottom - bounds[from].top;
      if (index === from) transform = `translateY(${offset}px)`;
      // Les lignes entre l'ancienne et la nouvelle place s'écartent pour lui laisser la place
      else if (from < index && index <= over) transform = `translateY(${-height}px)`;
      else if (over <= index && index < from) transform = `translateY(${height}px)`;
    }
    return {
      ref: (element) => {
        rows.current[index] = element;
      },
      style: transform ? { transform } : undefined,
      dragging: drag?.from === index,
    };
  };

  const handle = (index: number) => ({
    ref: (element: HTMLButtonElement | null) => {
      handles.current[index] = element;
    },
    onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0 || count < 2) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      const bounds = Array.from({ length: count }, (_, i) => {
        const rect = rows.current[i]?.getBoundingClientRect();
        return { top: rect?.top ?? 0, bottom: rect?.bottom ?? 0 };
      });
      update({ from: index, over: index, startY: event.clientY, offset: 0, bounds });
    },
    onPointerMove: (event: PointerEvent<HTMLButtonElement>) => {
      const current = dragRef.current;
      if (!current) return;
      // Pas au-delà de la première et de la dernière ligne
      const { from, bounds } = current;
      const min = bounds[0].top - bounds[from].top;
      const max = bounds[count - 1].bottom - bounds[from].bottom;
      const offset = Math.min(Math.max(event.clientY - current.startY, min), max);
      update({ ...current, offset, over: dropIndex(bounds, from, offset) });
    },
    onPointerUp: () => finish(true),
    onPointerCancel: () => finish(false),
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
      const to = event.key === "ArrowUp" ? index - 1 : event.key === "ArrowDown" ? index + 1 : null;
      if (to === null || to < 0 || to >= count) return;
      event.preventDefault();
      onMove(index, to);
      // La poignée suit sa ligne à sa nouvelle place
      requestAnimationFrame(() => handles.current[to]?.focus());
    },
  });

  return { row, handle, sorting: drag !== null };
}

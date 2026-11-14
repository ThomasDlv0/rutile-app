import { useId } from "react";
import appIcon from "../app-icon.svg?raw";

/** Dessin de l'icône de l'app, sans sa balise <svg> : la marque le reprend tel quel. */
const DRAWING = appIcon.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");

/** Marque de Rutile : l'icône de l'app (app-icon.svg), recadrée sur sa tuile. Ses
 * identifiants (dégradés, masques, filtres) sont propres à chaque instance, pour que deux
 * marques sur une même page ne se mélangent pas. */
export function GemIcon({ size }: { size: number }) {
  const prefix = `gem${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const drawing = DRAWING.replace(/id="c-/g, `id="${prefix}-`).replace(
    /url\(#c-/g,
    `url(#${prefix}-`,
  );
  return (
    <svg
      width={size}
      height={size}
      viewBox="100 100 824 824"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: drawing }}
    />
  );
}

/** Raccourcit un nom de fichier par le milieu pour garder l'extension visible. */
export function shortenMiddle(name: string, maxLength: number): string {
  if (name.length <= maxLength) return name;
  const keep = maxLength - 1;
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return `${name.slice(0, head)}…${name.slice(name.length - tail)}`;
}

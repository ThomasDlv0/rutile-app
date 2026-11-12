/** Adresse web complète, `https://` ajouté au besoin ; `null` si ce n'en est pas une. */
export function webAddress(text: string): string | null {
  const value = text.trim();
  if (value === "" || /\s/.test(value)) return null;
  const address = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(address);
    return url.hostname.includes(".") ? url.href : null;
  } catch {
    return null;
  }
}

/** Nom court d'un site, tiré de son adresse. */
export function siteName(address: string): string {
  return new URL(address).hostname.replace(/^www\./, "");
}

/** `.PDF, docx; txt` → `["pdf", "docx", "txt"]`. */
export function parseExtensions(text: string): string[] {
  const extensions = text
    .split(/[\s,;]+/)
    .map((extension) => extension.replace(/^\.+/, "").toLowerCase())
    .filter((extension) => /^[\p{L}\p{N}]{1,10}$/u.test(extension));
  return [...new Set(extensions)];
}

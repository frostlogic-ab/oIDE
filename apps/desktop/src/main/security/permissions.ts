/**
 * Clipboard writes for every frame; clipboard reads only for oIDE's own top-level page (the editor's
 * right-click Paste reads it through `navigator.clipboard`). Artifact previews, extension panels and
 * any other frame are refused, and so is every other permission.
 */
export function permissionAllowed(
  permission: string,
  details: { requestingUrl?: string; isMainFrame?: boolean } | undefined,
  isAppUrl: (url: string) => boolean,
): boolean {
  if (permission === 'clipboard-sanitized-write') return true;
  if (permission === 'clipboard-read') return !!details?.isMainFrame && !!details.requestingUrl && isAppUrl(details.requestingUrl);
  return false;
}

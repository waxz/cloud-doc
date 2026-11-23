import * as Y from 'yjs';

/**
 * Ids in an imported workspace are derived from the new workspace's id and the old id, so every step of
 * an import (which runs as its own request, with no memory of the others) computes the same new id.
 */
export async function deriveId(workspaceId: string, oldId: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${workspaceId}:${oldId}`)));
  d[6] = (d[6]! & 0x0f) | 0x40;
  d[8] = (d[8]! & 0x3f) | 0x80;
  const h = [...d.subarray(0, 16)].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export const FILE_URL_G = /\/api\/files\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//g;

/** Replaces every file id inside `/api/files/<id>/` links in `text` using `map` (ids not in the map are left alone). */
export function mapFileUrls(text: string, map: Map<string, string>): string {
  return text.replace(FILE_URL_G, (whole, id: string) => (map.has(id) ? `/api/files/${map.get(id)}/` : whole));
}

/** Every file id a piece of text links to. */
export const fileIdsInText = (text: string): string[] => [...new Set([...text.matchAll(FILE_URL_G)].map((m) => m[1]!))];

/**
 * Points an imported document at its new files and its own new page id: block attributes (image, video,
 * PDF and file urls, a PDF block's page), and link marks inside text. Edits the document in place.
 */
export function rewriteDocument(doc: Y.Doc, fragmentName: string, fileMap: Map<string, string>, oldPageId: string, newPageId: string): void {
  const walk = (node: Y.XmlFragment | Y.XmlElement): void => {
    if (node instanceof Y.XmlElement) {
      for (const [key, value] of Object.entries(node.getAttributes() as Record<string, unknown>)) {
        if (key === 'pageId' && value === oldPageId) node.setAttribute(key, newPageId);
        else if (typeof value === 'string') {
          const next = mapFileUrls(value, fileMap);
          if (next !== value) node.setAttribute(key, next);
        }
      }
    }
    for (const child of node.toArray()) {
      if (child instanceof Y.XmlElement) walk(child);
      else if (child instanceof Y.XmlText) {
        let pos = 0;
        for (const op of child.toDelta() as { insert: unknown; attributes?: Record<string, unknown> }[]) {
          const len = typeof op.insert === 'string' ? op.insert.length : 1;
          if (op.attributes) {
            const before = JSON.stringify(op.attributes);
            const after = mapFileUrls(before, fileMap);
            if (after !== before) child.format(pos, len, JSON.parse(after));
          }
          pos += len;
        }
      }
    }
  };
  walk(doc.getXmlFragment(fragmentName));
}

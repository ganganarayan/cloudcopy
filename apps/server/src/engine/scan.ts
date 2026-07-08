import type { CloudProvider } from '@cloudcopy/provider-sdk';

export interface ScannedFile {
  sourceNodeId: string;
  sourcePath: string;
  sizeBytes: number;
  /** Epoch ms of last modification, when the provider reports it. */
  modified?: number;
}

export interface SelectionEntry {
  nodeId: string;
  path: string;
  isFolder: boolean;
}

/**
 * Expand a source selection into a flat list of files, recursing folders.
 * Paths are relative to the selection root so the destination tree can mirror them.
 * (Folder re-creation at the destination is a later refinement; for now files land
 * in the chosen destination folder using their relative path as the name hint.)
 */
export async function scanSelection(
  provider: CloudProvider,
  selection: SelectionEntry[],
  recurse = true,
): Promise<ScannedFile[]> {
  const out: ScannedFile[] = [];

  async function walkFolder(folderId: string, prefix: string): Promise<void> {
    const [files, folders] = await Promise.all([
      provider.listFiles(folderId),
      provider.listFolders(folderId),
    ]);
    for (const f of files) {
      out.push({
        sourceNodeId: f.id,
        sourcePath: `${prefix}${f.name}`,
        sizeBytes: f.size,
        modified: f.modified?.getTime(),
      });
    }
    if (recurse) {
      for (const d of folders) {
        await walkFolder(d.id, `${prefix}${d.name}/`);
      }
    }
  }

  for (const entry of selection) {
    if (entry.isFolder) {
      const name = entry.path.split('/').filter(Boolean).pop() ?? entry.path;
      await walkFolder(entry.nodeId, `${name}/`);
    } else {
      const meta = await provider.getMetadata(entry.nodeId);
      out.push({ sourceNodeId: meta.id, sourcePath: meta.name, sizeBytes: meta.size, modified: meta.modified?.getTime() });
    }
  }
  return out;
}

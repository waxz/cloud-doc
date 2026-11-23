import { ActionIcon, Anchor, Button, FileButton, Group, Stack, Text, Tooltip } from '@mantine/core';
import { IconFile, IconFiles, IconFileTypePdf, IconMovie, IconMusic, IconPhoto, IconRowInsertBottom, IconTrash, IconUpload } from '@tabler/icons-react';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, atLeast, type FileInfo, type Role, type User } from './api';
import { blockTypeFor } from './blocks';
import type { Editor } from './Editor';
import { errorText, formatBytes, timeAgo } from './util';

interface Props {
  pageId: string;
  role: Role;
  me: User | null;
  editor: Editor | null;
  /** Bumped when the page's room reports a file change. */
  refreshKey: number;
  onError: (message: string) => void;
}

const ICON = { image: IconPhoto, video: IconMovie, audio: IconMusic, pdf: IconFileTypePdf, file: IconFile };

/** Adds a block showing the file at the end of the page. */
export function insertFile(editor: Editor, f: FileInfo, pageId: string, commentable = false): void {
  const last = editor.document[editor.document.length - 1];
  const block = { type: blockTypeFor(f.mime), props: { url: f.url, name: f.name, ...(blockTypeFor(f.mime) === 'pdf' ? { pageId, commentable } : {}) } } as const;
  if (last) editor.insertBlocks([block as any], last, 'after');
  else editor.replaceBlocks(editor.document, [block as any]);
}

/** Uploads files to a page and adds each to the document. */
export async function uploadInto(pageId: string, editor: Editor | null, files: File[], onError: (m: string) => void, commentable = false) {
  for (const file of files) {
    try {
      const f = await api.upload(pageId, file);
      if (editor) insertFile(editor, f, pageId, commentable);
    } catch (e) {
      onError(`${file.name}: ${errorText(e)}`);
    }
  }
}

/**
 * Deletes a file, asking first when pages still use it (the answer lists them). Resolves true when it was deleted.
 */
export async function deleteFileAsking(f: { id: string; name: string }, onError: (m: string) => void): Promise<boolean> {
  try {
    await api.deleteFile(f.id);
    return true;
  } catch (e) {
    if (e instanceof ApiError && e.status === 409 && Array.isArray(e.data.used_in)) {
      const used = e.data.used_in as { id: string; title: string }[];
      const where = used.slice(0, 5).map((p) => `• ${p.title || 'Untitled'}`).join('\n');
      if (!confirm(`“${f.name}” is used in ${used.length} page${used.length === 1 ? '' : 's'}:\n${where}\n\nDelete it anyway? Those pages will show a broken file.`)) return false;
      try {
        await api.deleteFile(f.id, true);
        return true;
      } catch (err) {
        onError(errorText(err));
        return false;
      }
    }
    onError(errorText(e));
    return false;
  }
}

/** The files this page uses: upload more, put one in the page, remove. All the workspace's files are in its Files list. */
export function FilesPanel({ pageId, role, me, editor, refreshKey, onError }: Props) {
  const [files, setFiles] = useState<FileInfo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const canEdit = atLeast(role, 'editor');
  const canComment = atLeast(role, 'commenter');

  const load = useCallback(() => api.files(pageId).then(setFiles, (e) => onError(errorText(e))), [pageId, onError]);
  useEffect(() => {
    load();
  }, [load, refreshKey]);

  return (
    <Stack gap="xs">
      {canEdit && (
        <FileButton
          multiple
          onChange={async (list) => {
            setBusy(true);
            await uploadInto(pageId, editor, list, onError, canComment);
            setBusy(false);
            load();
          }}
        >
          {(props) => (
            <Button {...props} size="xs" variant="light" leftSection={<IconUpload size={16} />} loading={busy}>
              Upload files
            </Button>
          )}
        </FileButton>
      )}
      <Button size="xs" variant="subtle" leftSection={<IconFiles size={16} />} onClick={() => window.dispatchEvent(new CustomEvent('cloud-doc-open-workspace-files'))}>
        All files of the workspace…
      </Button>
      {files?.length === 0 && (
        <Text size="sm" c="dimmed">
          No files in this page yet. {canEdit && 'Upload here, drop files into the page, or type / and pick Image, Video or PDF.'}
        </Text>
      )}
      {files?.map((f) => {
        const Icon = ICON[blockTypeFor(f.mime)];
        return (
          <Group key={f.id} gap="xs" wrap="nowrap" className="file-row">
            <Icon size={20} stroke={1.5} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <Anchor href={f.url} target="_blank" size="sm" truncate="end" display="block">
                {f.name}
              </Anchor>
              <Text size="xs" c="dimmed">
                {formatBytes(f.size)} · {timeAgo(f.created_at)}
              </Text>
            </div>
            {canEdit && editor && (
              <Tooltip label="Add to the page">
                <ActionIcon variant="subtle" color="gray" onClick={() => insertFile(editor, f, pageId, canComment)} aria-label={`Add ${f.name} to the page`}>
                  <IconRowInsertBottom size={16} />
                </ActionIcon>
              </Tooltip>
            )}
            {canEdit && (f.owner_id === me?.id || atLeast(role, 'admin')) && (
              <Tooltip label="Delete file">
                <ActionIcon
                  variant="subtle"
                  color="red"
                  aria-label={`Delete ${f.name}`}
                  onClick={async () => {
                    if (await deleteFileAsking(f, onError)) load();
                  }}
                >
                  <IconTrash size={16} />
                </ActionIcon>
              </Tooltip>
            )}
          </Group>
        );
      })}
    </Stack>
  );
}

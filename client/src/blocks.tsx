import { BlockNoteSchema, defaultBlockSpecs } from '@blocknote/core';
import { createReactBlockSpec, ResizableFileBlockWrapper } from '@blocknote/react';
import { IconFileTypePdf } from '@tabler/icons-react';

/**
 * A PDF shown inline, like BlockNote's image and video blocks: upload or
 * link one, resize it, add a caption. Dropped or pasted PDFs land here.
 */
export const pdfBlock = createReactBlockSpec(
  {
    type: 'pdf',
    propSchema: {
      name: { default: '' as const },
      url: { default: '' as const },
      caption: { default: '' as const },
      showPreview: { default: true },
      previewWidth: { default: undefined, type: 'number' },
    },
    content: 'none',
    meta: { fileBlockAccept: ['application/pdf'] },
  },
  {
    render: (props) => (
      <ResizableFileBlockWrapper {...(props as any)} buttonIcon={<IconFileTypePdf size={24} />}>
        <iframe className="pdf-frame" src={props.block.props.url} title={props.block.props.name || 'PDF'} />
      </ResizableFileBlockWrapper>
    ),
  }
);

export const schema = BlockNoteSchema.create({
  blockSpecs: { ...defaultBlockSpecs, pdf: pdfBlock() },
});

export type Schema = typeof schema;

/** The block type for an uploaded file. */
export function blockTypeFor(mime: string): 'image' | 'video' | 'audio' | 'pdf' | 'file' {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'pdf';
  return 'file';
}

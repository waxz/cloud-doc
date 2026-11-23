import { Stack, Text, UnstyledButton } from '@mantine/core';
import { useEffect, useState } from 'react';
import type { Editor } from './Editor';
import { debounced } from './util';

interface Heading {
  id: string;
  level: number;
  text: string;
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content.map((item) => (item && typeof item === 'object' && 'text' in item ? String((item as { text: unknown }).text) : '')).join('');
}

function collect(editor: Editor): { headings: Heading[]; words: number } {
  const headings: Heading[] = [];
  let text = '';
  const walk = (blocks: any[]) => {
    for (const block of blocks) {
      const own = textOf(block.content);
      text += `${own} `;
      if (block.type === 'heading' && own.trim()) headings.push({ id: block.id, level: Number(block.props?.level ?? 1), text: own.trim() });
      if (block.children?.length) walk(block.children);
    }
  };
  walk(editor.document as any[]);
  return { headings, words: text.trim() ? text.trim().split(/\s+/).length : 0 };
}

/** The page's headings (click to jump) and a word count. */
export function OutlinePanel({ editor }: { editor: Editor | null }) {
  const [state, setState] = useState<{ headings: Heading[]; words: number }>({ headings: [], words: 0 });
  useEffect(() => {
    if (!editor) return;
    const update = debounced(() => setState(collect(editor)), 400);
    setState(collect(editor));
    const unsubscribe = editor.onChange(update);
    return () => {
      update.cancel();
      unsubscribe();
    };
  }, [editor]);

  if (!editor) return <Text size="sm" c="dimmed">Loading…</Text>;
  const top = Math.min(3, ...state.headings.map((h) => h.level));
  return (
    <Stack gap={2}>
      {state.headings.length === 0 && <Text size="sm" c="dimmed">No headings yet. Use “/” to add a heading and it appears here.</Text>}
      {state.headings.map((h) => (
        <UnstyledButton
          key={h.id}
          className="outline-item"
          style={{ paddingLeft: 8 + Math.max(0, Math.min(h.level, 3) - top) * 14 }}
          onClick={() => document.querySelector(`.page [data-id="${CSS.escape(h.id)}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })}
        >
          {h.text}
        </UnstyledButton>
      ))}
      <Text size="xs" c="dimmed" mt="sm">{state.words.toLocaleString()} words</Text>
    </Stack>
  );
}

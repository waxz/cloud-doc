import { BlockNoteSchema, defaultBlockSpecs, defaultInlineContentSpecs } from '@blocknote/core';
import { createReactBlockSpec, createReactInlineContentSpec, ResizableFileBlockWrapper } from '@blocknote/react';
import { IconArrowAutofitHeight, IconArrowAutofitWidth, IconChevronDown, IconChevronUp, IconFileTypePdf, IconZoomIn, IconZoomOut } from '@tabler/icons-react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { api, type Comment } from './api';

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
      pageId: { default: '' as const },
      commentable: { default: false },
    },
    content: 'none',
    meta: { fileBlockAccept: ['application/pdf'] },
  },
  {
    render: (props) => (
      <ResizableFileBlockWrapper {...(props as any)} buttonIcon={<IconFileTypePdf size={24} />}>
        <PdfReader
          url={props.block.props.url}
          name={props.block.props.name}
          pageId={props.block.props.pageId}
          commentable={props.block.props.commentable}
        />
      </ResizableFileBlockWrapper>
    ),
  }
);

/**
 * Which page is open and whether the viewer may comment on it. A PDF block used to carry both in its own properties,
 * written when it was inserted, so one added any other way (the /pdf menu, a paste, a copy from another page) had
 * neither: no highlight toolbar, and the page's highlights were never loaded. The open page is the source of truth.
 */
export const PageContext = createContext<{ pageId: string; canComment: boolean }>({ pageId: '', canComment: false });

interface PdfSelection {
  text: string;
  page: number;
  rects: number[][];
  x: number;
  y: number;
  color: string;
  shape: string;
}

export const HIGHLIGHT_SHAPES = [
  { value: 'highlight', label: 'Highlight' },
  { value: 'underline', label: 'Underline' },
  { value: 'strike', label: 'Strikethrough' },
  { value: 'box', label: 'Box' },
] as const;

export type HighlightShape = typeof HIGHLIGHT_SHAPES[number]['value'];

export const COMMENT_COLORS = [
  { value: 'yellow', label: 'Yellow', color: '#facc15' },
  { value: 'orange', label: 'Orange', color: '#fb923c' },
  { value: 'red', label: 'Red', color: '#fb7185' },
  { value: 'pink', label: 'Pink', color: '#e879f9' },
  { value: 'purple', label: 'Purple', color: '#a78bfa' },
  { value: 'blue', label: 'Blue', color: '#60a5fa' },
  { value: 'green', label: 'Green', color: '#34d399' },
] as const;

/**
 * The rectangles of a text selection in a PDF, as fractions of the page, tidied into one box per line.
 * A range over PDF.js text reports boxes for the whole text layer and its pieces, overlapping ones and
 * ones taller than any line; drawn as they come they smear over several lines. Keep the line-sized boxes,
 * drop any that merely contain others, and join neighbours on the same line.
 */
export function cleanRects(rects: number[][]): number[][] {
  const boxes = rects.filter((r) => r.length === 4 && r[2]! > 0.002 && r[3]! > 0.002 && r[3]! < 0.06 && r[2]! < 0.98);
  const inside = (a: number[], b: number[]) => b[0]! >= a[0]! - 0.002 && b[1]! >= a[1]! - 0.002 && b[0]! + b[2]! <= a[0]! + a[2]! + 0.002 && b[1]! + b[3]! <= a[1]! + a[3]! + 0.002;
  const lines = boxes.filter((a, i) => !boxes.some((b, j) => i !== j && inside(a, b) && (b[2]! * b[3]!) < (a[2]! * a[3]!) * 0.7));
  lines.sort((a, b) => a[1]! - b[1]! || a[0]! - b[0]!);
  const out: number[][] = [];
  for (const r of lines) {
    const last = out[out.length - 1];
    const sameLine = last && Math.abs((last[1]! + last[3]! / 2) - (r[1]! + r[3]! / 2)) < Math.min(last[3]!, r[3]!) * 0.5;
    if (last && sameLine && r[0]! <= last[0]! + last[2]! + 0.012) {
      const left = Math.min(last[0]!, r[0]!);
      const right = Math.max(last[0]! + last[2]!, r[0]! + r[2]!);
      const top = Math.min(last[1]!, r[1]!);
      const bottom = Math.max(last[1]! + last[3]!, r[1]! + r[3]!);
      out[out.length - 1] = [left, top, right - left, bottom - top];
    } else out.push([...r]);
  }
  return out;
}

function PdfReader({ url, name, pageId: blockPageId, commentable: blockCommentable }: { url: string; name: string; pageId: string; commentable: boolean }) {
  const page = useContext(PageContext);
  const pageId = page.pageId || blockPageId;
  const commentable = page.canComment || blockCommentable;
  const root = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [comments, setComments] = useState<Comment[]>([]);
  const [selection, setSelection] = useState<PdfSelection | null>(null);
  const [scale, setScale] = useState(1);
  const latest = useRef<Omit<PdfSelection, 'color' | 'shape'> | null>(null);
  // How big the pages are drawn: to the viewer's width, to the window's height, or a chosen scale (1 = 100%).
  const [zoom, setZoom] = useState<{ mode: 'width' | 'page' | 'custom'; scale: number }>({ mode: 'width', scale: 1 });
  const [shownScale, setShownScale] = useState(1); // the scale the first page ended up drawn at
  const [pageCount, setPageCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);

  const loadComments = () => {
    if (!pageId) return;
    api.comments(pageId).then(setComments, () => setComments([]));
  };

  useEffect(() => {
    loadComments();
    window.addEventListener('cloud-doc-comments-changed', loadComments);
    return () => window.removeEventListener('cloud-doc-comments-changed', loadComments);
  }, [pageId]);

  // The document is fetched once per file; the pages are drawn again whenever the viewer's width changes,
  // so they always fit it.
  const [doc, setDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    let task: pdfjsLib.PDFDocumentLoadingTask | null = null;
    setLoading(true);
    setError('');
    setDoc(null);
    pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;
    (async () => {
      let response: Response | null = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        response = await fetch(url, { cache: 'force-cache' });
        if (response.ok) break;
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!response?.ok) {
        throw new Error(response?.status
          ? `PDF server returned ${response.status}${response.status === 502 ? ' (file storage/service unavailable)' : ''}.`
          : 'Could not retrieve the PDF.');
      }
      const data = new Uint8Array(await response.arrayBuffer());
      task = pdfjsLib.getDocument({ data, disableRange: true, disableStream: true });
      const pdf = await task.promise;
      if (!cancelled) setDoc(pdf);
    })().catch((e: Error) => {
      if (!cancelled) {
        setLoading(false);
        setError(e?.message || 'Could not open this PDF.');
      }
    });
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [url]);

  useEffect(() => {
    if (!root.current) return;
    const element = root.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // (A scrollbar appearing or going changes the width by ~15px: not worth drawing every page again for.)
    const measure = () => setWidth((current) => {
      const next = Math.round(element.clientWidth);
      return (next > current ? next - current >= 24 : current - next >= 4) ? next : current;
    });
    measure();
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(measure, 150);
    });
    observer.observe(element);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [url]);

  // Which page is in view (shown in the toolbar), and jumping to one.
  useEffect(() => {
    if (!pageCount) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const container = root.current;
      if (!container) return;
      const middle = window.innerHeight * 0.4;
      let best = 1;
      let bestDistance = Infinity;
      container.querySelectorAll<HTMLElement>('.pdf-page').forEach((el) => {
        const r = el.getBoundingClientRect();
        const distance = r.top <= middle && r.bottom >= middle ? 0 : Math.min(Math.abs(r.top - middle), Math.abs(r.bottom - middle));
        if (distance < bestDistance) {
          bestDistance = distance;
          best = Number(el.dataset.page);
        }
      });
      setCurrentPage(best);
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update); };
    document.addEventListener('scroll', onScroll, true);
    update();
    return () => {
      document.removeEventListener('scroll', onScroll, true);
      cancelAnimationFrame(frame);
    };
  }, [pageCount, zoom, width]);
  const jumpTo = (n: number) => {
    const target = Math.min(pageCount, Math.max(1, Math.round(n) || 1));
    setCurrentPage(target);
    root.current?.querySelector<HTMLElement>(`.pdf-page[data-page="${target}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };
  const zoomBy = (factor: number) => setZoom({ mode: 'custom', scale: Math.min(6, Math.max(0.2, shownScale * factor)) });

  // Tell the editor to treat this block as a black box: it must not read the browser's selection inside it (that is
  // what turned a click or a drag in the viewer into "the whole block is selected", and then wrote that selection back
  // over the text), nor react to changes in it. Done on every render, as the editor may rebuild its record of the block.
  useEffect(() => {
    const dom = root.current?.closest('.node-pdf') as (HTMLElement & { pmViewDesc?: { ignoreMutation?: unknown; stopEvent?: unknown; __pdfBlackBox?: boolean } }) | null | undefined;
    const desc = dom?.pmViewDesc;
    if (desc && !desc.__pdfBlackBox) {
      desc.ignoreMutation = () => true;
      desc.stopEvent = (event: Event) => !(event.type === 'drop' || event.type.startsWith('drag'));
      desc.__pdfBlackBox = true;
    }
  });

  // Selecting text in the PDF: the editor must not take the mouse (it would select the whole block instead), and
  // the text layer needs its "selecting" state while the button is down.
  useEffect(() => {
    const container = root.current;
    if (!container) return;
    const down = (event: MouseEvent) => {
      event.stopPropagation();
      setSelection(null);
      latest.current = null;
      // While the editor has the focus it keeps writing its own selection over the browser's (on every update, such as
      // the one its side menu makes as the mouse moves), so give the focus up once the click has been handled.
      setTimeout(() => {
        const active = document.activeElement;
        // (only while it is being edited: a read-only editor has no focus to give up)
        if (active instanceof HTMLElement && active.closest('.bn-editor[contenteditable="true"]')) active.blur();
      }, 0);
      const layer = (event.target as Element | null)?.closest?.('.pdf-text-layer');
      if (layer) layer.classList.add('selecting');
    };
    const up = () => {
      container.querySelectorAll('.pdf-text-layer.selecting').forEach((layer) => layer.classList.remove('selecting'));
      syncEditorSelection();
    };
    // The editor also watches the browser's selection, and a selection inside this block (an island it can't edit)
    // is turned into "the whole block is selected", undoing what the mouse just did. So while the selection is in
    // the PDF, its change notices stop before the editor's listener (the toolbar here reads it on mouse-up).
    // The editor also re-reads the browser's selection whenever anything in its DOM changes, and finding it in this
    // block turns it into "the block is selected". Telling it that the selection it last saw is the current one
    // makes it leave this one alone.
    const syncEditorSelection = () => {
      type PmView = { domSelectionRange?: () => unknown; domObserver?: { currentSelection?: { set?: (range: unknown) => void } } };
      const host = container.closest('.ProseMirror') as (HTMLElement & { editor?: { view?: PmView } }) | null;
      const view = host?.editor?.view;
      if (view?.domSelectionRange) view.domObserver?.currentSelection?.set?.(view.domSelectionRange());
    };
    const guard = (event: Event) => {
      const selection = window.getSelection();
      if (selection && ((selection.anchorNode && container.contains(selection.anchorNode)) || (selection.focusNode && container.contains(selection.focusNode)))) {
        window.dispatchEvent(new CustomEvent('cloud-doc-pdf-selection')); // (the stop below would hide it from later listeners)
        event.stopImmediatePropagation();
        syncEditorSelection();
      }
    };
    // The marks don't take the mouse (they'd stop text under a highlight being selected), so a plain click on one is
    // found by position.
    const click = (event: MouseEvent) => {
      if (window.getSelection()?.toString()) return;
      const hit = [...container.querySelectorAll<HTMLElement>('.pdf-highlight')].find((mark) => {
        const r = mark.getBoundingClientRect();
        return event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom;
      });
      if (!hit?.dataset.commentId) return;
      const r = hit.getBoundingClientRect();
      window.dispatchEvent(new CustomEvent('cloud-doc-peek-comment', { detail: { id: hit.dataset.commentId, left: event.clientX, top: r.top, right: r.right, bottom: r.bottom, below: true } }));
    };
    container.addEventListener('click', click);
    container.addEventListener('mousedown', down);
    document.addEventListener('mouseup', up);
    window.addEventListener('blur', up);
    window.addEventListener('selectionchange', guard, true);
    return () => {
      container.removeEventListener('click', click);
      container.removeEventListener('mousedown', down);
      document.removeEventListener('mouseup', up);
      window.removeEventListener('blur', up);
      window.removeEventListener('selectionchange', guard, true);
    };
  }, [url]);

  useEffect(() => {
    if (!doc || !root.current || width < 80) return;
    let cancelled = false;
    const container = root.current;
    const dpr = window.devicePixelRatio || 1;
    // Drawing again starts with one page, which would shrink the document and make the browser pull the scroll position
    // back to the new end. So: hold the height while drawing, and afterwards put the same spot of the same page back under
    // the same line of the window.
    let scroller: HTMLElement | null = container.parentElement;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    const line = scroller ? scroller.getBoundingClientRect().top + scroller.clientHeight * 0.4 : 0;
    let anchor: { page: number; fraction: number } | null = null;
    container.querySelectorAll<HTMLElement>('.pdf-page').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (!anchor && r.bottom >= line) anchor = { page: Number(el.dataset.page), fraction: Math.min(1, Math.max(0, (line - r.top) / r.height)) };
    });
    container.style.minHeight = `${container.offsetHeight}px`;
    const settle = () => {
      container.style.minHeight = '';
      const a = anchor as { page: number; fraction: number } | null;
      const el = a && container.querySelector<HTMLElement>(`.pdf-page[data-page="${a.page}"]`);
      if (a && el && scroller) {
        const r = el.getBoundingClientRect();
        scroller.scrollTop += r.top + a.fraction * r.height - line;
      }
    };
    (async () => {
      const fresh = document.createDocumentFragment();
      setPageCount(doc.numPages);
      for (let number = 1; number <= doc.numPages; number++) {
        const page = await doc.getPage(number);
        if (cancelled) return;
        const base = page.getViewport({ scale: 1 });
        // the page fills the viewer's width (less a small margin), whatever the size of the PDF
        const fitWidth = (width - 16) / base.width;
        // "fit page" shows a whole page in the window under the page header and this viewer's bar
        const fitPage = Math.min(fitWidth, Math.max(120, window.innerHeight - 52 - 44 - 36) / base.height);
        const pageScale = zoom.mode === 'width' ? fitWidth : zoom.mode === 'page' ? fitPage : zoom.scale;
        const viewport = page.getViewport({ scale: Math.min(6, Math.max(0.2, pageScale)) });
        if (number === 1) setShownScale(viewport.scale);
        const pageEl = document.createElement('div');
        pageEl.className = 'pdf-page';
        pageEl.dataset.page = String(number);
        pageEl.style.width = `${viewport.width}px`;
        pageEl.style.height = `${viewport.height}px`;

        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        pageEl.appendChild(canvas);

        const text = document.createElement('div');
        text.className = 'pdf-text-layer';
        text.style.width = `${viewport.width}px`;
        text.style.height = `${viewport.height}px`;
        // PDF.js sizes the text from these (its own stylesheet, which this viewer doesn't load, defines them)
        text.style.setProperty('--scale-factor', String(viewport.scale));
        text.style.setProperty('--total-scale-factor', String(viewport.scale));
        pageEl.appendChild(text);

        const highlights = document.createElement('div');
        highlights.className = 'pdf-annotation-layer';
        pageEl.appendChild(highlights);
        // the first page shows at once (replacing the old pages); the others are added as they are drawn
        if (number === 1) {
          fresh.appendChild(pageEl);
          container.replaceChildren(fresh);
          setLoading(false);
        } else container.appendChild(pageEl);

        const context = canvas.getContext('2d');
        if (context) {
          await page.render({ canvas, canvasContext: context, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined }).promise;
        }
        const textLayer = new pdfjsLib.TextLayer({ textContentSource: await page.getTextContent(), container: text, viewport });
        await textLayer.render();
        // The strip PDF.js keeps at the end of a text layer: while the mouse is down it spreads over the layer, so a
        // drag that crosses gaps between words keeps its place instead of jumping to the start or the end.
        const end = document.createElement('div');
        end.className = 'endOfContent';
        text.appendChild(end);
      }
      if (!cancelled) {
        setScale((value) => value + 1);
        settle();
      }
    })().catch((e: Error) => {
      if (!cancelled) {
        setLoading(false);
        setError(e?.message || 'Could not open this PDF.');
      }
    });
    return () => {
      cancelled = true;
      container.style.minHeight = '';
    };
  }, [doc, width, zoom]);

  useEffect(() => {
    if (!root.current) return;
    root.current.querySelectorAll('.pdf-annotation-layer').forEach((layer) => layer.replaceChildren());
    for (const comment of comments) {
      if (comment.quote_pdf_url !== url || !comment.quote_page || !comment.quote_rects) continue;
      let rects: number[][] = [];
      try { rects = cleanRects(JSON.parse(comment.quote_rects)); } catch { continue; }
      const pageEl = root.current.querySelector<HTMLElement>(`.pdf-page[data-page="${comment.quote_page}"]`);
      const layer = pageEl?.querySelector<HTMLElement>('.pdf-annotation-layer');
      if (!pageEl || !layer) continue;
      rects.forEach((rect) => {
        const [x, y, width, height] = rect;
        const mark = document.createElement('button');
        mark.type = 'button';
        const shape = comment.quote_shape || 'highlight';
        mark.className = `pdf-highlight shape-${shape}`;
        const highlightColor = comment.quote_color
          ? COMMENT_COLORS.find((item) => item.value === comment.quote_color)?.color
          : '#facc15';
        if (highlightColor) {
          mark.style.setProperty('--highlight-color', highlightColor);
          if (shape === 'highlight') mark.style.background = `${highlightColor}66`;
        }
        mark.dataset.threadId = comment.thread_id;
        mark.setAttribute('aria-label', `PDF comment: ${comment.quote ?? 'View comment'}`);
        mark.style.left = `${x * pageEl.clientWidth}px`;
        mark.style.top = `${y * pageEl.clientHeight}px`;
        mark.style.width = `${width * pageEl.clientWidth}px`;
        mark.style.height = `${height * pageEl.clientHeight}px`;
        mark.dataset.commentId = comment.id;
        mark.tabIndex = -1;
        layer.appendChild(mark);
      });
    }
    // (the page's margin cards and the Highlights panel's order depend on where the marks are)
    window.dispatchEvent(new CustomEvent('cloud-doc-marks-drawn'));
  }, [comments, url, loading, scale]);

  useEffect(() => {
    const showAnnotation = (event: Event) => {
      const detail = (event as CustomEvent<{ id: string; page: number; pdfUrl: string; ack?: { ok: boolean } }>).detail;
      if (!detail || detail.pdfUrl !== url || !root.current) return;
      const pageEl = root.current.querySelector<HTMLElement>(`.pdf-page[data-page="${detail.page}"]`);
      if (!pageEl) return;
      root.current.querySelectorAll('.pdf-highlight').forEach((mark) => mark.classList.remove('is-active'));
      pageEl.querySelectorAll<HTMLElement>('.pdf-highlight').forEach((mark) => {
        if (mark.dataset.threadId === detail.id) mark.classList.add('is-active');
      });
      pageEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
      if (detail.ack) detail.ack.ok = true;
    };
    window.addEventListener('cloud-doc-show-pdf-annotation', showAnnotation);
    return () => window.removeEventListener('cloud-doc-show-pdf-annotation', showAnnotation);
  }, [url]);

  useEffect(() => {
    if (!root.current) return;
    const readSelection = (): Omit<PdfSelection, 'color' | 'shape'> | null => {
      const selection = window.getSelection();
      const text = selection?.toString().trim() ?? '';
      if (!selection?.rangeCount || !text) return null;
      const node = selection.anchorNode;
      const element = node && (node instanceof Element ? node : node.parentElement);
      const pageEl = element?.closest<HTMLElement>('.pdf-page');
      if (!pageEl || !root.current?.contains(pageEl)) return null;
      const pageRect = pageEl.getBoundingClientRect();
      const rects: number[][] = [];
      const range = selection.getRangeAt(0);
      for (let i = 0; i < range.getClientRects().length; i++) {
        const rect = range.getClientRects()[i]!;
        if (!rect.width || !rect.height) continue;
        rects.push([
          (rect.left - pageRect.left) / pageRect.width,
          (rect.top - pageRect.top) / pageRect.height,
          rect.width / pageRect.width,
          rect.height / pageRect.height,
        ]);
      }
      const lines = cleanRects(rects);
      if (!lines.length) return null;
      const first = range.getBoundingClientRect();
      return { text: text.slice(0, 500), page: Number(pageEl.dataset.page), rects: lines, x: first.left + first.width / 2, y: first.top };
    };
    // The selection as it was while the mouse dragged: what the editor does to the browser's selection afterwards
    // (it resets it, as it can't edit in this block) must not lose it.
    const watch = () => {
      if (!commentable) return;
      const selection = window.getSelection();
      if (selection && ((selection.anchorNode && root.current?.contains(selection.anchorNode)) || (selection.focusNode && root.current?.contains(selection.focusNode)))) {
        latest.current = readSelection();
      }
    };
    window.addEventListener('cloud-doc-pdf-selection', watch);
    // Read the selection when the mouse is released, and keep what was read: the editor around this block resets the
    // browser's own selection a moment later (it can't edit inside it), so the toolbar and the marking below must
    // not depend on the live selection.
    const onMouseUp = (event: MouseEvent) => {
      if ((event.target as Element | null)?.closest?.('.pdf-comment-button')) return;
      const picked = commentable ? latest.current : null;
      latest.current = null;
      setSelection((previous) => (picked ? { ...picked, color: previous?.color || 'yellow', shape: previous?.shape || 'highlight' } : null));
    };
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (!target?.closest?.('.pdf-comment-button') && !root.current?.contains(target)) setSelection(null);
    };
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('mousedown', onMouseDown);
    return () => {
      window.removeEventListener('cloud-doc-pdf-selection', watch);
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('mousedown', onMouseDown);
    };
  }, [commentable]);

  // The pending selection, drawn on the page like a highlight until it is commented on or dismissed.
  useEffect(() => {
    const container = root.current;
    if (!container) return;
    container.querySelectorAll('.pdf-pending-layer').forEach((layer) => layer.remove());
    if (!selection) return;
    const pageEl = container.querySelector<HTMLElement>(`.pdf-page[data-page="${selection.page}"]`);
    if (!pageEl) return;
    const layer = document.createElement('div');
    layer.className = 'pdf-pending-layer';
    for (const [x, y, w, h] of selection.rects) {
      const box = document.createElement('div');
      box.style.cssText = `left:${x! * pageEl.clientWidth}px;top:${y! * pageEl.clientHeight}px;width:${w! * pageEl.clientWidth}px;height:${h! * pageEl.clientHeight}px`;
      layer.appendChild(box);
    }
    pageEl.appendChild(layer);
    return () => {
      layer.remove();
    };
  }, [selection]);

  return (
    <div className="pdf-reader">
      <div className="pdf-reader-bar">
        <IconFileTypePdf size={18} />
        <span className="pdf-name">{name || 'PDF'}</span>
        {pageCount > 0 && (
          <div className="pdf-tools" role="toolbar" aria-label="PDF view">
            <button type="button" className="pdf-tool" aria-label="Zoom out" title="Zoom out" onClick={() => zoomBy(1 / 1.25)}><IconZoomOut size={16} /></button>
            <span className="pdf-zoom" title="Current zoom">{Math.round(shownScale * 100)}%</span>
            <button type="button" className="pdf-tool" aria-label="Zoom in" title="Zoom in" onClick={() => zoomBy(1.25)}><IconZoomIn size={16} /></button>
            <button type="button" className="pdf-tool" aria-label="Fit to width" title="Fit to width" aria-pressed={zoom.mode === 'width'} onClick={() => setZoom({ mode: 'width', scale: 1 })}><IconArrowAutofitWidth size={16} /></button>
            <button type="button" className="pdf-tool" aria-label="Fit page" title="Fit a whole page in the window" aria-pressed={zoom.mode === 'page'} onClick={() => setZoom({ mode: 'page', scale: 1 })}><IconArrowAutofitHeight size={16} /></button>
            <span className="pdf-sep" />
            <button type="button" className="pdf-tool" aria-label="Previous page" title="Previous page" disabled={currentPage <= 1} onClick={() => jumpTo(currentPage - 1)}><IconChevronUp size={16} /></button>
            <input
              key={currentPage}
              className="pdf-page-input"
              aria-label="Page number"
              defaultValue={currentPage}
              inputMode="numeric"
              onFocus={(e) => e.currentTarget.select()}
              onKeyDown={(e) => { if (e.key === 'Enter') { jumpTo(Number(e.currentTarget.value)); e.currentTarget.blur(); } }}
              onBlur={(e) => { if (Number(e.currentTarget.value) !== currentPage) jumpTo(Number(e.currentTarget.value)); }}
            />
            <span className="pdf-zoom">/ {pageCount}</span>
            <button type="button" className="pdf-tool" aria-label="Next page" title="Next page" disabled={currentPage >= pageCount} onClick={() => jumpTo(currentPage + 1)}><IconChevronDown size={16} /></button>
          </div>
        )}
        <a href={url} target="_blank" rel="noopener noreferrer">Open original</a>
      </div>
      {loading && <div className="pdf-reader-state">Loading PDF…</div>}
      {error && <div className="pdf-reader-state pdf-reader-error">{error}</div>}
      <div ref={root} className="pdf-pages" />
      {selection && (
        <div className="pdf-comment-button" style={{ left: selection.x, top: selection.y }}>
          <div className="selection-shape-buttons" role="toolbar" aria-label="Highlight shape">
            {HIGHLIGHT_SHAPES.map((s) => (
              <button
                key={s.value}
                type="button"
                className="selection-shape-btn"
                aria-label={s.label}
                title={s.label}
                aria-pressed={selection.shape === s.value}
                style={{ '--highlight-color': COMMENT_COLORS.find((c) => c.value === selection.color)?.color || '#facc15' } as React.CSSProperties}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setSelection((current) => current ? { ...current, shape: s.value } : null)}
              >
                <span className={`shape-icon shape-${s.value}`}>Ab</span>
              </button>
            ))}
          </div>
          <span className="selection-sep" />
          <div className="selection-highlight-palette" role="toolbar" aria-label="Highlight color">
            {COMMENT_COLORS.map((item) => (
              <button
                key={item.value}
                type="button"
                className={selection.color === item.value ? 'selection-color is-selected' : 'selection-color'}
                style={{ '--highlight-color': item.color } as React.CSSProperties}
                aria-label={`${item.label} highlight`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  window.dispatchEvent(new CustomEvent('cloud-doc-pdf-comment', {
                    detail: {
                      text: selection.text,
                      page: selection.page,
                      rects: selection.rects,
                      pdfUrl: url,
                      color: item.value,
                      shape: selection.shape,
                      instant: true,
                    },
                  }));
                  window.getSelection()?.collapseToEnd(); // removeAllRanges() leaves ProseMirror swallowing the next mousedown, so nothing can be selected again
                  setSelection(null);
                }}
              />
            ))}
          </div>
          <button
            type="button"
            className="selection-comment-action"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              window.dispatchEvent(new CustomEvent('cloud-doc-pdf-comment', {
                detail: {
                  text: selection.text,
                  page: selection.page,
                  rects: selection.rects,
                  pdfUrl: url,
                  color: selection.color,
                  shape: selection.shape,
                  instant: false,
                },
              }));
              window.getSelection()?.collapseToEnd(); // removeAllRanges() leaves ProseMirror swallowing the next mousedown, so nothing can be selected again
              setSelection(null);
            }}
          >
            Comment
          </button>
        </div>
      )}
    </div>
  );
}

export const latexBlock = createReactBlockSpec(
  {
    type: 'latex',
    propSchema: {
      source: { default: '' as const },
    },
    content: 'none',
  },
  {
    render: (props) => {
      const source = props.block.props.source;
      let html = '';
      try {
        html = katex.renderToString(source || '\\text{Enter LaTeX}', { displayMode: true, throwOnError: false });
      } catch {
        html = `<code>${source.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] ?? char))}</code>`;
      }
      return (
        <div className="latex-block">
          {props.editor.isEditable ? (
            <textarea
              aria-label="LaTeX source"
              value={source}
              placeholder="LaTeX equation"
              onChange={(event) => props.editor.updateBlock(props.block, { props: { source: event.currentTarget.value } })}
            />
          ) : null}
          <div className="latex-preview" dangerouslySetInnerHTML={{ __html: html }} />
        </div>
      );
    },
  }
);

export const latexInline = createReactInlineContentSpec(
  {
    type: 'latex-inline',
    propSchema: { source: { default: '' as const } },
    content: 'none',
  },
  {
    render: ({ inlineContent, updateInlineContent, editor }) => {
      const source = inlineContent.props.source;
      let html = '';
      try {
        html = katex.renderToString(source || '\\text{LaTeX}', { displayMode: false, throwOnError: false });
      } catch {
        html = `<code>${source.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] ?? char))}</code>`;
      }
      return (
        <span className="latex-inline">
          {editor.isEditable ? (
            <input
              aria-label="Inline LaTeX source"
              value={source}
              placeholder="LaTeX"
              onChange={(event) => updateInlineContent({ type: 'latex-inline', props: { source: event.currentTarget.value } })}
            />
          ) : null}
          <span dangerouslySetInnerHTML={{ __html: html }} />
        </span>
      );
    },
  }
);

export const schema = BlockNoteSchema.create({
  blockSpecs: { ...defaultBlockSpecs, pdf: pdfBlock(), latex: latexBlock() },
  inlineContentSpecs: { ...defaultInlineContentSpecs, 'latex-inline': latexInline },
});

export type Schema = typeof schema;

export { blockTypeFor } from './util';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Icon } from "./components/Icon";
import { copyImageSource, imageFileName, saveImageSource } from "./imageActions";

export type ViewerImage = {
  id: string;
  source: string;
  alt: string;
  directory?: string;
  /** InlineImage 已经解析好的地址；本地图片是 Blob URL。 */
  url: string;
  naturalWidth?: number;
  naturalHeight?: number;
  element?: HTMLImageElement | null;
};

type Rect = { left: number; top: number; width: number; height: number };
type Phase = "opening" | "open" | "closing";
type ViewSession = { images: ViewerImage[]; index: number; phase: Phase };

type ImageViewerApi = {
  open: (images: ViewerImage[], index: number) => void;
  close: () => void;
};

type ImageGroupApi = {
  register: (id: string, get: () => ViewerImage) => () => void;
  open: (id: string) => void;
};

const ImageViewerContext = createContext<ImageViewerApi | null>(null);
const ImageGroupContext = createContext<ImageGroupApi | null>(null);

const OPEN_MS = 300;
const CLOSE_MS = 230;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 16;
const EASE = "cubic-bezier(0.2, 0.78, 0.2, 1)";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function imageSize(image: ViewerImage): { width: number; height: number } {
  const width = image.naturalWidth || image.element?.naturalWidth || 0;
  const height = image.naturalHeight || image.element?.naturalHeight || 0;
  if (width > 0 && height > 0) return { width, height };
  const rect = image.element?.getBoundingClientRect();
  if (rect && rect.width > 0 && rect.height > 0) {
    return { width: rect.width, height: rect.height };
  }
  return { width: 800, height: 600 };
}

function visibleRect(element: HTMLImageElement | null | undefined): Rect | null {
  if (!element || !element.isConnected) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return null;
  if (rect.bottom <= 0 || rect.top >= window.innerHeight) return null;
  if (rect.right <= 0 || rect.left >= window.innerWidth) return null;
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

function fitRect(image: ViewerImage): Rect {
  const width = Math.max(180, window.innerWidth);
  const height = Math.max(180, window.innerHeight);
  const availableWidth = Math.max(120, width - 112);
  const availableHeight = Math.max(120, height - 164);
  const size = imageSize(image);
  const ratio = Math.min(availableWidth / size.width, availableHeight / size.height);
  const fittedWidth = Math.max(1, size.width * ratio);
  const fittedHeight = Math.max(1, size.height * ratio);
  return {
    left: (width - fittedWidth) / 2,
    top: 58 + (availableHeight - fittedHeight) / 2,
    width: fittedWidth,
    height: fittedHeight,
  };
}

function fallbackRect(image: ViewerImage): Rect {
  const fit = fitRect(image);
  return {
    left: fit.left + fit.width * 0.06,
    top: fit.top + fit.height * 0.06,
    width: fit.width * 0.88,
    height: fit.height * 0.88,
  };
}

function displayName(image: ViewerImage): string {
  return image.alt.trim() || imageFileName(image.source, image.alt);
}

function domOrder(left: ViewerImage, right: ViewerImage): number {
  const a = left.element;
  const b = right.element;
  if (!a || !b || a === b) return 0;
  const position = a.compareDocumentPosition(b);
  if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
  if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
  return 0;
}

export function useImageViewer(): ImageViewerApi {
  const value = useContext(ImageViewerContext);
  if (!value) throw new Error("useImageViewer 必须在 ImageViewerProvider 内使用");
  return value;
}

export function useImageGroup(): ImageGroupApi | null {
  return useContext(ImageGroupContext);
}

/**
 * 同一条消息里的图片共享一个浏览组：点击任意缩略图后可以左右切换。
 * 注册表只放 ref，不驱动 React 状态，避免流式输出时图片被重挂。
 */
export function ImageGroup({ children }: { children: ReactNode }) {
  const viewer = useImageViewer();
  const entries = useRef(new Map<string, () => ViewerImage>());

  const api = useMemo<ImageGroupApi>(
    () => ({
      register(id, get) {
        entries.current.set(id, get);
        return () => {
          if (entries.current.get(id) === get) entries.current.delete(id);
        };
      },
      open(id) {
        const images = [...entries.current.values()]
          .map((get) => get())
          .filter((image) => Boolean(image.url))
          .sort(domOrder);
        const index = images.findIndex((image) => image.id === id);
        if (index >= 0) viewer.open(images, index);
      },
    }),
    [viewer],
  );

  return (
    <ImageGroupContext.Provider value={api}>
      {children}
    </ImageGroupContext.Provider>
  );
}

export function ImageViewerProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<ViewSession | null>(null);
  const [frame, setFrame] = useState<Rect | null>(null);
  const [animateFrame, setAnimateFrame] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [failed, setFailed] = useState(false);

  const sessionRef = useRef<ViewSession | null>(null);
  const frameRef = useRef<Rect | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const hiddenRef = useRef<HTMLImageElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const timersRef = useRef<number[]>([]);
  const dragRef = useRef<{
    pointerID: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);

  const applySession = useCallback((next: ViewSession | null) => {
    sessionRef.current = next;
    setSession(next);
  }, []);

  const applyFrame = useCallback((next: Rect | null) => {
    frameRef.current = next;
    setFrame(next);
  }, []);

  const later = useCallback((handler: () => void, delay: number) => {
    const id = window.setTimeout(handler, delay);
    timersRef.current.push(id);
  }, []);

  const restoreHidden = useCallback(() => {
    const element = hiddenRef.current;
    hiddenRef.current = null;
    if (element) element.style.visibility = "";
  }, []);

  const hideOrigin = useCallback((element: HTMLImageElement | null | undefined) => {
    if (element && element !== hiddenRef.current) {
      restoreHidden();
      element.style.visibility = "hidden";
      hiddenRef.current = element;
    }
  }, [restoreHidden]);

  const clampOffset = useCallback((value: { x: number; y: number }, nextZoom: number) => {
    const current = frameRef.current;
    if (!current) return { x: 0, y: 0 };
    const maxX = Math.max(0, (current.width * nextZoom - current.width) / 2);
    const maxY = Math.max(0, (current.height * nextZoom - current.height) / 2);
    return {
      x: clamp(value.x, -maxX, maxX),
      y: clamp(value.y, -maxY, maxY),
    };
  }, []);

  const resetZoom = useCallback(() => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  const zoomBy = useCallback((factor: number) => {
    setZoom((previous) => clamp(previous * factor, MIN_ZOOM, MAX_ZOOM));
  }, []);

  useEffect(() => {
    setOffset((current) => clampOffset(current, zoom));
  }, [clampOffset, zoom]);

  const open = useCallback((images: ViewerImage[], index: number) => {
    const image = images[index];
    if (!image) return;
    timersRef.current.forEach((id) => window.clearTimeout(id));
    timersRef.current = [];
    restoreHidden();
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    hideOrigin(image.element);
    const from = visibleRect(image.element) ?? fallbackRect(image);
    const to = fitRect(image);
    setFailed(false);
    setSwitching(false);
    setZoom(1);
    setOffset({ x: 0, y: 0 });
    applyFrame(from);
    setAnimateFrame(false);
    applySession({ images, index, phase: "opening" });

    requestAnimationFrame(() => {
      setAnimateFrame(true);
      requestAnimationFrame(() => {
        applyFrame(to);
        setSession((current) =>
          current ? { ...current, phase: "open" } : current,
        );
      });
    });
    later(() => setAnimateFrame(false), OPEN_MS + 40);
  }, [applyFrame, applySession, hideOrigin, later, restoreHidden]);

  const navigate = useCallback((delta: number) => {
    const current = sessionRef.current;
    if (!current || current.images.length < 2) return;
    const total = current.images.length;
    const index = (current.index + delta + total) % total;
    if (index === current.index) return;
    const image = current.images[index];
    restoreHidden();
    hideOrigin(image.element);
    setFailed(false);
    setZoom(1);
    setOffset({ x: 0, y: 0 });
    setAnimateFrame(false);
    applyFrame(fitRect(image));
    setSwitching(true);
    applySession({ ...current, index, phase: "open" });
    later(() => setSwitching(false), 180);
  }, [applyFrame, applySession, hideOrigin, later, restoreHidden]);

  const close = useCallback(() => {
    const current = sessionRef.current;
    if (!current || current.phase === "closing") return;
    timersRef.current.forEach((id) => window.clearTimeout(id));
    timersRef.current = [];
    const image = current.images[current.index];
    const target = visibleRect(image?.element) ?? (image ? fallbackRect(image) : null);
    setAnimateFrame(true);
    applySession({ ...current, phase: "closing" });
    requestAnimationFrame(() => applyFrame(target));
    later(() => {
      restoreHidden();
      applySession(null);
      applyFrame(null);
      setAnimateFrame(false);
      setSwitching(false);
      setFailed(false);
      setZoom(1);
      setOffset({ x: 0, y: 0 });
      previousFocusRef.current?.focus({ preventScroll: true });
      previousFocusRef.current = null;
    }, CLOSE_MS);
  }, [applyFrame, applySession, later, restoreHidden]);

  const current = session?.images[session.index] ?? null;

  useEffect(() => {
    if (!session || session.phase !== "open") return;
    overlayRef.current?.focus({ preventScroll: true });
  }, [session?.phase, session?.index]);

  useEffect(() => {
    if (!session) return;
    const onResize = () => {
      const active = sessionRef.current;
      if (!active) return;
      setAnimateFrame(false);
      applyFrame(fitRect(active.images[active.index]));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [applyFrame, session !== null]);

  useEffect(() => {
    if (!session) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (document.querySelector(".context-menu")) return;
      switch (event.key) {
        case "Escape":
          event.preventDefault();
          event.stopPropagation();
          close();
          break;
        case "ArrowLeft":
          event.preventDefault();
          event.stopPropagation();
          navigate(-1);
          break;
        case "ArrowRight":
          event.preventDefault();
          event.stopPropagation();
          navigate(1);
          break;
        case "+":
        case "=":
          event.preventDefault();
          event.stopPropagation();
          zoomBy(1.25);
          break;
        case "-":
        case "_":
          event.preventDefault();
          event.stopPropagation();
          zoomBy(0.8);
          break;
        case "0":
          event.preventDefault();
          event.stopPropagation();
          resetZoom();
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [close, navigate, resetZoom, session, zoomBy]);

  useEffect(() => {
    if (!session) return;
    const overlay = overlayRef.current;
    if (!overlay) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      zoomBy(Math.exp(-event.deltaY * 0.0016));
    };
    overlay.addEventListener("wheel", onWheel, { passive: false });
    return () => overlay.removeEventListener("wheel", onWheel);
  }, [session, zoomBy]);

  useEffect(
    () => () => {
      timersRef.current.forEach((id) => window.clearTimeout(id));
      const element = hiddenRef.current;
      if (element) element.style.visibility = "";
    },
    [],
  );

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || zoom <= 1.001) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerID: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: offset.x,
      originY: offset.y,
    };
    setDragging(true);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerID !== event.pointerId) return;
    setOffset(
      clampOffset(
        {
          x: drag.originX + event.clientX - drag.startX,
          y: drag.originY + event.clientY - drag.startY,
        },
        zoom,
      ),
    );
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerID !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const actualSize = () => {
    if (!current || !frame) return;
    const size = imageSize(current);
    setZoom(clamp(size.width / frame.width, MIN_ZOOM, MAX_ZOOM));
    setOffset({ x: 0, y: 0 });
  };

  const zoomPercent = current && frame
    ? Math.round((frame.width / imageSize(current).width) * zoom * 100)
    : 100;

  const api = useMemo(() => ({ open, close }), [open, close]);

  const overlay = session && frame && current
    ? createPortal(
        <div
          ref={overlayRef}
          className="image-viewer-overlay"
          data-phase={session.phase}
          role="dialog"
          aria-modal="true"
          aria-label={`查看图片 ${displayName(current)}`}
          tabIndex={-1}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) close();
          }}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div className="image-viewer-top">
            <div className="image-viewer-caption">
              <span className="image-viewer-name" title={displayName(current)}>
                {displayName(current)}
              </span>
              <span className="image-viewer-sub">
                {imageSize(current).width} × {imageSize(current).height}
                {session.images.length > 1
                  ? ` · ${session.index + 1} / ${session.images.length}`
                  : ""}
              </span>
            </div>
            <div className="image-viewer-top-actions">
              <button
                type="button"
                className="image-viewer-icon-btn"
                title="复制图片"
                aria-label="复制图片"
                onClick={() =>
                  void copyImageSource(
                    current.source,
                    current.directory ?? null,
                  )
                }
              >
                <Icon name="copy" size={16} />
              </button>
              <button
                type="button"
                className="image-viewer-icon-btn"
                title="图片另存为…"
                aria-label="图片另存为"
                onClick={() =>
                  void saveImageSource(
                    current.source,
                    current.directory ?? null,
                    imageFileName(
                      current.source,
                      current.alt,
                      undefined,
                    ),
                  )
                }
              >
                <Icon name="download" size={16} />
              </button>
              <button
                type="button"
                className="image-viewer-icon-btn"
                title="关闭（Esc）"
                aria-label="关闭图片查看器"
                onClick={close}
              >
                <Icon name="close" size={17} />
              </button>
            </div>
          </div>

          <div
            className={`image-viewer-frame${dragging ? " dragging" : ""}`}
            style={{
              left: frame.left,
              top: frame.top,
              width: frame.width,
              height: frame.height,
              transition: animateFrame
                ? `left ${session.phase === "closing" ? CLOSE_MS : OPEN_MS}ms ${EASE}, top ${
                    session.phase === "closing" ? CLOSE_MS : OPEN_MS
                  }ms ${EASE}, width ${
                    session.phase === "closing" ? CLOSE_MS : OPEN_MS
                  }ms ${EASE}, height ${
                    session.phase === "closing" ? CLOSE_MS : OPEN_MS
                  }ms ${EASE}`
                : "none",
              cursor: zoom > 1.001 ? (dragging ? "grabbing" : "grab") : "default",
            }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onDoubleClick={() => {
              if (zoom > 1.01) resetZoom();
              else {
                setZoom(2);
                setOffset({ x: 0, y: 0 });
              }
            }}
          >
            {failed ? (
              <div className="image-viewer-error">图片无法显示</div>
            ) : (
              <img
                key={current.url}
                className={switching ? "switching" : ""}
                src={current.url}
                alt={current.alt}
                draggable={false}
                onError={() => setFailed(true)}
                style={{
                  transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
                  transition: dragging ? "none" : "transform 130ms ease-out",
                }}
              />
            )}
          </div>

          {session.images.length > 1 && (
            <>
              <button
                type="button"
                className="image-viewer-nav prev"
                title="上一张（←）"
                aria-label="上一张图片"
                onClick={() => navigate(-1)}
              >
                <Icon name="chevron-right" size={20} />
              </button>
              <button
                type="button"
                className="image-viewer-nav next"
                title="下一张（→）"
                aria-label="下一张图片"
                onClick={() => navigate(1)}
              >
                <Icon name="chevron-right" size={20} />
              </button>
            </>
          )}

          <div className="image-viewer-toolbar">
            <button
              type="button"
              className="image-viewer-icon-btn"
              title="缩小（-）"
              aria-label="缩小"
              onClick={() => zoomBy(0.8)}
            >
              <Icon name="zoom-out" size={16} />
            </button>
            <button
              type="button"
              className="image-viewer-zoom-label"
              title="适应窗口（0）"
              aria-label="适应窗口"
              onClick={resetZoom}
            >
              {zoomPercent}%
            </button>
            <button
              type="button"
              className="image-viewer-icon-btn"
              title="放大（+）"
              aria-label="放大"
              onClick={() => zoomBy(1.25)}
            >
              <Icon name="zoom-in" size={16} />
            </button>
            <span className="image-viewer-divider" aria-hidden />
            <button
              type="button"
              className="image-viewer-icon-btn"
              title="适应窗口（0）"
              aria-label="适应窗口"
              onClick={resetZoom}
            >
              <Icon name="maximize" size={16} />
            </button>
            <button
              type="button"
              className="image-viewer-zoom-label actual"
              title="实际大小"
              aria-label="实际大小"
              onClick={actualSize}
            >
              1:1
            </button>
          </div>

          <div className="image-viewer-hint">
            {session.images.length > 1 ? "← → 切换 · " : ""}
            滚轮缩放 · 拖动平移 · Esc 关闭
          </div>
        </div>,
        document.body,
      )
    : null;

  return (
    <ImageViewerContext.Provider value={api}>
      {children}
      {overlay}
    </ImageViewerContext.Provider>
  );
}

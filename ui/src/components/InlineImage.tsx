import { useEffect, useId, useRef, useState } from "react";
import { api } from "../api";
import { copyItem, useContextMenu } from "../contextMenu";
import { inlineImageMime } from "../filePreview";
import {
  copyImageSource,
  imageFileName,
  saveImageSource,
} from "../imageActions";
import {
  useImageGroup,
  useImageViewer,
  type ViewerImage,
} from "../imageViewer";

const REMOTE_SOURCE = /^(?:https?:|data:|blob:)/i;

/** 网络、data 和 blob 地址直接交给 WebView；其余按本地文件处理。 */
function remoteSource(src: string): string | null {
  if (REMOTE_SOURCE.test(src)) return src;
  if (src.startsWith("//")) return `https:${src}`;
  return null;
}

function sourceName(src: string): string {
  const name = src.split(/[?#]/)[0].split("/").pop() || src;
  return name.length > 120 ? `${name.slice(0, 117)}…` : name;
}

/**
 * 消息里的图片。
 *
 * 本地绝对/相对路径不能直接塞给 `<img>`：页面来源是 `tauri://localhost`，
 * 路径会被当成站点路径。这里统一交给 Rust 读取，再用 Blob URL 渲染。
 */
export default function InlineImage({
  src,
  alt = "",
  directory,
  preview = true,
}: {
  src: string;
  alt?: string;
  directory?: string;
  /** 已经在预览层里的图片不必再打开一层查看器，但仍保留右键菜单。 */
  preview?: boolean;
}) {
  const id = useId();
  const menu = useContextMenu();
  const viewer = useImageViewer();
  const group = useImageGroup();
  const imgRef = useRef<HTMLImageElement>(null);
  const objectURLRef = useRef<string | null>(null);
  const baseDir = directory?.trim() ? directory : null;
  const remote = remoteSource(src);
  const [url, setUrl] = useState<string | null>(remote);
  const [error, setError] = useState<string | null>(null);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const latest = useRef<ViewerImage>({
    id,
    source: src,
    alt,
    directory: baseDir ?? undefined,
    url: "",
    element: null,
  });
  latest.current = {
    id,
    source: src,
    alt,
    directory: baseDir ?? undefined,
    url: url ?? "",
    naturalWidth: natural?.width,
    naturalHeight: natural?.height,
    element: imgRef.current,
  };

  useEffect(
    () =>
      group?.register(id, () => ({
        ...latest.current,
        element: imgRef.current,
      })),
    [group, id],
  );

  useEffect(() => {
    if (!src.trim()) {
      setUrl(null);
      setError(null);
      setNatural(null);
      return;
    }
    if (remote) {
      setUrl(remote);
      setError(null);
      return;
    }
    const mime = inlineImageMime(src);
    if (!mime) {
      setUrl(null);
      setError(`不支持的图片格式：${src}`);
      return;
    }

    let alive = true;
    let objectURL: string | null = null;
    setUrl(null);
    setError(null);
    setNatural(null);
    api
      .readLocalImage(baseDir, src)
      .then((buffer) => {
        if (!alive) return;
        objectURL = URL.createObjectURL(new Blob([buffer], { type: mime }));
        objectURLRef.current = objectURL;
        setUrl(objectURL);
      })
      .catch((reason) => {
        if (alive) setError(String(reason));
      });
    return () => {
      alive = false;
      if (objectURL) {
        URL.revokeObjectURL(objectURL);
        if (objectURLRef.current === objectURL) objectURLRef.current = null;
      }
    };
  }, [src, baseDir, remote]);

  const handleLoadError = () => {
    if (objectURLRef.current) {
      URL.revokeObjectURL(objectURLRef.current);
      objectURLRef.current = null;
    }
    setUrl(null);
    setNatural(null);
    setError(`图片无法解码或加载：${sourceName(src)}`);
  };

  const openViewer = (element: HTMLImageElement) => {
    if (!preview) return;
    latest.current = {
      ...latest.current,
      element,
      url: url ?? latest.current.url,
      naturalWidth: element.naturalWidth || latest.current.naturalWidth,
      naturalHeight: element.naturalHeight || latest.current.naturalHeight,
    };
    if (group) {
      group.open(id);
    } else {
      viewer.open([latest.current], 0);
    }
  };

  const menuItems = [
    ...(preview
      ? [
          {
            type: "item" as const,
            label: "查看大图",
            icon: "maximize" as const,
            onSelect: () => {
              if (imgRef.current) openViewer(imgRef.current);
            },
          },
        ]
      : []),
    {
      type: "item" as const,
      label: "复制图片",
      icon: "copy" as const,
      onSelect: () => copyImageSource(src, baseDir),
    },
    {
      type: "item" as const,
      label: "图片另存为…",
      icon: "download" as const,
      onSelect: () =>
        saveImageSource(src, baseDir, imageFileName(src, alt)),
    },
    ...(/^https?:/i.test(src)
      ? [
          { type: "separator" as const },
          copyItem("复制图片地址", src, "图片地址已复制"),
        ]
      : []),
  ];

  if (!src.trim()) return null;
  if (error) {
    return (
      <span className="inline-image-state error" title={error}>
        图片无法显示：{alt || sourceName(src)}
      </span>
    );
  }
  if (!url) {
    return <span className="inline-image-state">图片加载中…</span>;
  }
  return (
    <img
      ref={imgRef}
      className="inline-image"
      src={url}
      alt={alt}
      role={preview ? "button" : undefined}
      tabIndex={preview ? 0 : undefined}
      aria-label={preview ? `查看大图：${alt || sourceName(src)}` : undefined}
      onClick={(event) => {
        if (!preview) return;
        event.preventDefault();
        event.stopPropagation();
        openViewer(event.currentTarget);
      }}
      onKeyDown={(event) => {
        if (!preview) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        openViewer(event.currentTarget);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        menu.open(event, menuItems, {
          includeSelection: false,
          label: "图片菜单",
        });
      }}
      onError={handleLoadError}
      onLoad={(event) => {
        const image = event.currentTarget;
        setNatural({
          width: image.naturalWidth,
          height: image.naturalHeight,
        });
        window.dispatchEvent(new Event("deveco:inline-image-load"));
      }}
    />
  );
}

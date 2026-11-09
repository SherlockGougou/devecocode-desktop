import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api";
import { directoryOf, type FilePreview } from "../filePreview";
import { ImageGroup } from "../imageViewer";
import { useApp } from "../store";
import { Icon } from "./Icon";
import Markdown from "./Markdown";

const BINARY_KINDS = new Set(["image", "pdf", "audio", "video"]);
/** 超过这个体积的 base64 不再在主线程解码，避免大视频把界面卡住。 */
const MAX_BINARY_PREVIEW_CHARS = 80 * 1024 * 1024;

function reportError(error: unknown) {
  useApp.setState({ error: String(error) });
}

async function openExternal(path: string) {
  try {
    await api.openPath(path);
  } catch (error) {
    reportError(error);
  }
}

function useBlobURL(blob: Blob | null): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);

  return url;
}

function base64Blob(content: string, mime: string): Blob {
  const binary = atob(content);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mime || "application/octet-stream" });
}

function useBinaryPreview(preview: FilePreview) {
  const [blob, setBlob] = useState<Blob | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setBlob(null);
    setError(null);
    if (!BINARY_KINDS.has(preview.kind)) return;
    if (!preview.content) {
      setError("文件内容为空");
      return;
    }
    if (preview.content.length > MAX_BINARY_PREVIEW_CHARS) {
      setError("文件过大，暂不在内嵌预览中解码。请用默认应用打开。");
      return;
    }
    try {
      setBlob(base64Blob(preview.content, preview.mime));
    } catch {
      setError("文件内容解码失败");
    }
  }, [preview.path, preview.content, preview.mime, preview.kind]);

  return { blob, error };
}

function StateView({
  title,
  detail,
  action,
  loading = false,
}: {
  title: string;
  detail?: string;
  action?: ReactNode;
  loading?: boolean;
}) {
  return (
    <div className="preview-empty">
      <span className={loading ? "preview-spinner" : "preview-empty-icon"}>
        {loading ? null : <Icon name="file" size={22} />}
      </span>
      <div className="preview-empty-title">{title}</div>
      {detail && <div className="preview-empty-copy">{detail}</div>}
      {action && <div className="preview-empty-actions">{action}</div>}
    </div>
  );
}

export default function FilePreviewView({ preview }: { preview: FilePreview }) {
  const [markdownMode, setMarkdownMode] = useState<"rendered" | "source">("rendered");
  const [mediaError, setMediaError] = useState<string | null>(null);
  const { blob, error: binaryError } = useBinaryPreview(preview);
  const binaryURL = useBlobURL(blob);
  const thumbnailURL = useBlobURL(preview.thumbnail);

  useEffect(() => {
    setMarkdownMode("rendered");
    setMediaError(null);
  }, [preview.path]);

  if (preview.kind === "loading") {
    return <StateView title="正在读取文件…" loading />;
  }

  if (preview.kind === "error") {
    return (
      <StateView
        title="无法读取文件"
        detail={preview.message ?? "文件可能已被删除，或当前没有访问权限。"}
        action={
          <button className="ghost-btn" onClick={() => void openExternal(preview.absolute)}>
            <Icon name="external" size={14} />
            用默认应用打开
          </button>
        }
      />
    );
  }

  if (preview.kind === "unsupported") {
    return (
      <StateView
        title="暂不支持内嵌预览"
        detail={preview.message ?? "可以用默认应用打开并查看完整内容。"}
        action={
          <button className="ghost-btn" onClick={() => void openExternal(preview.absolute)}>
            <Icon name="external" size={14} />
            用默认应用打开
          </button>
        }
      />
    );
  }

  if (preview.kind === "quicklook") {
    if (!thumbnailURL) {
      return <StateView title="正在生成系统缩略图…" loading />;
    }
    return (
      <div className="preview-scroll preview-stage">
        <div className="preview-quicklook">
          <img src={thumbnailURL} alt={`${preview.path} 预览`} />
          <div className="preview-note">
            系统 Quick Look 缩略图，完整内容请用默认应用打开。
          </div>
        </div>
      </div>
    );
  }

  if (preview.kind === "markdown") {
    return (
      <>
        <div className="preview-toolbar">
          <div className="preview-segment" role="group" aria-label="Markdown 显示方式">
            <button
              className={markdownMode === "rendered" ? "active" : ""}
              onClick={() => setMarkdownMode("rendered")}
            >
              预览
            </button>
            <button
              className={markdownMode === "source" ? "active" : ""}
              onClick={() => setMarkdownMode("source")}
            >
              源码
            </button>
          </div>
        </div>
        <div className="preview-scroll">
          {markdownMode === "rendered" ? (
            <div className="preview-markdown">
              <ImageGroup>
                <Markdown
                  text={preview.content}
                  directory={directoryOf(preview.absolute)}
                />
              </ImageGroup>
            </div>
          ) : (
            <pre className="preview-body preview-code">{preview.content}</pre>
          )}
        </div>
      </>
    );
  }

  if (preview.kind === "text") {
    return (
      <div className="preview-scroll">
        <pre className="preview-body preview-code">{preview.content}</pre>
      </div>
    );
  }

  if (binaryError) {
    return (
      <StateView
        title="无法显示此文件"
        detail={binaryError}
        action={
          <button className="ghost-btn" onClick={() => void openExternal(preview.absolute)}>
            <Icon name="external" size={14} />
            用默认应用打开
          </button>
        }
      />
    );
  }

  if (mediaError) {
    return (
      <StateView
        title="无法显示此媒体"
        detail={mediaError}
        action={
          <button className="ghost-btn" onClick={() => void openExternal(preview.absolute)}>
            <Icon name="external" size={14} />
            用默认应用打开
          </button>
        }
      />
    );
  }

  if (!binaryURL) {
    return <StateView title="正在准备预览…" loading />;
  }

  if (preview.kind === "image") {
    return (
      <div className="preview-scroll preview-stage">
        <img
          className="preview-image"
          src={binaryURL}
          alt={`${preview.path} 预览`}
          onError={() => setMediaError("当前 WebView 无法解码这张图片，请用默认应用打开。")}
        />
      </div>
    );
  }

  if (preview.kind === "pdf") {
    return (
      <iframe
        className="preview-pdf"
        src={binaryURL}
        title={`${preview.path} 预览`}
      />
    );
  }

  if (preview.kind === "audio") {
    return (
      <div className="preview-stage">
        <audio
          className="preview-audio"
          controls
          src={binaryURL}
          onError={() => setMediaError("当前 WebView 无法解码这段音频，请用默认应用打开。")}
        >
          当前系统不支持音频播放。
        </audio>
        <div className="preview-note">{preview.path.split("/").pop()}</div>
      </div>
    );
  }

  if (preview.kind === "video") {
    return (
      <div className="preview-stage preview-video-stage">
        <video
          className="preview-video"
          controls
          src={binaryURL}
          onError={() => setMediaError("当前 WebView 无法解码这段视频，请用默认应用打开。")}
        >
          当前系统不支持视频播放。
        </video>
      </div>
    );
  }

  return <StateView title="暂不支持此格式" />;
}

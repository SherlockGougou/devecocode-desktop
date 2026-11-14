import { memo, useMemo, useRef } from "react";
import ReactMarkdown, {
  defaultUrlTransform,
  type Components,
} from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "../api";
import { copyItem, useContextMenu } from "../contextMenu";
import { useApp } from "../store";
import InlineImage from "./InlineImage";

/** 图片地址保留 file://、data: 等协议；其余非安全协议返回空字符串。 */
function imageUrlTransform(url: string): string {
  const protocol = /^([a-z][a-z+.-]*):/i.exec(url)?.[1]?.toLowerCase();
  if (!protocol) return url;
  if (
    protocol === "http" ||
    protocol === "https" ||
    protocol === "data" ||
    protocol === "blob" ||
    protocol === "file"
  ) {
    return url;
  }
  return "";
}

function reportError(error: unknown) {
  useApp.setState({ error: String(error) });
}

function linkMenu(href: string | undefined) {
  if (!href) return null;
  const external = /^(https?:\/\/|mailto:)/i.test(href);
  return [
    ...(external
      ? [
          {
            type: "item" as const,
            label: "打开链接",
            icon: "external" as const,
            onSelect: async () => {
              try {
                await api.openPath(href);
              } catch (error) {
                reportError(error);
              }
            },
          },
        ]
      : []),
    copyItem("复制链接地址", href, "链接地址已复制"),
  ];
}

function Markdown({
  text,
  directory,
}: {
  text: string;
  /** 本地相对图片路径的基准目录，通常是工作区或当前 Markdown 文件所在目录。 */
  directory?: string;
}) {
  const menu = useContextMenu();
  const menuRef = useRef(menu);
  menuRef.current = menu;
  // 组件函数必须保持稳定：每次渲染换新函数会让 React 卸载并重挂图片，
  // 导致 Blob URL 被撤销重建，流式输出时图片会反复闪烁并触发滚动。
  const components = useMemo<Components>(
    () => ({
      img: ({ src, alt }) => (
        <InlineImage
          src={String(src ?? "")}
          alt={alt ?? ""}
          directory={directory}
        />
      ),
      a: ({ href, children }) => {
        const items = linkMenu(href);
        return (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            onContextMenu={
              items && items.length > 0
                ? (event) =>
                    menuRef.current.open(event, items, { label: "链接菜单" })
                : undefined
            }
          >
            {children}
          </a>
        );
      },
      code: ({ className, children, ...props }) => {
        const isBlock = Boolean(className) || String(children).includes("\n");
        const code = String(children).replace(/\n$/, "");
        if (!isBlock) {
          return (
            <code
              className="inline-code"
              {...props}
              onContextMenu={(event) =>
                menuRef.current.open(
                  event,
                  [copyItem("复制代码", code, "代码已复制")],
                  { label: "代码菜单" },
                )
              }
            >
              {children}
            </code>
          );
        }
        return (
          <pre
            className="code-block"
            onContextMenu={(event) =>
              menuRef.current.open(
                event,
                [copyItem("复制代码", code, "代码已复制")],
                { label: "代码菜单" },
              )
            }
          >
            <code className={className}>{children}</code>
          </pre>
        );
      },
    }),
    [directory],
  );

  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url, key) =>
          key === "src" ? imageUrlTransform(url) : defaultUrlTransform(url)
        }
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export default memo(Markdown);

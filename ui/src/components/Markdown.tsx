import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "../api";
import { copyItem, useContextMenu } from "../contextMenu";
import { useApp } from "../store";

export default function Markdown({ text }: { text: string }) {
  const menu = useContextMenu();
  const reportError = (error: unknown) => useApp.setState({ error: String(error) });

  const linkMenu = (href: string | undefined) => {
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
  };

  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => {
            const items = linkMenu(href);
            return (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                onContextMenu={
                  items && items.length > 0
                    ? (event) => menu.open(event, items, { label: "链接菜单" })
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
                    menu.open(event, [copyItem("复制代码", code, "代码已复制")], {
                      label: "代码菜单",
                    })
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
                  menu.open(event, [copyItem("复制代码", code, "代码已复制")], {
                    label: "代码菜单",
                  })
                }
              >
                <code className={className}>{children}</code>
              </pre>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

/*
 * 站点没有构建步骤。部署到自定义域名时，把 REPO_URL 改成
 * "https://github.com/<owner>/<repo>"；GitHub Pages 项目站点会自动推导。
 */
const REPO_URL = "";

function detectRepoUrl() {
  if (REPO_URL) return REPO_URL.replace(/\/$/, "");

  const host = window.location.hostname;
  if (!host.endsWith(".github.io")) return "";

  const owner = host.slice(0, -".github.io".length).split(".")[0];
  const path = window.location.pathname.split("/").filter(Boolean);
  const repo = path.length > 0 && !path[0].includes(".") ? path[0] : `${owner}.github.io`;
  return `https://github.com/${owner}/${repo}`;
}

function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
  return Promise.resolve();
}

function bindLinks() {
  const repoUrl = detectRepoUrl();
  const releaseUrl = repoUrl ? `${repoUrl}/releases/latest` : "https://github.com/";

  document.querySelectorAll("[data-repo-link]").forEach((link) => {
    if (!(link instanceof HTMLAnchorElement)) return;
    link.href = repoUrl || "https://github.com/";
    link.target = "_blank";
    link.rel = "noreferrer";
  });

  document.querySelectorAll("[data-release-link]").forEach((link) => {
    if (!(link instanceof HTMLAnchorElement)) return;
    link.href = releaseUrl;
    link.target = "_blank";
    link.rel = "noreferrer";
  });
}

function bindCopyButtons() {
  document.querySelectorAll("[data-copy]").forEach((button) => {
    if (!(button instanceof HTMLButtonElement)) return;
    button.addEventListener("click", async () => {
      const text = button.dataset.copy;
      if (!text) return;
      try {
        await copyText(text);
        const original = button.textContent;
        button.textContent = "已复制";
        window.setTimeout(() => {
          button.textContent = original;
        }, 1400);
      } catch {
        button.textContent = "复制失败";
      }
    });
  });
}

function bindYear() {
  document.querySelectorAll("[data-year]").forEach((node) => {
    node.textContent = String(new Date().getFullYear());
  });
}

bindLinks();
bindCopyButtons();
bindYear();

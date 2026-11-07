import React from "react";
import { createRoot } from "react-dom/client";
import { initTheme } from "./theme";
import { ContextMenuProvider } from "./contextMenu";
import App from "./App";
import "./styles.css";

// 在渲染前定好主题，避免首帧闪一下再变色
initTheme();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ContextMenuProvider>
      <App />
    </ContextMenuProvider>
  </React.StrictMode>,
);

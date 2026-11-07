import { useEffect, useState } from "react";
import { api } from "../../api";
import { getThemeChoice, setThemeChoice, type ThemeChoice } from "../../theme";
import type { MenuBarSettings } from "../../types";
import {
  getMonoFont,
  getUIFont,
  setMonoFont,
  setUIFont,
} from "../../uiPrefs";
import { Icon } from "../Icon";
import { SettingsSection, Toggle } from "./SettingsPrimitives";

function fontFamilyOptions(families: string[], current: string): string[] {
  const options = new Set(families);
  if (current.trim()) options.add(current.trim());
  return [...options].sort((a, b) => a.localeCompare(b, "zh-CN"));
}

export default function AppearancePage({
  menuBar,
  onMenuBarChange,
}: {
  menuBar: MenuBarSettings;
  onMenuBarChange: (patch: Partial<MenuBarSettings>) => void;
}) {
  const [theme, setTheme] = useState<ThemeChoice>(getThemeChoice());
  const [uiFont, updateUIFont] = useState(getUIFont());
  const [monoFont, updateMonoFont] = useState(getMonoFont());
  const [fontFamilies, setFontFamilies] = useState<string[]>([]);
  const [fontsLoading, setFontsLoading] = useState(true);
  const [fontError, setFontError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void api
      .listFontFamilies()
      .then((families) => {
        if (!cancelled) setFontFamilies(families);
      })
      .catch((err) => {
        if (!cancelled) setFontError(String(err));
      })
      .finally(() => {
        if (!cancelled) setFontsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const changeUIFont = (value: string) => {
    updateUIFont(value);
    setUIFont(value);
  };

  const changeMonoFont = (value: string) => {
    updateMonoFont(value);
    setMonoFont(value);
  };

  const uiFontOptions = fontFamilyOptions(fontFamilies, uiFont);
  const monoFontOptions = fontFamilyOptions(fontFamilies, monoFont);

  return (
    <>
      <SettingsSection>
        <div className="settings-row">
          <div className="settings-label">
            <span>主题</span>
            <small>跟随系统时，切换 macOS 外观会立即同步</small>
          </div>
          <div className="seg">
            {(
              [
                ["system", "跟随系统"],
                ["light", "亮色"],
                ["dark", "暗色"],
              ] as Array<[ThemeChoice, string]>
            ).map(([value, label]) => (
              <button
                key={value}
                className={`seg-btn ${theme === value ? "on" : ""}`}
                onClick={() => {
                  setTheme(value);
                  setThemeChoice(value);
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        title="菜单栏"
        hint="控制菜单栏入口的样式与显示时机，保存后立即生效。"
      >
        <div className="settings-row">
          <div className="settings-label">
            <span>图标样式</span>
            <small>单色会跟随 macOS 菜单栏的浅色 / 深色外观</small>
          </div>
          <div className="seg">
            {(
              [
                ["monochrome", "单色"],
                ["color", "彩色"],
              ] as Array<[MenuBarSettings["icon_style"], string]>
            ).map(([value, label]) => (
              <button
                key={value}
                className={`seg-btn ${menuBar.icon_style === value ? "on" : ""}`}
                onClick={() => onMenuBarChange({ icon_style: value })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <Toggle
          label="常驻菜单栏"
          hint="关闭后仅在主窗口隐藏时显示，避免长期占用菜单栏空间"
          checked={menuBar.always_visible}
          onChange={(always_visible) => onMenuBarChange({ always_visible })}
        />
      </SettingsSection>

      <SettingsSection title="字体" hint="只影响桌面端界面，不修改 deveco 配置。">
        <div className="settings-row">
          <div className="settings-label">
            <span>界面字体</span>
            <small>从本机已安装字体中选择，默认跟随系统</small>
          </div>
          <div className="settings-select-wrap">
            <select
              className="settings-input settings-select wide"
              value={uiFont}
              disabled={fontsLoading}
              aria-label="界面字体"
              onChange={(event) => changeUIFont(event.target.value)}
            >
              <option value="">{fontsLoading ? "正在读取字体…" : "系统默认"}</option>
              {uiFontOptions.map((family) => (
                <option key={family} value={family}>
                  {family}
                </option>
              ))}
            </select>
            <Icon name="chevron-down" size={13} className="settings-select-caret" />
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-label">
            <span>代码字体</span>
            <small>用于代码块、路径和等宽信息，默认使用 SF Mono</small>
          </div>
          <div className="settings-select-wrap">
            <select
              className="settings-input settings-select wide"
              value={monoFont}
              disabled={fontsLoading}
              aria-label="代码字体"
              onChange={(event) => changeMonoFont(event.target.value)}
            >
              <option value="">{fontsLoading ? "正在读取字体…" : "系统默认"}</option>
              {monoFontOptions.map((family) => (
                <option key={family} value={family}>
                  {family}
                </option>
              ))}
            </select>
            <Icon name="chevron-down" size={13} className="settings-select-caret" />
          </div>
        </div>
        {fontError && (
          <p className="settings-inline-error">无法读取本机字体列表：{fontError}</p>
        )}
        <div className="settings-font-preview">
          <span>DevEco Code 字体预览</span>
          <code>const project = "HarmonyOS";</code>
        </div>
      </SettingsSection>
    </>
  );
}

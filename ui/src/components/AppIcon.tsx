import appIconUrl from "../assets/app-icon.png";

/**
 * 应用图标：启动页、欢迎页、助手头像和顶栏品牌位共用同一张资源。
 *
 * 这些位置都代表应用本身，不要再用字母、圆点或其它占位图形代替；
 * 图片由 `src-tauri/icons/source.png` 生成，和 Dock、托盘、安装包保持一致。
 */
export function AppIcon({
  size,
  className,
  alt = "",
}: {
  size: number;
  className?: string;
  alt?: string;
}) {
  return (
    <img
      className={className ? `app-icon ${className}` : "app-icon"}
      src={appIconUrl}
      width={size}
      height={size}
      alt={alt}
      draggable={false}
    />
  );
}

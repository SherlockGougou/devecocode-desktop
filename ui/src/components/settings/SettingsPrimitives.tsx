import type { ReactNode } from "react";

export function SettingsSection({
  title,
  hint,
  action,
  children,
}: {
  title?: string;
  hint?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section>
      {(title || action) && (
        <div className="settings-section-head">
          <div>
            {title && <h3>{title}</h3>}
            {hint && <p className="settings-section-hint">{hint}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Row({
  label,
  value,
  mono,
  title,
}: {
  label: string;
  value: string;
  mono?: boolean;
  title?: string;
}) {
  return (
    <div className="settings-row">
      <div className="settings-label">
        <span>{label}</span>
      </div>
      <div className={`settings-value ${mono ? "mono" : ""}`} title={title ?? value}>
        {value}
      </div>
    </div>
  );
}

export function Toggle({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className={`settings-row ${disabled ? "disabled" : ""}`}>
      <div className="settings-label">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </div>
      <button
        className={`switch ${checked ? "on" : ""}`}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        role="switch"
        aria-checked={checked}
        aria-label={label}
      >
        <span />
      </button>
    </div>
  );
}

export function Tag({
  children,
  tone,
}: {
  children: ReactNode;
  tone?: "ok" | "warn" | "danger" | "muted";
}) {
  return <span className={`settings-tag ${tone ?? "muted"}`}>{children}</span>;
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="settings-empty-state">{children}</div>;
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(value);
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

export function formatCost(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  return value < 0.01 ? value.toFixed(4) : value.toFixed(2);
}

export function compactPath(value: string, home?: string): string {
  if (home && value === home) return "~";
  if (home && value.startsWith(`${home}/`)) return `~/${value.slice(home.length + 1)}`;
  return value;
}

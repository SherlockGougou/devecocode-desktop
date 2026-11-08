import { useEffect, useState, type ReactNode } from "react";

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

export function TextField({
  label,
  hint,
  value,
  onChange,
  placeholder,
  type = "text",
  mono,
  disabled,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: "text" | "password" | "url";
  mono?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className={`settings-row ${disabled ? "disabled" : ""}`}>
      <div className="settings-label">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </div>
      <div className="settings-control inline">
        <input
          className={`settings-input wide ${mono ? "mono" : ""}`}
          type={type}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
    </div>
  );
}

export function NumberField({
  label,
  hint,
  value,
  onChange,
  min,
  max,
  placeholder,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  min?: number;
  max?: number;
  placeholder?: string;
}) {
  return (
    <div className="settings-row">
      <div className="settings-label">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </div>
      <div className="settings-control inline">
        <input
          className="settings-input narrow"
          type="number"
          min={min}
          max={max}
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
    </div>
  );
}

export function SelectField({
  label,
  hint,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  value: string;
  options: Array<{ label: string; value: string }>;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className={`settings-row ${disabled ? "disabled" : ""}`}>
      <div className="settings-label">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </div>
      <div className="settings-control inline">
        <select
          className="settings-input settings-select wide"
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

export function TextAreaField({
  label,
  hint,
  value,
  onChange,
  placeholder,
  rows = 4,
  mono = true,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  mono?: boolean;
}) {
  return (
    <div className="settings-stack-row">
      <div className="settings-label">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </div>
      <textarea
        className={`settings-textarea ${mono ? "mono" : ""}`}
        rows={rows}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

export function StringListEditor({
  label,
  hint,
  items,
  onChange,
  placeholder,
  addLabel = "添加",
  emptyText = "暂无条目",
}: {
  label: string;
  hint?: string;
  items: string[];
  onChange: (items: string[]) => void;
  placeholder?: string;
  addLabel?: string;
  emptyText?: string;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const value = draft.trim();
    if (!value) return;
    onChange([...items, value]);
    setDraft("");
  };
  return (
    <div className="settings-stack-row">
      <div className="settings-label">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </div>
      {items.length === 0 ? (
        <div className="settings-mini-empty">{emptyText}</div>
      ) : (
        <div className="settings-list">
          {items.map((item, index) => (
            <div className="settings-list-item" key={`${item}-${index}`}>
              <code>{item}</code>
              <button
                className="ghost-btn small danger-text"
                onClick={() => onChange(items.filter((_, itemIndex) => itemIndex !== index))}
              >
                删除
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="settings-inline-form">
        <input
          className="settings-input wide"
          value={draft}
          placeholder={placeholder}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          }}
        />
        <button className="ghost-btn" onClick={add} disabled={!draft.trim()}>
          {addLabel}
        </button>
      </div>
    </div>
  );
}

export function JsonFieldEditor({
  label,
  hint,
  value,
  onApply,
}: {
  label: string;
  hint?: string;
  value: unknown;
  onApply: (value: unknown) => void;
}) {
  const [draft, setDraft] = useState(() => JSON.stringify(value ?? null, null, 2));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(JSON.stringify(value ?? null, null, 2));
    setError(null);
  }, [value]);

  const apply = () => {
    try {
      const next = JSON.parse(draft);
      setError(null);
      onApply(next);
    } catch (err) {
      setError(`JSON 无法解析：${String(err)}`);
    }
  };

  return (
    <div className="settings-stack-row">
      <div className="settings-label">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </div>
      <textarea
        className="settings-textarea mono"
        rows={6}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      {error && <div className="settings-inline-error">{error}</div>}
      <div className="settings-actions">
        <button className="ghost-btn" onClick={apply}>
          应用 JSON
        </button>
        <button
          className="ghost-btn"
          onClick={() => {
            setDraft(JSON.stringify(value ?? null, null, 2));
            setError(null);
          }}
        >
          还原
        </button>
      </div>
    </div>
  );
}

export function FormModal({
  title,
  children,
  onClose,
  onSave,
  saving,
  saveLabel = "保存",
  error,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  onSave: () => void;
  saving?: boolean;
  saveLabel?: string;
  error?: string | null;
}) {
  return (
    <div className="settings-submodal-overlay" onClick={onClose}>
      <div
        className="settings-submodal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="settings-submodal-head">
          <h3>{title}</h3>
          <button className="settings-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>
        <div className="settings-submodal-body">{children}</div>
        {error && <div className="settings-inline-error">{error}</div>}
        <footer className="settings-submodal-foot">
          <button className="ghost-btn" onClick={onClose}>
            取消
          </button>
          <button className="primary-btn" onClick={onSave} disabled={saving}>
            {saving ? "处理中…" : saveLabel}
          </button>
        </footer>
      </div>
    </div>
  );
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

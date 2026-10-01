import { useState } from "react";
import { MoreIcon, PanelCloseIcon } from "./icons";
import type { MenuItem } from "./ContextMenu";

interface Props {
  title: string;
  subtitle?: string;
  menu?: MenuItem[];
  onClose: () => void;
  footer?: React.ReactNode;
  children: React.ReactNode;
}

/** The right-hand editor panel used by hosts, snippets and forwarding rules. */
export function DetailsPanel({ title, subtitle, menu, onClose, footer, children }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <aside className="details">
      <header className="details-head">
        <div>
          <h2>{title}</h2>
          {subtitle && <span className="muted small">{subtitle}</span>}
        </div>
        <div className="details-head-actions">
          {menu && menu.length > 0 && (
            <div className="menu-anchor">
              <button className="icon-btn" onClick={() => setMenuOpen((o) => !o)} title="More">
                <MoreIcon />
              </button>
              {menuOpen && (
                <div className="context-menu anchored" onMouseLeave={() => setMenuOpen(false)}>
                  {menu.map((item) => (
                    <button
                      key={item.label}
                      className={item.danger ? "danger" : ""}
                      onClick={() => {
                        setMenuOpen(false);
                        item.onClick();
                      }}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <button className="icon-btn" onClick={onClose} title="Close panel">
            <PanelCloseIcon />
          </button>
        </div>
      </header>
      <div className="details-body">{children}</div>
      {footer && <footer className="details-foot">{footer}</footer>}
    </aside>
  );
}

export function Section({ title, children }: { title?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="details-section">
      {title && <h3>{title}</h3>}
      {children}
    </section>
  );
}

/** An input with a leading icon, styled like Termius' fields. */
export function Field({
  icon,
  trailing,
  ...input
}: React.InputHTMLAttributes<HTMLInputElement> & { icon?: React.ReactNode; trailing?: React.ReactNode }) {
  return (
    <label className="field">
      {icon && <span className="field-icon">{icon}</span>}
      <input {...input} />
      {trailing}
    </label>
  );
}

import { useEffect, useState } from "react";

export interface MenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
}

export interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

/** Right-click menu; open it with `setMenu({ x, y, items })`. */
export function useContextMenu() {
  const [menu, setMenu] = useState<MenuState | null>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const open = (e: React.MouseEvent, items: MenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    // Keep the menu inside the window.
    const x = Math.min(e.clientX, window.innerWidth - 200);
    const y = Math.min(e.clientY, window.innerHeight - items.length * 34 - 16);
    setMenu({ x, y, items });
  };

  const element = menu && (
    <div className="context-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
      {menu.items.map((item) => (
        <button
          key={item.label}
          className={item.danger ? "danger" : ""}
          onClick={() => {
            setMenu(null);
            item.onClick();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );

  return { open, element };
}

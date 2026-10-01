import { ServerGlyph, TerminalIcon } from "./icons";

/** Badge colours per distribution id from /etc/os-release. */
const OS_COLORS: Record<string, string> = {
  ubuntu: "#e95420",
  debian: "#c70036",
  centos: "#932279",
  rhel: "#cc0000",
  rocky: "#10b981",
  almalinux: "#0f4266",
  fedora: "#3c6eb4",
  arch: "#1793d1",
  alpine: "#0d597f",
  opensuse: "#73ba25",
  "opensuse-leap": "#73ba25",
  amzn: "#ff9900",
  linuxmint: "#87cf3e",
  kali: "#367bf0",
  freebsd: "#ab2b28",
  darwin: "#8e8e93",
  local: "#475569",
};

const UNKNOWN = "#3d6bdc";

interface Props {
  os?: string | null;
  size?: number;
}

export function OsIcon({ os, size = 40 }: Props) {
  const color = (os && OS_COLORS[os]) || UNKNOWN;
  return (
    <span
      className="os-icon"
      style={{ width: size, height: size, background: color }}
      title={os === "local" ? "This computer" : (os ?? "Unknown OS — detected on first connect")}
    >
      {os === "local" ? (
        <TerminalIcon size={Math.round(size * 0.6)} strokeWidth={2} />
      ) : (
        <ServerGlyph size={Math.round(size * 0.55)} strokeWidth={2} />
      )}
    </span>
  );
}

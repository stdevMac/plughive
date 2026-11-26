// Plain-language wording for pack state and permissions.
import { t } from "../i18n";
import type { PackConsent, PackStatus, ToolInfo } from "./types";

/** The library permission value ("read", "read-all", ...) -> its message key. */
const LIBRARY_KEY: Record<string, string> = {
  read: "packs.library.read",
  "read-all": "packs.library.readAll",
  write: "packs.library.write",
  full: "packs.library.full",
};

export interface PermissionLine {
  icon: "link" | "terminal" | "file" | "sparkle" | "bolt" | "shield";
  text: string;
  risk?: boolean;
}

/** A permission line whose list is "{list}" or "{list} and {count} more" when long. */
function listed(base: string, items: string[], max = 4): string {
  if (items.length <= max) return t(`packs.permissions.${base}`, { list: items.join(", ") });
  return t(`packs.permissions.${base}More`, {
    list: items.slice(0, max).join(", "),
    count: items.length - max,
  });
}

export function describePermissions(p: PackStatus["permissions"] | undefined): PermissionLine[] {
  if (!p) return [];
  const out: PermissionLine[] = [];
  const network = Array.isArray(p.network) ? p.network : [];
  const local = Array.isArray(p.localNetwork) ? p.localNetwork : [];
  const spawn = Array.isArray(p.spawn) ? p.spawn : [];
  const tools = Array.isArray(p.tools) ? p.tools : [];
  if (network.includes("*"))
    out.push({ icon: "link", text: t("packs.permissions.networkAny"), risk: true });
  else if (network.length > 0) out.push({ icon: "link", text: listed("network", network) });
  if (local.length > 0)
    out.push({
      icon: "link",
      text: listed("local", local),
    });
  if (spawn.length > 0)
    out.push({
      icon: "terminal",
      text: listed("spawn", spawn),
      risk: true,
    });
  if (p.userHome === true)
    out.push({
      icon: "file",
      text: t("packs.permissions.userHome"),
      risk: true,
    });
  const lib =
    typeof p.library === "string"
      ? p.library
      : Array.isArray(p.library)
        ? p.library.length
          ? "read"
          : "none"
        : p.library === true
          ? "full"
          : "none";
  const libKey = LIBRARY_KEY[lib];
  if (libKey) out.push({ icon: "file", text: t(libKey) });
  if (p.llm === true) out.push({ icon: "sparkle", text: t("packs.permissions.llm") });
  if (tools.length > 0) out.push({ icon: "bolt", text: listed("tools", tools) });
  if (out.length === 0)
    out.push({
      icon: "shield",
      text: t("packs.permissions.none"),
    });
  return out;
}

export function packStateLabel(p: Pick<PackStatus, "enabled" | "state">): {
  text: string;
  tone: "ok" | "warn" | "danger" | "neutral";
} {
  if (!p.enabled || p.state === "disabled") return { text: t("packs.state.off"), tone: "neutral" };
  switch (p.state) {
    case "loaded":
      return { text: t("packs.state.on"), tone: "ok" };
    case "needs-review":
      return { text: t("packs.state.needsReview"), tone: "warn" };
    case "invalid":
      return { text: t("packs.state.invalid"), tone: "danger" };
    case "failed":
      return { text: t("packs.state.failedLoad"), tone: "danger" };
    default:
      return { text: p.state, tone: "neutral" };
  }
}

export const isBundled = (p: Pick<PackStatus, "source">) => p.source === "builtin";

export type ConsentSecret = PackConsent["secrets"][number];

/** Initial secret checkboxes in the consent dialog: never pre-select non-grantable secrets. */
export function initialConsentGrants(secrets: readonly ConsentSecret[]): Set<string> {
  return new Set(
    secrets.filter((s) => s.grantable !== false && (s.granted || s.required)).map((s) => s.name),
  );
}

/** Toggle a secret grant in the consent dialog, refusing non-grantable secrets. */
export function toggleConsentGrant(
  grants: ReadonlySet<string>,
  secret: ConsentSecret,
  checked: boolean,
): Set<string> {
  const next = new Set(grants);
  if (secret.grantable === false || !checked) {
    next.delete(secret.name);
  } else {
    next.add(secret.name);
  }
  return next;
}

/** Whether a tool in the Playground should ask for confirmation before running. */
export function toolNeedsConfirm(tool: Pick<ToolInfo, "annotations" | "tags">): boolean {
  return tool.annotations?.destructiveHint === true || tool.tags.includes("sends");
}

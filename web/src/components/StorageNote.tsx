// Where provider keys are kept, in plain words. Two states get a real warning:
// memory (keys are gone after a restart) and a file that is not encrypted.
import { t } from "../i18n";
import { useApp } from "../lib/app-context";
import type { SecretStorage } from "../lib/types";
import { InlineAlert } from "./ui";

const DEFAULT_KEYCHAIN_SERVICE = "plughive";

function secretsFile(dataDir: string | null | undefined): string {
  return dataDir ? `${dataDir}/secrets.json` : t("packs.storage.secretsFileFallback");
}

/**
 * The storage state, from /api/info when the daemon reports it. Older daemons
 * only report the backend; a file is then of unknown encryption (null).
 */
export function storageState(
  backend: string | null | undefined,
  storage: SecretStorage | null | undefined,
): SecretStorage | null {
  if (storage) return storage;
  if (backend === "keychain" || backend === "keyring" || backend === "memory") return backend;
  return null;
}

export function storageWords(
  backend: string | null | undefined,
  dataDir: string | null | undefined,
  storage?: SecretStorage | null,
  keychainService?: string | null,
): string {
  switch (storageState(backend, storage)) {
    case "keychain":
      return keychainService && keychainService !== DEFAULT_KEYCHAIN_SERVICE
        ? t("packs.storage.words.keychainService", { service: keychainService })
        : t("packs.storage.words.keychain");
    case "keyring":
      return t("packs.storage.words.keyring");
    case "file-encrypted":
      return t("packs.storage.words.fileEncrypted", { file: secretsFile(dataDir) });
    case "file-plain":
      return t("packs.storage.words.filePlain", { file: secretsFile(dataDir) });
    case "memory":
      return t("packs.storage.words.memory");
    default:
      if (backend === "file") {
        return t("packs.storage.words.fileUnknown", { file: secretsFile(dataDir) });
      }
      return backend
        ? t("packs.storage.words.daemonBackend", { backend })
        : t("packs.storage.words.daemon");
  }
}

/** A short label for a settings table. */
export function storageLabel(
  backend: string | null | undefined,
  storage?: SecretStorage | null,
): string | null {
  switch (storageState(backend, storage)) {
    case "keychain":
      return t("packs.storage.label.keychain");
    case "keyring":
      return t("packs.storage.label.keyring");
    case "file-encrypted":
      return t("packs.storage.label.fileEncrypted");
    case "file-plain":
      return t("packs.storage.label.filePlain");
    case "memory":
      return t("packs.storage.label.memory");
    default:
      return null;
  }
}

export function StorageNote({ backend }: { backend: string | null | undefined }) {
  const { info } = useApp();
  const state = storageState(backend, info?.secrets_storage);
  if (state === "memory") {
    return (
      <InlineAlert tone="warn" title={t("packs.storage.memoryAlertTitle")}>
        {t("packs.storage.memoryNote.beforeKeychain")}
        <code>PLUGHIVE_SECRETS=keychain</code>
        {t("packs.storage.memoryNote.macos")}
        <code>PLUGHIVE_SECRETS=keyring</code>
        {t("packs.storage.memoryNote.windowsLinux")}
        <code>PLUGHIVE_SECRETS=file</code>
        {t("packs.storage.memoryNote.afterFile")}
        <code>PLUGHIVE_SECRETS_PASSPHRASE</code>
        {t("packs.storage.memoryNote.toEncrypt")}
      </InlineAlert>
    );
  }
  if (state === "file-plain") {
    return (
      <InlineAlert tone="warn" title={t("packs.storage.plainAlertTitle")}>
        {storageWords(backend, info?.data_dir, state)}
        {t("packs.storage.plainNote.afterWords")}
        <code>PLUGHIVE_SECRETS=keychain</code>
        {t("packs.storage.plainNote.afterKeychain")}
        <code>PLUGHIVE_SECRETS=keyring</code>
        {t("packs.storage.plainNote.afterKeyring")}
        <code>PLUGHIVE_SECRETS_PASSPHRASE</code>
        {t("packs.storage.plainNote.afterPassphrase")}
      </InlineAlert>
    );
  }
  return (
    <p className="small muted storage-note">
      {storageWords(backend, info?.data_dir, state, info?.secrets_keychain_service)}{" "}
      {t("packs.storage.savedKeyNeverShown")}
    </p>
  );
}

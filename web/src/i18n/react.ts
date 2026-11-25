import { useSyncExternalStore } from "react";
import { getLocale, subscribeLocale } from "./index";

/** The current language; components using it re-render when it changes. */
export function useLocale(): string {
  return useSyncExternalStore(subscribeLocale, getLocale, getLocale);
}

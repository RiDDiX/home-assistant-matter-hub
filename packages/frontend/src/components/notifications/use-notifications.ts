import { useContext } from "react";
import { NotificationsContext } from "./notifications-context.ts";

export function useNotifications() {
  // Stable identity: pages list this in effect deps.
  return useContext(NotificationsContext);
}

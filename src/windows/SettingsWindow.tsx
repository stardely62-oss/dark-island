import { useEffect, useState } from "react";
import { bridge, type Bridge } from "../ipc";
import { applyTheme, useSettings } from "../settings";
import { SettingsTab } from "../panels/Settings";
import { buddy } from "../components/Buddy";

import { t } from "../i18n";
/**
 * The settings in a window of their own: sections on the left, the chosen
 * one on the right. Changes go to the island at once.
 */
export function SettingsWindow() {
  const [api, setApi] = useState<Bridge | null>(null);
  useEffect(() => {
    bridge.then(setApi);
  }, []);
  const [settings, set] = useSettings(api);
  useEffect(() => applyTheme((settings.islandTheme as string) ?? "dark"), [settings.islandTheme]);
  // Клодик in the previews looks like the one on the island.
  useEffect(
    () =>
      buddy.configure({
        life: settings.buddyLife,
        color: settings.buddyColor,
        hat: settings.buddyHat,
        name: settings.buddyName || t("Клодик"),
        sounds: false,
      }),
    [settings.buddyLife, settings.buddyColor, settings.buddyHat, settings.buddyName],
  );
  // A section asked for by the island ("Добавить ключ" → ИИ).
  useEffect(() => {
    const open = (name: string) => window.setTimeout(() => window.dispatchEvent(new CustomEvent("settings-section", { detail: name })), 80);
    const first = new URLSearchParams(location.search).get("section");
    if (first) open(first);
    return api?.on("settings_section", open);
  }, [api]);
  return (
    <div className="settings-window">
      <SettingsTab api={api} settings={settings} set={set} visible onTypeStart={() => {}} />
    </div>
  );
}

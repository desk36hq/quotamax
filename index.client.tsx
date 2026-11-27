import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import React from "react";
import { Platform } from "react-native";
import { QuotaAdvisorPanel } from "./client/panel";
import { QuotaAdvisorSettings } from "./client/settings";

const PANEL_ID = "quotamax";
const SCREEN_ID = "quotamax";
const SETTINGS_ID = "settings";

function QuotaSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="Gauge"
      active={currentScreen?.screenId === SCREEN_ID}
      onPress={() => openScreen({ screenId: SCREEN_ID })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  const defaultLocation = Platform.OS === "web" ? "explorer" : "workspace";

  const stopPanel = client.addWorkspacePanel({
    id: PANEL_ID,
    title: "QuotaMax",
    icon: "Gauge",
    locations: ["explorer", "workspace"],
    Component: (props) => (
      <QuotaAdvisorPanel {...props} openSettings={() => client.openSettings(SETTINGS_ID)} />
    ),
  });

  // Global screen + sidebar item so mobile users can open QuotaMax in 1 tap from the sidebar drawer
  const stopScreen = client.addScreen({
    id: SCREEN_ID,
    title: "QuotaMax",
    Component: (props) => (
      <QuotaAdvisorPanel theme={props.theme} openSettings={() => client.openSettings(SETTINGS_ID)} />
    ),
  });

  const stopSidebarItem = client.addSidebarHeaderItem({
    id: "quotamax-nav",
    title: "QuotaMax",
    Component: QuotaSidebarItem,
  });

  const stopCommand = client.addCommandCenterItem({
    id: "open-quotamax",
    title: "Open QuotaMax",
    icon: "Gauge",
    keywords: ["quotamax", "quota", "usage", "models", "burn", "limits", "tokens", "cost"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel(PANEL_ID, { location: defaultLocation });
    },
  });

  const stopSettings = client.addSettingsScreen({
    id: SETTINGS_ID,
    title: "QuotaMax",
    icon: "Settings",
    Component: QuotaAdvisorSettings,
  });

  return () => {
    void stopSettings();
    void stopCommand();
    void stopSidebarItem();
    void stopScreen();
    void stopPanel();
  };
}

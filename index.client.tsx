import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import React from "react";
import { Platform } from "react-native";
import { QuotaAdvisorPanel } from "./client/panel";
import { QuotaAdvisorSettings } from "./client/settings";

const PANEL_ID = "quota-advisor";
const SCREEN_ID = "quota-advisor";
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
    title: "Quota",
    icon: "Gauge",
    locations: ["explorer", "workspace"],
    Component: (props) => (
      <QuotaAdvisorPanel {...props} openSettings={() => client.openSettings(SETTINGS_ID)} />
    ),
  });

  // Global screen + sidebar item so mobile users can open Quota Advisor in 1 tap from the sidebar drawer
  const stopScreen = client.addScreen({
    id: SCREEN_ID,
    title: "Quota Advisor",
    Component: (props) => (
      <QuotaAdvisorPanel theme={props.theme} openSettings={() => client.openSettings(SETTINGS_ID)} />
    ),
  });

  const stopSidebarItem = client.addSidebarHeaderItem({
    id: "quota-advisor-nav",
    title: "Quota Advisor",
    Component: QuotaSidebarItem,
  });

  const stopCommand = client.addCommandCenterItem({
    id: "open-quota-advisor",
    title: "Open Quota Advisor",
    icon: "Gauge",
    keywords: ["quota", "usage", "models", "burn", "limits", "tokens"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel(PANEL_ID, { location: defaultLocation });
    },
  });

  const stopSettings = client.addSettingsScreen({
    id: SETTINGS_ID,
    title: "Quota Advisor",
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

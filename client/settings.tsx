import {
  type PluginSurfaceProps,
  openExternalUrl,
  useRpc,
  useSettings,
} from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsSection } from "@getpaseo/plugin/client/ui";
import React, { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Switch, Text, TextInput, View } from "react-native";
import { type SyncAaResult, syncAaRpc } from "../shared/contract";
import { advisorSettings } from "../shared/settings";

export function QuotaAdvisorSettings({ theme }: PluginSurfaceProps) {
  const colors = theme.colors;
  const settings = useSettings(advisorSettings);
  const runSyncAa = useRpc(syncAaRpc);

  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [revealKey, setRevealKey] = useState(false);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncAaResult | null>(null);

  useEffect(() => {
    if (settings.status === "ready") {
      setApiKeyDraft(settings.values.aaApiKey);
    }
  }, [settings.status, settings.status === "ready" ? settings.values.aaApiKey : ""]);

  const muted = { color: colors.foregroundMuted, fontSize: 12.5, lineHeight: 18 };

  if (settings.status === "loading") {
    return (
      <View style={{ padding: 16 }}>
        <Text style={muted}>Loading Quota Advisor settings…</Text>
      </View>
    );
  }

  if (settings.status !== "ready") {
    return (
      <SettingsSection title="Artificial Analysis">
        <Text style={muted}>{settings.error}</Text>
        <SettingsCard>
          <SettingsAction label="Try again" actionLabel="Reload" onPress={settings.reload} />
          {settings.status === "invalid" ? (
            <SettingsAction label="Reset to defaults" actionLabel="Reset" onPress={settings.reset} />
          ) : null}
        </SettingsCard>
      </SettingsSection>
    );
  }

  const dirty = apiKeyDraft.trim() !== settings.values.aaApiKey;

  const handleSaveKey = async () => {
    setSavedNotice(null);
    const ok = await settings.save(
      { ...settings.values, aaApiKey: apiKeyDraft.trim() },
      settings.revision
    );
    if (ok) {
      setSavedNotice(apiKeyDraft.trim() ? "API key saved locally on this host." : "API key cleared.");
    }
  };

  const handleToggleRecalibrate = (recalibrateOnSync: boolean) => {
    void settings.save({ ...settings.values, recalibrateOnSync }, settings.revision);
  };

  const handleSyncNow = async () => {
    if (syncing) return;
    if (dirty) {
      await handleSaveKey();
    }
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await runSyncAa({ recalibrate: settings.values.recalibrateOnSync });
      setSyncResult(res);
    } catch (err) {
      setSyncResult({
        ok: false,
        matched: 0,
        total: 0,
        updatedAt: "-",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSyncing(false);
    }
  };

  return (
    <SettingsSection title="Artificial Analysis Benchmarks">
      <SettingsCard>
        <View style={{ padding: 12, gap: 10 }}>
          <View style={{ gap: 3 }}>
            <Text style={{ color: colors.foreground, fontSize: 13.5, fontWeight: "600" }}>
              Artificial Analysis API Key
            </Text>
            <Text style={muted}>
              Stored locally in Paseo plugin settings on this host. Used to pull live Intelligence Index, Coding Index, and pricing into your shared models.json catalog.
            </Text>
          </View>

          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <TextInput
              value={apiKeyDraft}
              onChangeText={setApiKeyDraft}
              placeholder="Paste free API key from artificialanalysis.ai/insights"
              placeholderTextColor={colors.foregroundMuted}
              secureTextEntry={!revealKey}
              autoCapitalize="none"
              autoCorrect={false}
              style={{
                flex: 1,
                color: colors.foreground,
                backgroundColor: colors.surface0,
                borderWidth: 1,
                borderColor: colors.border,
                borderRadius: 8,
                paddingHorizontal: 10,
                paddingVertical: 8,
                fontSize: 13,
              }}
            />
            <Pressable
              onPress={() => setRevealKey((v) => !v)}
              style={{
                paddingHorizontal: 10,
                paddingVertical: 8,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.surface2,
              }}
            >
              <Text style={{ color: colors.foreground, fontSize: 12, fontWeight: "600" }}>
                {revealKey ? "Hide" : "Show"}
              </Text>
            </Pressable>
          </View>

          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <Pressable
              onPress={() => void handleSaveKey()}
              disabled={settings.saving || !dirty}
              style={{
                paddingHorizontal: 12,
                paddingVertical: 7,
                borderRadius: 8,
                backgroundColor: dirty ? colors.accent : colors.surface2,
                opacity: settings.saving || !dirty ? 0.6 : 1,
              }}
            >
              <Text
                style={{
                  color: dirty ? colors.accentForeground : colors.foregroundMuted,
                  fontSize: 12.5,
                  fontWeight: "600",
                }}
              >
                {settings.saving ? "Saving…" : "Save Key"}
              </Text>
            </Pressable>

            <Pressable
              onPress={() => void handleSyncNow()}
              disabled={syncing}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                paddingHorizontal: 12,
                paddingVertical: 7,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.surface2,
                opacity: syncing ? 0.7 : 1,
              }}
            >
              {syncing ? <ActivityIndicator size="small" color={colors.foreground} /> : null}
              <Text style={{ color: colors.foreground, fontSize: 12.5, fontWeight: "600" }}>
                {syncing ? "Syncing…" : "Sync AA Now"}
              </Text>
            </Pressable>

            <Pressable
              onPress={() => void openExternalUrl("https://artificialanalysis.ai/insights")}
              style={{ paddingHorizontal: 6, paddingVertical: 7 }}
            >
              <Text style={{ color: colors.accent, fontSize: 12.5, fontWeight: "600" }}>
                Get free key ↗
              </Text>
            </Pressable>
          </View>

          {settings.saveError ? (
            <Text style={{ color: colors.statusDanger, fontSize: 12 }}>{settings.saveError}</Text>
          ) : null}
          {savedNotice ? (
            <Text style={{ color: colors.statusSuccess, fontSize: 12 }}>{savedNotice}</Text>
          ) : null}
          {syncResult ? (
            <Text
              style={{
                color: syncResult.ok ? colors.statusSuccess : colors.statusDanger,
                fontSize: 12,
                lineHeight: 17,
              }}
            >
              {syncResult.message}
            </Text>
          ) : null}
        </View>

        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            padding: 12,
            borderTopWidth: 1,
            borderTopColor: colors.border,
            gap: 12,
          }}
        >
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: "600" }}>
              Recalibrate IQ &amp; Efficiency scores on sync
            </Text>
            <Text style={muted}>
              When on, Sync AA updates each matched model&apos;s intelligence, coding, and efficiency scores from AA&apos;s live index and blended price.
            </Text>
          </View>
          <Switch
            value={settings.values.recalibrateOnSync}
            disabled={settings.saving}
            onValueChange={handleToggleRecalibrate}
          />
        </View>
      </SettingsCard>
    </SettingsSection>
  );
}

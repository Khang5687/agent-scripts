import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsInput, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { type Appearance, installSkin, listCatalog, removeSkin } from "../shared/rpc";
import { isPermissiveLicense } from "../shared/license";
import { type CardBusy, CatalogCard } from "./catalog-card";
import type { SkinRegistry } from "./registry";
import { useCatalogStyles } from "./styles";

const PAGE_SIZE = 12;
const SEARCH_DEBOUNCE_MS = 250;

type AppearanceFilter = Appearance | "all";
const FILTERS: ReadonlyArray<{ value: AppearanceFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createCatalogScreen(registry: SkinRegistry) {
  return function SkinCatalogScreen({ theme, layout }: PluginSurfaceProps) {
    const styles = useCatalogStyles(theme);
    const toast = useToast();
    const queryClient = useQueryClient();
    const fetchCatalog = useRpc(listCatalog);
    const install = useRpc(installSkin);
    const remove = useRpc(removeSkin);

    const [search, setSearch] = useState("");
    const [query, setQuery] = useState("");
    const [appearance, setAppearance] = useState<AppearanceFilter>("all");
    const [showAll, setShowAll] = useState(false);
    const [page, setPage] = useState(1);
    const [busy, setBusy] = useState<Record<string, Exclude<CardBusy, null>>>({});

    useEffect(() => {
      const timer = setTimeout(() => setQuery(search.trim()), SEARCH_DEBOUNCE_MS);
      return () => clearTimeout(timer);
    }, [search]);
    useEffect(() => setPage(1), [query, appearance, showAll]);

    const licenseFilter = showAll ? "all" : "permissive";
    const catalog = useQuery({
      queryKey: ["paseo-skins", "catalog", { query, appearance, licenseFilter, page }],
      queryFn: () =>
        fetchCatalog({
          query: query || undefined,
          appearance: appearance === "all" ? undefined : appearance,
          licenseFilter,
          page,
          pageSize: PAGE_SIZE,
        }),
      placeholderData: keepPreviousData,
      retry: false,
    });

    const setCardBusy = (id: string, state: CardBusy) =>
      setBusy((current) => {
        const next = { ...current };
        if (state) next[id] = state;
        else delete next[id];
        return next;
      });
    const refreshCatalog = () => queryClient.invalidateQueries({ queryKey: ["paseo-skins", "catalog"] });

    async function useSkin(id: string, name: string) {
      setCardBusy(id, "applying");
      try {
        await registry.apply(id);
        toast.show(`Now using ${name}`, { variant: "success" });
      } catch (error) {
        toast.error(`Could not apply ${name}: ${errorMessage(error)}`);
      } finally {
        setCardBusy(id, null);
      }
    }

    async function installAndUse(id: string, name: string) {
      setCardBusy(id, "installing");
      try {
        registry.register(await install({ id }));
        await refreshCatalog();
      } catch (error) {
        toast.error(`Could not install ${name}: ${errorMessage(error)}`);
        setCardBusy(id, null);
        return;
      }
      setCardBusy(id, "applying");
      try {
        await registry.apply(id);
        toast.show(`Installed and using ${name}`, { variant: "success" });
      } catch (error) {
        toast.error(`Installed ${name}, but could not apply it: ${errorMessage(error)}`);
      } finally {
        setCardBusy(id, null);
      }
    }

    async function removeSkinCard(id: string, name: string) {
      setCardBusy(id, "removing");
      try {
        await remove({ id });
        registry.unregister(id);
        await refreshCatalog();
        toast.show(`Removed ${name}`);
      } catch (error) {
        toast.error(`Could not remove ${name}: ${errorMessage(error)}`);
      } finally {
        setCardBusy(id, null);
      }
    }

    const data = catalog.data;
    return (
      <View style={{ gap: layout.compact ? 16 : 24 }}>
        <SettingsSection title="Skin catalog">
          <SettingsInput
            label="Search"
            placeholder="Name, author, or tag"
            initialValue=""
            onChangeText={setSearch}
          />
          <View style={[styles.row, { paddingHorizontal: layout.compact ? 12 : 16, paddingVertical: 10 }]}>
            {FILTERS.map((filter) => (
              <Pressable
                key={filter.value}
                accessibilityRole="button"
                accessibilityState={{ selected: appearance === filter.value }}
                onPress={() => setAppearance(filter.value)}
                style={styles.chip(appearance === filter.value)}
              >
                <Text style={styles.chipText(appearance === filter.value)}>{filter.label}</Text>
              </Pressable>
            ))}
          </View>
          <SettingsSwitch
            label="Show all licenses"
            hint="Many catalog images are personal-use or all-rights-reserved; only install art you may use."
            value={showAll}
            onValueChange={setShowAll}
          />
        </SettingsSection>

        {catalog.isError && !data ? (
          <Text style={styles.danger}>{errorMessage(catalog.error)}</Text>
        ) : !data ? (
          <Text style={styles.muted}>Loading catalog…</Text>
        ) : (
          <View style={{ gap: 12 }}>
            {data.stale ? (
              <Text style={styles.small}>Offline: showing a saved copy of the catalog.</Text>
            ) : null}
            {data.entries.length === 0 ? (
              <Text style={styles.muted}>No skins match.</Text>
            ) : (
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
                {data.entries.map((entry) => (
                  <View key={entry.id} style={{ width: layout.compact ? "100%" : "48%", flexGrow: 1 }}>
                    <CatalogCard
                      entry={entry}
                      permissive={isPermissiveLicense(entry.license)}
                      busy={busy[entry.id] ?? null}
                      theme={theme}
                      onInstall={() => void installAndUse(entry.id, entry.name)}
                      onUse={() => void useSkin(entry.id, entry.name)}
                      onRemove={() => void removeSkinCard(entry.id, entry.name)}
                    />
                  </View>
                ))}
              </View>
            )}
            <View style={[styles.row, { justifyContent: "space-between" }]}>
              <Pressable
                accessibilityRole="button"
                disabled={data.page <= 1}
                onPress={() => setPage(data.page - 1)}
                style={styles.button("secondary", data.page <= 1)}
              >
                <Text style={styles.buttonText("secondary")}>Previous</Text>
              </Pressable>
              <Text style={styles.small}>
                Page {data.page} of {data.pageCount} · {data.total} skins
              </Text>
              <Pressable
                accessibilityRole="button"
                disabled={data.page >= data.pageCount}
                onPress={() => setPage(data.page + 1)}
                style={styles.button("secondary", data.page >= data.pageCount)}
              >
                <Text style={styles.buttonText("secondary")}>Next</Text>
              </Pressable>
            </View>
          </View>
        )}
      </View>
    );
  };
}

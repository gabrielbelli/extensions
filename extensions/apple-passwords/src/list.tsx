import {
  Action,
  ActionPanel,
  Clipboard,
  Color,
  getFrontmostApplication,
  Icon,
  LaunchProps,
  Image,
  LaunchType,
  List,
  launchCommand,
  showHUD,
  showToast,
  Toast,
} from "@raycast/api";
import { useEffect, useRef, useState } from "react";
import { favicons } from "./browser-data";
import {
  APWEntry,
  APWIndexEntry,
  getActiveURL,
  getAPWEntry,
  searchAPWEntries,
  PREFERENCES,
  searchIndex,
} from "./utils";

const renderAction = (
  action: "pw" | "otp" | "usr",
  domain: string,
  username: string,
  pasteTarget?: string,
  onAction?: () => void,
) => {
  const fullAction = action === "pw" ? "Password" : action === "usr" ? "Username" : "OTP";
  const verb = PREFERENCES.copySecrets ? "Copy" : "Paste";
  const title = PREFERENCES.copySecrets
    ? `Copy ${fullAction}`
    : pasteTarget
      ? `Paste ${fullAction} to ${pasteTarget}`
      : `Paste ${fullAction}`;
  const hudText = PREFERENCES.copySecrets
    ? `${fullAction} copied to clipboard`
    : pasteTarget
      ? `${fullAction} pasted to ${pasteTarget}`
      : `${fullAction} inserted at cursor`;
  const copyToClipboard = async () => {
    try {
      let secretEntry;
      if (action !== "usr") {
        secretEntry = await getAPWEntry(domain, action, username);
      }
      const value = action === "pw" ? secretEntry?.password : action === "usr" ? username : secretEntry?.code;
      if (value) {
        if (PREFERENCES.copySecrets) {
          await Clipboard.copy(value, { concealed: true });
        } else {
          await Clipboard.paste(value);
        }
        showHUD(hudText);
      } else {
        showToast({ style: Toast.Style.Failure, title: "No value found" });
      }
      onAction?.();
    } catch (error) {
      console.error("Error retrieving secret: ", error);
      showToast({
        style: Toast.Style.Failure,
        title: `Failed to ${verb.toLowerCase()} ${fullAction.toLowerCase()}`,
        message: error instanceof Error ? error.message : undefined,
      });
    }
  };
  return (
    <Action
      key={action}
      title={title}
      onAction={copyToClipboard}
      shortcut={action == "otp" ? { modifiers: ["cmd", "shift"], key: "return" } : undefined}
    />
  );
};

/** The hostname a row represents, which is what its icon should reflect. */
const iconKey = (entry: { domain: string; sites?: string[] }): string =>
  (entry.sites?.find((s) => s && !s.includes(":")) ?? entry.domain ?? "").toLowerCase();

const renderItem = (entry: APWEntry, pasteTarget?: string, index = 0, icon: Image.ImageLike = Icon.PersonCircle) => {
  const accessories = [];
  const actions = [];
  actions.push(renderAction("usr", entry.domain, entry.username, pasteTarget));
  actions.push(renderAction("pw", entry.domain, entry.username, pasteTarget));
  if (entry.hasOtp) {
    accessories.push({ tag: { value: "OTP", color: Color.Green } });
    actions.push(renderAction("otp", entry.domain, entry.username, pasteTarget));
  }
  accessories.push({ icon: { source: Icon.Key, tintColor: Color.Blue } });
  const title = entry.title ?? entry.username;
  const site = entry.highLevelDomain ?? entry.domain;
  const subtitle = entry.title ? `${entry.username} · ${site}` : site;
  return (
    <List.Item
      key={`item-${index}`}
      title={title}
      subtitle={subtitle}
      icon={icon}
      actions={<ActionPanel children={actions} />}
      accessories={accessories}
    />
  );
};

export default function Command(props: LaunchProps<{ arguments: Arguments.List }>) {
  const [url, setUrl] = useState<string>(props.arguments.url || "");
  const [searchTxt, setSearchTxt] = useState<string>(props.arguments.url || "");
  const [data, setData] = useState<APWEntry[]>([]);
  const [indexResults, setIndexResults] = useState<APWIndexEntry[]>([]);
  const [pasteTarget, setPasteTarget] = useState<string | undefined>();
  const [icons, setIcons] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(false);
  const autoDetectDone = useRef(!!props.arguments.url);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (PREFERENCES.copySecrets) return;
    getFrontmostApplication()
      .then((app) => setPasteTarget(app.name))
      .catch(() => {});
  }, []);

  // Icons come from the browser's own favicon cache. Asking a favicon service
  // instead would disclose the user's account list to a third party.
  useEffect(() => {
    const wanted = [...new Set([...data.map(iconKey), ...indexResults.map(iconKey)])].filter(Boolean);
    if (!wanted.length) return;
    let active = true;
    favicons(wanted)
      .then((found) => active && found.size && setIcons((prev) => new Map([...prev, ...found])))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [data, indexResults]);

  const iconFor = (entry: { domain: string; sites?: string[] }, fallback: Image.ImageLike): Image.ImageLike => {
    const uri = icons.get(iconKey(entry));
    return uri ? { source: uri } : fallback;
  };

  const handleSearchTextChange = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) {
      setIndexResults([]);
      setData([]);
      setUrl("");
      return;
    }
    setIndexResults(searchIndex(trimmed));
    setUrl(trimmed);
  };

  const handleDebouncedSearchTextChange = (text: string) => {
    setSearchTxt(text);
    clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      handleSearchTextChange(text);
    }, 300);
  };

  useEffect(() => {
    let active = true;

    const loadData = async () => {
      let targetUrl = url;
      setLoading(true);
      if (!targetUrl) {
        if (autoDetectDone.current) return;
        targetUrl = await getActiveURL();
        autoDetectDone.current = true;
        if (!active || !targetUrl) return;
      }

      try {
        const data = await searchAPWEntries(targetUrl);
        if (active) {
          setSearchTxt(targetUrl);
          setData(data);
        }
      } catch (error) {
        if (!active) return;
        setData([]);
        if ((error as { apwStatus?: number }).apwStatus === 9) {
          await launchCommand({ name: "auth", type: LaunchType.UserInitiated, context: { returnUrl: targetUrl } });
          return;
        }
        showToast({
          style: Toast.Style.Failure,
          title: "APW Error",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      } finally {
        if (active) setLoading(false);
      }
    };

    loadData();
    return () => {
      active = false;
    };
  }, [url]);
  return (
    <List
      isLoading={loading}
      searchText={searchTxt}
      onSearchTextChange={handleDebouncedSearchTextChange}
      filtering={false}
    >
      {data.map((entry, i) => renderItem(entry, pasteTarget, i, iconFor(entry, Icon.PersonCircle)))}
      {data.length === 0 && indexResults.length > 0 && (
        <List.Section title="Seen before">
          {indexResults.map((e, i) => (
            <List.Item
              key={`idx-${i}`}
              title={e.title ?? e.username}
              subtitle={e.title ? `${e.username} · ${e.domain}` : e.domain}
              icon={iconFor(e, Icon.MagnifyingGlass)}
              accessories={[
                ...(e.hasOtp ? [{ tag: { value: "OTP", color: Color.Green } }] : []),
                { icon: { source: Icon.Key, tintColor: Color.Blue } },
              ]}
              actions={
                <ActionPanel>
                  <Action
                    title={`Search ${e.domain}`}
                    icon={Icon.MagnifyingGlass}
                    onAction={() => {
                      setSearchTxt(e.domain);
                      setIndexResults([]);
                      setUrl(e.domain);
                    }}
                  />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}
      {!loading && searchTxt.trim() !== "" && data.length === 0 && indexResults.length === 0 && (
        <List.EmptyView icon={Icon.QuestionMark} title={`No saved password for ${searchTxt.trim()}`} />
      )}
    </List>
  );
}

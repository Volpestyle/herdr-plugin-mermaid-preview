import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import * as herdr from "herdr";

const {
  agents,
  appHome,
  closeOverlay,
  commands,
  exec,
  focused,
  home,
  notify,
  panes,
  props,
  readTextFile,
  run,
  spaces,
  terminals,
  theme,
} = herdr;

const SOURCES = [
  { id: "mermaid", label: "Mermaid diagrams", short: "Mermaid" },
  { id: "images", label: "Transcript images", short: "Images" },
];

const PLACEMENTS = [
  { id: "tab", label: "Tab" },
  { id: "right", label: "Split right" },
  { id: "down", label: "Split down" },
];

function isChecking() {
  return typeof herdr.checking === "function" && herdr.checking();
}

function isSupportedAgent(terminal, agentEntry) {
  const app = (
    agentEntry?.app ||
    terminal?.report?.app ||
    terminal?.status?.app ||
    terminal?.labels?.["herdr.agent"] ||
    terminal?.labels?.["clankie.agent"] ||
    ""
  ).toLowerCase();
  if (app === "claude" || app === "claude-code" || app === "claude_code") return "claude";
  if (app === "codex" || app === "codex-cli" || app === "codex-tui") return "codex";

  const argv = [...(terminal?.foreground?.argv || []), ...(terminal?.argv || [])];
  for (const token of argv) {
    if (typeof token !== "string") continue;
    const lower = token.toLowerCase();
    if (
      lower === "claude" ||
      lower.endsWith("/claude") ||
      lower.includes("/.local/share/claude/versions/")
    ) {
      return "claude";
    }
    if (lower === "codex" || lower.endsWith("/codex") || lower.endsWith("/codex-tui")) {
      return "codex";
    }
  }
  return null;
}

function findExistingTerminalPreview(targetAddress, sourceId) {
  for (const term of terminals()) {
    if (term?.state !== "live" || !Array.isArray(term.argv)) continue;
    const joined = term.argv.join(" ");
    if (!joined.includes("src/preview.mjs")) continue;
    const hasTarget = term.argv.includes(targetAddress);
    const hasSource = term.argv.includes(sourceId);
    if (hasTarget && hasSource) return term.address;
  }
  return null;
}

export default class HerdrPreviewMod extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.source = "mermaid";
    this.place = "right";
    this.useBrowser = false;
    this.selectedIndex = null;
    this.config = null;
    this.configLoaded = false;

    if (!isChecking()) {
      cx.spawn(async (cx) => {
        try {
          const text = await readTextFile(`${appHome()}/mods/herdr-preview/config.json`);
          if (text) this.config = JSON.parse(text);
        } catch {
          this.config = null;
        }
        this.configLoaded = true;
        cx.notify();
      });
    }
  }

  hasNativeBrowser() {
    return commands().some((cmd) => cmd.name === "browser.open");
  }

  runtimeName() {
    return this.hasNativeBrowser() ? "browser" : "app";
  }

  pluginRoot() {
    return this.config?.pluginRoot || `${home()}/dev/herdr-plugin-mermaid-preview`;
  }

  nodeBinary() {
    return this.config?.node || "node";
  }

  targets() {
    const allAgents = agents();
    const allPanes = panes();
    const allSpaces = spaces();
    const focusedNow = focused();
    const spaceById = new Map(allSpaces.map((s) => [s.id, s]));
    const tabById = new Map();
    for (const s of allSpaces) {
      for (const tab of s.tabs || []) tabById.set(tab.id, { space: s, tab });
    }
    const agentByAddress = new Map(allAgents.map((a) => [a.address, a]));
    const paneByTerminal = new Map(
      allPanes.filter((p) => p.terminal).map((p) => [p.terminal, p]),
    );

    const rows = [];
    for (const term of terminals()) {
      if (term?.state !== "live") continue;
      if (typeof term.address !== "string" || term.address.includes("/")) continue;
      const agentEntry = agentByAddress.get(term.address) || null;
      const kind = isSupportedAgent(term, agentEntry);
      if (!kind) continue;

      const paneEntry = paneByTerminal.get(term.address) || null;
      const tabInfo = paneEntry ? tabById.get(paneEntry.tab) : null;
      const spaceId = agentEntry?.space || tabInfo?.space?.id || focusedNow?.space || null;
      const spaceName =
        agentEntry?.space_name ||
        tabInfo?.space?.name ||
        (spaceId ? spaceById.get(spaceId)?.name : null) ||
        "";
      const tabName = agentEntry?.tab_name || tabInfo?.tab?.name || "";
      const isFocused = Boolean(
        focusedNow?.terminal === term.address || agentEntry?.focused || paneEntry?.focused,
      );

      rows.push({
        address: term.address,
        focused: isFocused,
        kind,
        paneId: paneEntry?.pane || agentEntry?.pane || null,
        spaceId,
        spaceName,
        status: agentEntry?.status || term.status || null,
        tabName,
        title: term.title || paneEntry?.title || term.cwd || term.address,
      });
    }

    rows.sort((a, b) => Number(b.focused) - Number(a.focused));
    return rows;
  }

  close() {
    if (props()?.overlay) closeOverlay(props().overlay);
  }

  openSelected(cx) {
    const list = this.targets();
    if (list.length === 0) return;
    const index = Math.min(Math.max(0, this.selectedIndex ?? 0), list.length - 1);
    const target = list[index];
    const sourceMeta = SOURCES.find((entry) => entry.id === this.source) || SOURCES[0];
    const runtime = this.runtimeName();
    const pluginRoot = this.pluginRoot();
    const nodeBin = this.nodeBinary();

    if (this.useBrowser && this.hasNativeBrowser()) {
      this.close();
      const args = [
        `${pluginRoot}/src/open-preview.mjs`,
        this.source,
        "--runtime",
        "browser",
        "--browser",
        "--target",
        target.address,
        "--place",
        this.place,
      ];
      cx.spawn(async () => {
        try {
          const result = await exec(nodeBin, args);
          if (result.code !== 0) {
            notify({
              body: (result.stderr || result.stdout || "Could not open browser preview").trim(),
              level: "error",
              title: "Herdr Preview",
            });
          }
        } catch (error) {
          notify({
            body: String(error?.message || error),
            level: "error",
            title: "Herdr Preview",
          });
        }
      });
      return;
    }

    const existing = findExistingTerminalPreview(target.address, this.source);
    this.close();
    if (existing) {
      run("pane.focus", { terminal: existing });
      return;
    }

    const argv = [
      nodeBin,
      `${pluginRoot}/src/preview.mjs`,
      "--runtime",
      runtime,
      "--source",
      this.source,
      "--target",
      target.address,
    ];

    if (this.place === "right" || this.place === "down") {
      const args = { argv, direction: this.place };
      if (target.paneId) args.pane = target.paneId;
      run("pane.split", args);
      return;
    }

    const args = {
      argv,
      focus: true,
      name: `${sourceMeta.short} preview`,
    };
    if (target.spaceId) args.space = target.spaceId;
    run("tab.new", args);
  }

  pill(t, id, label, active, onClick) {
    return div()
      .id(id)
      .px(10)
      .py(4)
      .rounded(6)
      .border(1)
      .border_color(active ? t.accent : t.border)
      .bg(active ? t.selected : t.surface)
      .text_size(12)
      .text_color(active ? t.foreground : t.muted)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click(onClick)
      .child(label);
  }

  render(cx) {
    const t = theme();
    const list = this.targets();
    if (this.selectedIndex === null) this.selectedIndex = 0;
    if (list.length > 0) {
      this.selectedIndex = Math.min(this.selectedIndex, list.length - 1);
    }
    const browserAvailable = this.hasNativeBrowser();

    return v_flex()
      .id("herdr-preview-root")
      .track_focus(this.handle)
      .size_full()
      .p(16)
      .gap(12)
      .bg(t.popover)
      .text_size(13)
      .on_key_down((e, cx) => {
        const key = e.key;
        if (key === "escape") {
          this.close();
        } else if (key === "enter") {
          this.openSelected(cx);
        } else if (key === "down" || key === "j") {
          if (list.length > 0) this.selectedIndex = (this.selectedIndex + 1) % list.length;
        } else if (key === "up" || key === "k") {
          if (list.length > 0) {
            this.selectedIndex = (this.selectedIndex + list.length - 1) % list.length;
          }
        } else if (key === "m") {
          this.source = "mermaid";
        } else if (key === "i") {
          this.source = "images";
        } else if (key === "b" && browserAvailable) {
          this.useBrowser = !this.useBrowser;
        } else {
          return;
        }
        cx.stop_propagation();
        cx.notify();
      })
      .child(
        h_flex()
          .items_center()
          .justify_between()
          .child(
            div()
              .text_size(15)
              .font_semibold()
              .text_color(t.foreground)
              .child("Herdr Preview"),
          )
          .child(
            div()
              .id("hp-close")
              .px(6)
              .py(2)
              .rounded(5)
              .text_size(11)
              .text_color(t.dim)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_click(() => this.close())
              .child("Esc"),
          ),
      )
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .children(
            SOURCES.map((entry) =>
              this.pill(t, `hp-src-${entry.id}`, entry.label, this.source === entry.id, (_e, cx) => {
                this.source = entry.id;
                cx.notify();
              }),
            ),
          ),
      )
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .children([
            ...PLACEMENTS.map((entry) =>
              this.pill(
                t,
                `hp-place-${entry.id}`,
                entry.label,
                this.place === entry.id,
                (_e, cx) => {
                  this.place = entry.id;
                  cx.notify();
                },
              ),
            ),
            ...(browserAvailable
              ? [
                  this.pill(
                    t,
                    "hp-mode-browser",
                    this.useBrowser ? "Native browser ✓" : "Native browser",
                    this.useBrowser,
                    (_e, cx) => {
                      this.useBrowser = !this.useBrowser;
                      cx.notify();
                    },
                  ),
                ]
              : []),
          ]),
      )
      .child(
        v_flex()
          .flex_1()
          .min_h(0)
          .gap(4)
          .overflow_y_scrollbar()
          .when(list.length === 0, (el) =>
            el.child(
              div()
                .p(12)
                .rounded(7)
                .border(1)
                .border_color(t.border)
                .text_size(12)
                .text_color(t.muted)
                .child(
                  "No local Claude Code or Codex terminals found. Start one in a tab, then reopen Herdr Preview.",
                ),
            ),
          )
          .when(list.length > 0, (el) =>
            el.children(
              list.map((row, index) => {
                const active = index === this.selectedIndex;
                const where = [row.spaceName, row.tabName].filter(Boolean).join(" / ");
                return h_flex()
                  .id(`hp-target-${row.address}`)
                  .px(10)
                  .py(7)
                  .rounded(7)
                  .gap(8)
                  .items_center()
                  .cursor_pointer()
                  .bg(active ? t.selected : t.surface)
                  .border(1)
                  .border_color(active ? t.accent : t.border)
                  .hover((s) => s.bg(t.hover))
                  .on_click((_e, cx) => {
                    this.selectedIndex = index;
                    this.openSelected(cx);
                  })
                  .child(
                    div()
                      .px(5)
                      .py(1)
                      .rounded(4)
                      .bg(t.raised)
                      .text_size(11)
                      .text_color(t.accent)
                      .child(row.kind),
                  )
                  .child(
                    div()
                      .flex_1()
                      .truncate()
                      .text_color(t.foreground)
                      .child(row.title),
                  )
                  .child(
                    div()
                      .text_size(11)
                      .text_color(t.dim)
                      .child(where || row.address),
                  );
              }),
            ),
          ),
      )
      .child(
        h_flex()
          .items_center()
          .justify_between()
          .child(
            div()
              .text_size(11)
              .text_color(t.dim)
              .child(
                browserAvailable
                  ? "m/i source · b browser · ↑/↓ select · Enter open"
                  : "m/i source · ↑/↓ select · Enter open",
              ),
          )
          .child(
            div()
              .id("hp-open")
              .px(12)
              .py(5)
              .rounded(6)
              .bg(list.length > 0 ? t.solid : t.raised)
              .text_size(12)
              .font_semibold()
              .text_color(list.length > 0 ? t.solid_foreground : t.dim)
              .cursor_pointer()
              .on_click((_e, cx) => this.openSelected(cx))
              .child("Open preview"),
          ),
      );
  }
}

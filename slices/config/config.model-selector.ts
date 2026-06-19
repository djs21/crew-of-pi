/**
 * Config model selector — fuzzy-searchable model picker via ctx.ui.custom().
 *
 * Renders an Input for search + filtered list using fuzzyFilter.
 * Navigate with ↑↓, select with Enter, cancel with Esc.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  Box,
  Container,
  fuzzyFilter,
  getKeybindings,
  Input,
  type Component,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";

export interface ModelOption {
  value: string; // "provider/model-id"
  label: string; // display name
  provider: string;
  id: string;
  searchText: string; // what fuzzyFilter searches against
}

/**
 * Show a fuzzy-searchable model selector overlay.
 * Returns the selected model value ("provider/id") or undefined if cancelled.
 */
export async function showModelSelector(
  options: ModelOption[],
  ctx: ExtensionCommandContext,
): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
    const container = new Container();
    let filtered = options;
    let selectedIndex = 0;
    const maxVisible = 12;

    // ── Search input ────────────────────────────────────────────
    const searchInput = new Input();
    searchInput.onSubmit = () => {
      const selected = filtered[selectedIndex];
      if (selected) done(selected.value);
    };

    // ── Build UI ────────────────────────────────────────────────
    container.addChild(new Box(theme.fg("accent", "━"), theme.fg("accent", "━"), theme.fg("accent", "━")));
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("accent", theme.bold("Pilih Model (ketik untuk mencari)")), 0, 0));
    container.addChild(new Spacer(1));
    container.addChild(searchInput);
    container.addChild(new Spacer(1));

    // List container — will be cleared and re-rendered
    const listContainer = new Container();
    container.addChild(listContainer);

    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel • ketik untuk fuzzy search"), 0, 0));
    container.addChild(new Box(theme.fg("accent", "━"), theme.fg("accent", "━"), theme.fg("accent", "━")));

    // ── Render helpers ──────────────────────────────────────────
    function filterModels(query: string): void {
      filtered = query
        ? fuzzyFilter(options, query, (o) => o.searchText)
        : options;
      selectedIndex = Math.min(selectedIndex, Math.max(0, filtered.length - 1));
      renderList();
    }

    function renderList(): void {
      listContainer.clear();

      if (filtered.length === 0) {
        listContainer.addChild(new Text(theme.fg("muted", "  Tidak ada model yang cocok"), 0, 0));
        return;
      }

      const startIdx = Math.max(0, Math.min(
        selectedIndex - Math.floor(maxVisible / 2),
        filtered.length - maxVisible,
      ));
      const endIdx = Math.min(startIdx + maxVisible, filtered.length);

      for (let i = startIdx; i < endIdx; i++) {
        const item = filtered[i];
        const isSelected = i === selectedIndex;

        const label = isSelected
          ? theme.fg("accent", `→ ${item.label}`)
          : `  ${theme.fg("text", item.label)}`;

        listContainer.addChild(new Text(label, 0, 0));
      }

      // Scroll indicator
      if (startIdx > 0 || endIdx < filtered.length) {
        listContainer.addChild(new Text(
          theme.fg("muted", `  (${selectedIndex + 1}/${filtered.length})`),
          0, 0,
        ));
      }
    }

    // ── Component interface ─────────────────────────────────────
    const component: Component = {
      render(width: number): string[] {
        return container.render(width);
      },
      invalidate(): void {
        container.invalidate();
      },
      handleInput(data: string): void {
        const kb = getKeybindings();

        if (kb.matches(data, "tui.select.up")) {
          if (filtered.length === 0) return;
          selectedIndex = selectedIndex === 0 ? filtered.length - 1 : selectedIndex - 1;
          renderList();
          tui.requestRender();
        } else if (kb.matches(data, "tui.select.down")) {
          if (filtered.length === 0) return;
          selectedIndex = selectedIndex === filtered.length - 1 ? 0 : selectedIndex + 1;
          renderList();
          tui.requestRender();
        } else if (kb.matches(data, "tui.select.confirm")) {
          const selected = filtered[selectedIndex];
          if (selected) done(selected.value);
        } else if (kb.matches(data, "tui.select.cancel")) {
          done(undefined);
        } else {
          // Pass to search input
          searchInput.handleInput(data);
          filterModels(searchInput.getValue());
          tui.requestRender();
        }
      },
    };

    // Initial render
    renderList();
    return component;
  });
}

import type { Page } from '../automation/types.js';
import { waitForStability } from '../browser/stability.js';
import { log } from '../util/logger.js';

/**
 * Helpers for the transient UI that dropdowns, calendars and value-help dialogs
 * put on screen. The engine's central rule is that this opened state is the
 * evidence, so opening reliably — and closing without side effects — matters.
 */

/** Selectors covering UI5 popups plus common plain-DOM equivalents. */
const OVERLAY_SELECTOR = [
  '.sapMDialog',
  '.sapMPopover',
  '.sapMSelectList',
  '.sapMComboBoxBasePicker',
  '.sapMMultiComboBoxPicker',
  '.sapMDP',
  '.sapMDatePickerDropdown',
  '.sapMValueHelpDialog',
  '.sapMSelectDialog',
  '[role="dialog"]',
  '[role="listbox"]',
  // Native <dialog> has an implicit dialog role that attribute selectors miss.
  'dialog[open]',
].join(', ');

/** No exclusions — every overlay-affecting call below defaults to this. */
export const NO_BASELINE: ReadonlySet<string> = new Set();

/** CSS.escape equivalent for building selectors in Node. */
function cssEscape(value: string): string {
  return value.replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1');
}

/**
 * Identifies every currently visible overlay element.
 *
 * Framework popups (dialogs, popovers, select lists) always carry an id;
 * elements matched only by a generic role selector without one fall back to a
 * positional key, so they still participate in baseline comparison even
 * though that key is not stable across separate calls.
 */
async function overlayIds(page: Page): Promise<string[]> {
  return page
    .evaluate((sel: string) => {
      return Array.from(document.querySelectorAll(sel))
        .filter((el) => {
          const rect = (el as HTMLElement).getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return false;
          const style = getComputedStyle(el as HTMLElement);
          return style.visibility !== 'hidden' && style.display !== 'none';
        })
        .map((el, i) => (el as HTMLElement).id || `__anon${i}`);
    }, OVERLAY_SELECTOR)
    .catch(() => [] as string[]);
}

/**
 * Snapshots which overlays already exist, before an interaction opens
 * anything new.
 *
 * This is the baseline every function below is scoped against. An overlay
 * present in it was on screen before the current interaction did anything —
 * a leftover from an earlier, already-completed step of the workflow — and
 * every helper here treats it as off-limits: not counted as "open" for the
 * purpose of deciding whether this interaction's own popup appeared, not
 * searched for an option to select, not closed. Without this, a dialog left
 * over from three steps ago is indistinguishable from the one a field just
 * opened, and an unrelated interaction's cleanup can end up pressing Escape
 * into it or clicking one of its rows — silently altering state this
 * interaction never touched. This generalises to any leftover overlay in any
 * application; nothing here is specific to one dialog or one field.
 */
export async function overlayBaseline(page: Page): Promise<ReadonlySet<string>> {
  const ids = await overlayIds(page);
  if (ids.length) {
    log.debug(`  [overlay] baseline before this interaction: ${ids.join(', ')}`);
  }
  return new Set(ids);
}

/** Counts visible overlays not present in `baseline`. */
export async function overlayCount(
  page: Page,
  baseline: ReadonlySet<string> = NO_BASELINE,
): Promise<number> {
  const ids = await overlayIds(page);
  return ids.filter((id) => !baseline.has(id)).length;
}

/** Returns true once an overlay absent from `baseline` is visible. */
export async function isOverlayOpen(
  page: Page,
  baseline: ReadonlySet<string> = NO_BASELINE,
): Promise<boolean> {
  return (await overlayCount(page, baseline)) > 0;
}

/** Builds a `:not(#id)` chain excluding every id in `baseline`. */
function excludeBaseline(baseline: ReadonlySet<string>): string {
  return [...baseline]
    .filter((id) => !id.startsWith('__anon'))
    .map((id) => `:not(#${cssEscape(id)})`)
    .join('');
}

/**
 * Filters selectors to those inside a currently open, non-baseline overlay.
 *
 * While a modal dialog is open, only the dialog's own fields are reachable, so
 * a nested exploration must not attempt the page behind it — and must not
 * attempt a leftover dialog from an earlier step either, see `overlayBaseline`.
 */
export async function selectorsInsideOverlay(
  page: Page,
  selectors: string[],
  baseline: ReadonlySet<string> = NO_BASELINE,
): Promise<Set<string>> {
  const inside = await page
    .evaluate(
      ({ sel, list, baselineIds }: { sel: string; list: string[]; baselineIds: string[] }) => {
        const baselineSet = new Set(baselineIds);
        const overlays = Array.from(document.querySelectorAll(sel)).filter((el) => {
          if (baselineSet.has((el as HTMLElement).id)) return false;
          const rect = (el as HTMLElement).getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });
        if (overlays.length === 0) return [] as string[];

        return list.filter((s) => {
          let el: Element | null = null;
          try {
            el = document.querySelector(s);
          } catch {
            return false;
          }
          if (!el) return false;
          return overlays.some((o) => o.contains(el as Node));
        });
      },
      { sel: OVERLAY_SELECTOR, list: selectors, baselineIds: [...baseline] },
    )
    .catch(() => [] as string[]);

  return new Set(inside);
}

/** Waits for an overlay absent from `baseline` to appear, returning whether one did. */
export async function waitForOverlay(
  page: Page,
  timeoutMs: number,
  baseline: ReadonlySet<string> = NO_BASELINE,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isOverlayOpen(page, baseline)) {
      const ids = await overlayIds(page);
      const newIds = ids.filter((id) => !baseline.has(id));
      log.debug(`  [overlay] new overlay appeared: ${newIds.join(', ') || '(unidentified)'}`);
      // Let the popup finish animating so the screenshot is not mid-transition.
      await page.waitForTimeout(250);
      return true;
    }
    await page.waitForTimeout(100);
  }
  log.debug(`  [overlay] no new overlay appeared within ${timeoutMs}ms`);
  return false;
}

/**
 * Waits for a non-baseline overlay to finish loading its contents.
 *
 * A value-help dialog appears immediately but fetches its rows afterwards,
 * showing a busy indicator and a placeholder row ("Loading......") in the
 * meantime. Selecting during that window picks the placeholder instead of real
 * data, and photographs an empty table as the evidence. Returns whether the
 * overlay settled within the budget.
 */
export async function waitForOverlayContent(
  page: Page,
  timeoutMs: number,
  baseline: ReadonlySet<string> = NO_BASELINE,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const busy = await page
      .evaluate(
        ({ sel, baselineIds }: { sel: string; baselineIds: string[] }) => {
          const baselineSet = new Set(baselineIds);
          const visible = (el: Element) => {
            const r = (el as HTMLElement).getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          };
          const overlays = Array.from(document.querySelectorAll(sel)).filter(
            (el) => !baselineSet.has((el as HTMLElement).id) && visible(el),
          );
          if (overlays.length === 0) return false;

          return overlays.some((o) => {
            if (o.querySelector('[aria-busy="true"]')) return true;
            if (
              Array.from(
                o.querySelectorAll('.sapUiLocalBusyIndicator, .sapUiBlockLayer'),
              ).some(visible)
            ) {
              return true;
            }
            // Placeholder rows rendered while data is still on its way.
            return /loading\s*\.*\s*$/i.test((o as HTMLElement).innerText || '');
          });
        },
        { sel: OVERLAY_SELECTOR, baselineIds: [...baseline] },
      )
      .catch(() => false);

    if (!busy) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

/**
 * Closes a non-baseline overlay without committing a change.
 *
 * Prefers Escape, which UI5 treats as cancel, and falls back to an explicit
 * Cancel/Close control scoped to non-baseline overlays only. Never clicks
 * OK/Select, so that closing an overlay the engine merely inspected does not
 * alter application state.
 *
 * Returns immediately, doing nothing at all, when the only overlay left open
 * is one already present in `baseline` — there is nothing this interaction
 * opened left to close, and pressing Escape or clicking into a leftover
 * dialog from an earlier step is exactly the unscoped action that let a
 * later, unrelated interaction's cleanup silently act on state it never
 * touched.
 */
export async function closeOverlay(
  page: Page,
  timeoutMs = 4000,
  baseline: ReadonlySet<string> = NO_BASELINE,
): Promise<void> {
  if (!(await isOverlayOpen(page, baseline))) {
    const preExisting = await overlayIds(page);
    log.debug(
      preExisting.length
        ? `  [overlay] closeOverlay: nothing new to close (only pre-existing ${preExisting.join(', ')} present, left untouched)`
        : `  [overlay] closeOverlay: nothing open, no-op`,
    );
    return;
  }

  await page.keyboard.press('Escape').catch(() => undefined);
  await page.waitForTimeout(200);
  if (!(await isOverlayOpen(page, baseline))) {
    log.debug('  [overlay] closeOverlay: closed via Escape');
    return;
  }

  const exclude = excludeBaseline(baseline);
  const cancel = page
    .locator(
      `.sapMDialog${exclude} button:has-text("Cancel"), .sapMDialog${exclude} button:has-text("Close"), ` +
        `[role="dialog"]${exclude} button:has-text("Cancel"), [role="dialog"]${exclude} button:has-text("Close"), ` +
        `dialog[open]${exclude} button:has-text("Cancel"), dialog[open]${exclude} button:has-text("Close")`,
    )
    .first();
  if (await cancel.isVisible().catch(() => false)) {
    await cancel.click({ timeout: 2000 }).catch(() => undefined);
    await page.waitForTimeout(200);
    if (!(await isOverlayOpen(page, baseline))) {
      log.debug('  [overlay] closeOverlay: closed via Cancel/Close button');
    }
  }

  /*
   * Matching "Cancel"/"Close" by English text -- the only option before this
   * point -- cannot dismiss a dialog whose UI runs in another display
   * language: confirmed on a live capture where a value-help dialog's own
   * button text is localized, so neither Escape nor the text match above
   * closed it, and the dialog's block layer (`.sapUiBLy`), which covers the
   * *entire* page rather than just the dialog, then silently failed every
   * remaining control for the rest of the branch -- baseline scoping only
   * keeps a later interaction from mistaking a leftover dialog for its own,
   * it does nothing about that dialog's block layer physically intercepting
   * every click on the page behind it. Calling the control's own `close()`
   * through the UI5 API sidesteps button text and language entirely.
   */
  if (await isOverlayOpen(page, baseline)) {
    const closedViaApi = await closeViaUi5Api(page, baseline);
    await page.waitForTimeout(200);
    if (closedViaApi && !(await isOverlayOpen(page, baseline))) {
      log.debug('  [overlay] closeOverlay: closed via UI5 control API');
    }
  }

  if (await isOverlayOpen(page, baseline)) {
    log.debug(
      '  [overlay] closeOverlay: still open after Escape, Cancel and the UI5 API — leaving it ' +
        '(baseline scoping keeps later interactions from mistaking it for their own, but its ' +
        'block layer, if any, may still cover the page)',
    );
  }

  await waitForStability(page, timeoutMs).catch(() => undefined);
}

/**
 * Closes a non-baseline overlay through the UI5 control's own `close()`
 * method, resolved via `sap.ui.getCore().byId()` -- confirmed functional
 * (though deprecated since 1.119) on both target landscapes, old and new.
 * This is the only dismissal path that does not depend on the dialog's
 * button text, so it works regardless of the application's display
 * language. Returns whether a close() call was actually made.
 */
async function closeViaUi5Api(
  page: Page,
  baseline: ReadonlySet<string>,
): Promise<boolean> {
  return page
    .evaluate(
      ({ sel, baselineIds }: { sel: string; baselineIds: string[] }) => {
        const baselineSet = new Set(baselineIds);
        const core = (window as any).sap?.ui?.getCore?.();
        if (!core?.byId) return false;

        const overlays = Array.from(document.querySelectorAll(sel)).filter((el) => {
          if (baselineSet.has((el as HTMLElement).id)) return false;
          const rect = (el as HTMLElement).getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });

        let closed = false;
        for (const el of overlays) {
          const id = (el as HTMLElement).id;
          if (!id) continue;
          const control = core.byId(id);
          if (control && typeof control.close === 'function') {
            control.close();
            closed = true;
          }
        }
        return closed;
      },
      { sel: OVERLAY_SELECTOR, baselineIds: [...baseline] },
    )
    .catch(() => false);
}

/**
 * Selects the first usable option inside a non-baseline overlay.
 *
 * Used by dropdowns, multi-selects and value-help dialogs, all of which need a
 * *valid* value rather than arbitrary text. Returns the chosen text, or null.
 * Every selector excludes `baseline` ids, so a leftover dialog from an
 * earlier, already-completed step can never be mistaken for the popup this
 * field just opened — the broadest tiers here (`.sapMDialog li` and similar)
 * are exactly the ones that would otherwise match anything dialog-shaped
 * still on screen, baseline or not.
 */
export async function selectFirstOption(
  page: Page,
  timeoutMs: number,
  baseline: ReadonlySet<string> = NO_BASELINE,
): Promise<string | null> {
  const exclude = excludeBaseline(baseline);
  const optionSelectors = [
    `.sapMSelectList${exclude} li:not(.sapMSelectListItemDisabled)`,
    `.sapMComboBoxBasePicker${exclude} li:not(.sapMSelectListItemDisabled)`,
    `.sapMMultiComboBoxPicker${exclude} li`,
    `.sapMSelectDialog${exclude} li`,
    `.sapMValueHelpDialog${exclude} tbody tr`,
    `.sapMDialog${exclude} tbody tr`,
    `.sapMDialog${exclude} li`,
    `[role="listbox"]${exclude} [role="option"]`,
    `[role="dialog"]${exclude} tbody tr`,
    `dialog[open]${exclude} tbody tr`,
    `dialog[open]${exclude} li`,
  ];

  for (const sel of optionSelectors) {
    const options = page.locator(sel);
    const count = await options.count().catch(() => 0);
    for (let i = 0; i < Math.min(count, 5); i++) {
      const opt = options.nth(i);
      if (!(await opt.isVisible().catch(() => false))) continue;
      const text = ((await opt.innerText().catch(() => '')) || '').trim();
      /*
       * Skip header rows, empty placeholders, and the row a list shows while
       * its data is still loading — selecting that would store a placeholder
       * as though it were a real value. "More" is a growing-list trigger, not
       * a row.
       */
      if (
        !text ||
        /^(no data|select|none|more)$/i.test(text) ||
        /^loading\s*\.*$/i.test(text)
      ) {
        continue;
      }

      await opt.click({ timeout: timeoutMs }).catch(() => undefined);
      await page.waitForTimeout(200);
      const chosen = text.split('\n')[0]?.trim() ?? text;
      log.debug(
        `  [overlay] selectFirstOption: matched via "${sel.split(':not')[0]}" (tier ${optionSelectors.indexOf(sel) + 1}/${optionSelectors.length}), clicked "${chosen}"`,
      );
      return chosen;
    }
  }
  log.debug('  [overlay] selectFirstOption: no selectable option found in any tier');
  return null;
}

/**
 * Confirms a non-baseline dialog that requires an explicit OK/Select to apply
 * a choice.
 *
 * Only used after a row has actually been selected in a value-help dialog.
 */
export async function confirmOverlay(
  page: Page,
  baseline: ReadonlySet<string> = NO_BASELINE,
): Promise<void> {
  const exclude = excludeBaseline(baseline);
  const ok = page
    .locator(
      `.sapMDialog${exclude} button:has-text("OK"), .sapMDialog${exclude} button:has-text("Select"), ` +
        `[role="dialog"]${exclude} button:has-text("OK"), [role="dialog"]${exclude} button:has-text("Select"), ` +
        `dialog[open]${exclude} button:has-text("OK"), dialog[open]${exclude} button:has-text("Select")`,
    )
    .first();
  if (await ok.isVisible().catch(() => false)) {
    await ok.click({ timeout: 3000 }).catch(() => undefined);
    await page.waitForTimeout(250);
  }
}

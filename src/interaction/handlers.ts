import type { Locator, Page } from '../automation/types.js';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { ControlDescriptor, ControlKind } from '../types.js';
import type { Budgets, SafetyPolicy } from '../config/schema.js';
import { waitForStability } from '../browser/stability.js';
import { TestDataProvider, splitRange } from '../testdata/provider.js';
import {
  closeOverlay,
  confirmOverlay,
  overlayBaseline,
  overlayCount,
  selectFirstOption,
  waitForOverlay,
  waitForOverlayContent,
} from './overlay.js';
import { mayClick } from './safety.js';
import { acknowledgeMessageDialogs, inspectTopDialog } from './dialogs.js';
import { waitUntilEditable } from './editability.js';
import { ui5Fingerprint } from '../discovery/ui5-probe.js';
import { domFingerprint } from '../discovery/dom-probe.js';
import { log } from '../util/logger.js';

/**
 * Interaction handlers, one per control kind.
 *
 * Every handler follows the same contract:
 *   open()   - put the control into the state that should be photographed
 *   select() - apply a dummy value
 *   verify() - confirm the value landed
 *
 * The `open` step exists because the documented evidence is the *opened* state
 * (dropdown expanded, calendar showing, value-help dialog visible), not the
 * final filled field.
 */

export interface HandlerContext {
  page: Page;
  budgets: Budgets;
  safety: SafetyPolicy;
  testData: TestDataProvider;
  /** Captures the current screen as this control's evidence. */
  capture: () => Promise<void>;
  /**
   * Processes controls that an interaction has just revealed, while they are
   * still on screen. Used for dialogs, which are documented inline on the
   * parent page and whose own fields must be filled before the dialog closes.
   *
   * `baseline` is the set of overlays that already existed before this
   * control's own interaction opened anything — see `overlayBaseline` in
   * overlay.ts. Passing it through keeps the nested exploration scoped to the
   * overlay this interaction actually opened, not a leftover from an earlier
   * step that happens to still be on screen alongside it.
   */
  exploreRevealed?: (baseline: ReadonlySet<string>) => Promise<void>;
}

export interface HandlerResult {
  /** False when the control produced no evidence and should not be documented. */
  documented: boolean;
  /** Set when the control turned out to be a different kind than classified. */
  reclassifiedAs?: ControlKind;
  /** Human-readable note for the execution report. */
  note?: string;
  /**
   * Set when the interaction navigated to a genuinely different page (the URL
   * itself changed), as opposed to revealing a dialog or expanding something
   * in place. The caller must explore that destination as a real child page
   * and verify its way back before touching anything else on the current
   * page — an in-place UI change carries no such requirement.
   */
  navigatedAway?: boolean;
  /**
   * Set when the control was skipped for a reason that a later sweep could
   * resolve — it was hidden behind a collapsed panel, or covered by an overlay
   * that has since closed. Such a control must not be recorded as permanently
   * handled, or expanding the thing that was hiding it comes too late to help.
   */
  retryable?: boolean;
}

/** Resolves a descriptor to a Playwright locator. */
function locate(page: Page, control: ControlDescriptor): Locator {
  return page.locator(control.selector).first();
}

/**
 * Finds the selector that actually matches this control right now.
 *
 * The id captured at discovery can stop matching before the control is
 * reached: UI5 renumbers auto-generated view prefixes when a view is
 * re-instantiated, turning `#__xmlview2--DueDateId-inner` into a selector for
 * an element that no longer exists while the field itself is plainly on
 * screen. Falling back to the view-independent suffix recovers it.
 *
 * Returns null when neither form matches, which means the control is genuinely
 * gone rather than merely renamed.
 */
export async function resolveSelector(
  page: Page,
  control: ControlDescriptor,
): Promise<string | null> {
  const countOf = async (selector: string): Promise<number> =>
    page
      .locator(selector)
      .count()
      .catch(() => 0);

  /*
   * The view-independent selector is preferred whenever it identifies exactly
   * one element. Playwright resolves a locator at action time, so a selector
   * that does not embed the volatile view number stays correct even if the
   * view renumbers between this check and the click or fill that follows —
   * a race that genuinely occurred, failing a field that was on screen the
   * whole time.
   *
   * When the suffix matches several elements (two view instances briefly
   * mounted together), the exact id disambiguates and is used instead.
   */
  const label = control.canonicalLabel || control.label || control.id;

  if (control.fallbackSelector) {
    const stable = await countOf(control.fallbackSelector);
    if (stable === 1) {
      log.debug(`  [resolve] "${label}": using stable fallback selector (1 match)`);
      return control.fallbackSelector;
    }

    if (stable > 1) {
      if ((await countOf(control.selector)) > 0) {
        log.debug(
          `  [resolve] "${label}": fallback matched ${stable} elements, ` +
            `using exact selector to disambiguate`,
        );
        return control.selector;
      }
      log.debug(
        `  [resolve] "${label}": fallback matched ${stable} elements, exact selector matched 0 — using fallback anyway`,
      );
      return control.fallbackSelector;
    }
  }

  if ((await countOf(control.selector)) > 0) {
    log.debug(`  [resolve] "${label}": using exact selector (no usable fallback)`);
    return control.selector;
  }

  /*
   * Both selectors missed, but the element may simply be mid-re-render: a
   * message dialog close, a value-help confirm, or a dependent field redraw
   * can all destroy and recreate elements within a few hundred milliseconds.
   * A short wait followed by one retry avoids marking the control stale when
   * its replacement is about to appear — which previously caused twelve
   * consecutive "element no longer in the page" every time a message dialog
   * was acknowledged.
   */
  await page.waitForTimeout(1200);

  if (control.fallbackSelector) {
    const retryStable = await countOf(control.fallbackSelector);
    if (retryStable === 1) {
      log.debug(`  [resolve] "${label}": found after brief wait via fallback selector`);
      return control.fallbackSelector;
    }
    if (retryStable > 1 && (await countOf(control.selector)) > 0) {
      log.debug(`  [resolve] "${label}": found after brief wait via exact selector`);
      return control.selector;
    }
    if (retryStable > 0) {
      log.debug(`  [resolve] "${label}": found after brief wait via fallback (${retryStable} matches)`);
      return control.fallbackSelector;
    }
  }

  if ((await countOf(control.selector)) > 0) {
    log.debug(`  [resolve] "${label}": found after brief wait via exact selector`);
    return control.selector;
  }

  log.debug(`  [resolve] "${label}": neither exact nor fallback selector matched anything`);
  return null;
}

/** Scrolls a control into view so screenshots show it in context. */
export async function reveal(page: Page, selector: string): Promise<Locator> {
  const loc = page.locator(selector).first();
  await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => undefined);
  await page.waitForTimeout(80);
  return loc;
}

/** Result returned when a control can no longer be found at all. */
export function notFound(control: ControlDescriptor): HandlerResult {
  const label = control.canonicalLabel || control.label || control.id;
  log.warn(`  skipping "${label}": element no longer in the page`);
  /*
   * Not found right now does not mean gone for good. Selecting a value in
   * one field commonly triggers UI5 to re-render a whole cluster of dependent
   * fields at once -- new elements, same meaning -- and every other control
   * already queued for this sweep goes stale in that same instant, purely
   * because the queue was built from the DOM as it stood a moment earlier.
   * A real run against the live system showed exactly this: dozens of fields
   * failing "element no longer in the page" back to back, immediately after
   * the field ahead of them in the queue was filled -- not because the form
   * lost them, but because it had just redrawn them. Treating this as
   * retryable lets the sweep mechanism -- already built for "hidden behind a
   * collapsed panel", the same kind of here-now-gone-a-moment-later state --
   * pick each of them back up once the redraw has settled, instead of
   * recording the whole cluster as permanently handled and silently losing
   * it from the documentation. `attempts`/`MAX_ATTEMPTS` still bounds a
   * control that is truly gone to two tries, not unbounded retries.
   */
  return { documented: false, note: 'skipped: element not found', retryable: true };
}

/**
 * Resolves the element that actually accepts typing.
 *
 * A UI5 control's id belongs to its wrapper element, not to the `<input>`
 * inside it, so filling the wrapper fails. This returns the inner editable
 * element when the selector resolves to a wrapper, and the element itself when
 * it is already editable.
 */
export async function editableLocator(
  page: Page,
  selector: string,
): Promise<Locator> {
  const self = page.locator(selector).first();

  const isEditable = await self
    .evaluate((el: Element) => {
      const tag = el.tagName;
      return (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        (el as HTMLElement).isContentEditable === true
      );
    })
    .catch(() => false);

  if (isEditable) return self;

  const inner = page
    .locator(
      `${selector} input:not([type="hidden"]), ` +
        `${selector} textarea, ` +
        `${selector} [contenteditable="true"]`,
    )
    .first();

  const hasInner = await inner
    .count()
    .then((n) => n > 0)
    .catch(() => false);

  return hasInner ? inner : self;
}

/**
 * Confirms a control can actually be interacted with before attempting to.
 *
 * Returns null when it is safe to proceed. Returns a skip result — no click,
 * no fill, no exception — when it is not: this is what turns "not editable"
 * into one fast, clearly-labelled skip instead of the full control timeout
 * expiring on a click that was never going to land, which is what happened,
 * repeatedly, when a leftover overlay blocked every field behind it.
 */
export async function ensureInteractable(
  control: ControlDescriptor,
  ctx: HandlerContext,
  locator: Locator,
): Promise<HandlerResult | null> {
  const result = await waitUntilEditable(
    ctx.page,
    locator,
    ctx.budgets.editabilityCheckMs,
  );
  if (result.ok) return null;

  const label = control.canonicalLabel || control.label || control.id;
  log.warn(`  skipping "${label}": not interactable (${result.reason})`);

  /*
   * "Not visible" and "covered by ..." describe the page as it is right now,
   * not the control itself: a field inside a collapsed panel, or one sitting
   * under a dialog that is about to be dismissed, reads exactly this way and
   * becomes perfectly fillable a moment later. Those are offered back for a
   * later sweep. "Disabled" and "read-only" are properties of the control and
   * are not retried.
   */
  const transient =
    result.reason === 'not visible' ||
    result.reason === 'element not present' ||
    (result.reason ?? '').startsWith('covered by');

  return {
    documented: false,
    note: `skipped: ${result.reason}`,
    ...(transient ? { retryable: true } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * Simple text-like controls
 * ------------------------------------------------------------------ */

/**
 * Text and numeric inputs.
 *
 * These reveal no overlay, so the evidence is the field carrying its value —
 * the screenshot is taken after filling rather than before.
 */
async function handleTextual(
  control: ControlDescriptor,
  ctx: HandlerContext,
): Promise<HandlerResult> {
  const selector = await resolveSelector(ctx.page, control);
  if (!selector) return notFound(control);

  await reveal(ctx.page, selector);
  const target = await editableLocator(ctx.page, selector);

  const blocked = await ensureInteractable(control, ctx, target);
  if (blocked) return blocked;

  let value = ctx.testData.valueFor(control) ?? 'TEST01';

  /*
   * A native <input type="number"> rejects Playwright's fill() outright for
   * anything that isn't a valid number -- confirmed on a live capture where
   * the generic 'TEST01' fallback threw "Cannot type text into
   * input[type=number]" on every plain numeric field with no configured test
   * value (Electric Bill, Water Bill, Annual Forecast, ...). Checked
   * structurally against the resolved element's own HTML type, not by field
   * name, so it applies to any numeric field in any app.
   */
  const isNumberInput = await target
    .evaluate((el: Element) => (el as HTMLInputElement).type === 'number')
    .catch(() => false);
  if (isNumberInput && !/^-?\d+(\.\d+)?$/.test(value)) {
    value = '1';
  }

  await target
    .click({ timeout: ctx.budgets.controlTimeoutMs })
    .catch(() => undefined);
  await target.fill(value, { timeout: ctx.budgets.controlTimeoutMs });
  // Commit the value the way a user would, so dependent fields react.
  await ctx.page.keyboard.press('Tab').catch(() => undefined);
  await waitForStability(ctx.page, ctx.budgets.stabilityTimeoutMs);

  await ctx.capture();
  return { documented: true };
}

/* ------------------------------------------------------------------ *
 * Overlay-opening controls
 * ------------------------------------------------------------------ */

/** What opening a control's overlay/picker found. */
export interface OpenResult {
  opened: boolean;
  /** Overlays present before this open attempt — pass through to pick/close/explore. */
  baseline: ReadonlySet<string>;
  /** True for a native `<select>`: nothing renders as an overlay to open. */
  isNative?: boolean;
}

/**
 * Clicks whatever this control kind's trigger is and waits for its
 * overlay/picker to appear — the "open" half of select/date/valueHelp/
 * multiSelect, extracted so Manual mode can reuse exactly this and stop
 * there, instead of also auto-picking a value the way the handlers below do.
 * Every selector and fallback here is the same one the handlers used inline
 * before this was pulled out; behaviour for Automatic mode is unchanged.
 */
export async function openControlOverlay(
  control: ControlDescriptor,
  ctx: HandlerContext,
  loc: Locator,
  selector: string,
): Promise<OpenResult> {
  const baseline = await overlayBaseline(ctx.page);

  switch (control.kind) {
    case 'select': {
      // A native <select> renders its list in the operating system's own
      // layer, which cannot be screenshotted or driven the same way.
      const isNative = await loc
        .evaluate((el: Element) => el.tagName === 'SELECT')
        .catch(() => false);
      if (isNative) return { opened: false, baseline, isNative: true };

      await loc.click({ timeout: ctx.budgets.controlTimeoutMs }).catch(() => undefined);
      const opened = await waitForOverlay(ctx.page, 3000, baseline);
      return { opened, baseline };
    }

    case 'multiSelect': {
      const arrow = ctx.page.locator(`${selector} .sapMInputBaseIconContainer`).first();
      if (await arrow.isVisible().catch(() => false)) {
        await arrow.click({ timeout: ctx.budgets.controlTimeoutMs }).catch(() => undefined);
      } else {
        await loc.click({ timeout: ctx.budgets.controlTimeoutMs }).catch(() => undefined);
      }
      const opened = await waitForOverlay(ctx.page, 3000, baseline);
      if (opened) await waitForOverlayContent(ctx.page, ctx.budgets.controlTimeoutMs, baseline);
      return { opened, baseline };
    }

    case 'valueHelp': {
      const trigger = ctx.page
        .locator(
          `${selector} .sapMInputValHelp, ${selector} .sapMInputValHelpInner, ` +
            `${selector} .sapUiIcon`,
        )
        .first();

      if (await trigger.isVisible().catch(() => false)) {
        await trigger.click({ timeout: ctx.budgets.controlTimeoutMs }).catch(() => undefined);
      } else {
        await loc.click({ timeout: ctx.budgets.controlTimeoutMs }).catch(() => undefined);
      }

      const opened = await waitForOverlay(
        ctx.page,
        Math.min(ctx.budgets.controlTimeoutMs, 8000),
        baseline,
      );
      if (opened) await waitForOverlayContent(ctx.page, ctx.budgets.controlTimeoutMs, baseline);
      return { opened, baseline };
    }

    case 'date':
    case 'dateRange': {
      const icon = ctx.page.locator(`${selector} .sapUiIcon`).first();
      if (await icon.isVisible().catch(() => false)) {
        await icon.click({ timeout: ctx.budgets.controlTimeoutMs }).catch(() => undefined);
      } else {
        await loc.click({ timeout: ctx.budgets.controlTimeoutMs }).catch(() => undefined);
      }

      let opened = await waitForOverlay(
        ctx.page,
        Math.min(ctx.budgets.controlTimeoutMs, 8000),
        baseline,
      );

      // See the long-standing note on this fallback: F4 is UI5's own
      // theme/version-independent "open this control's picker" convention.
      if (!opened) {
        await loc.focus().catch(() => undefined);
        await ctx.page.keyboard.press('F4').catch(() => undefined);
        opened = await waitForOverlay(
          ctx.page,
          Math.min(ctx.budgets.controlTimeoutMs, 8000),
          baseline,
        );
      }
      return { opened, baseline };
    }

    default:
      return { opened: false, baseline };
  }
}

/**
 * Dropdowns and combo boxes.
 *
 * Opens the list, photographs it expanded, then picks a valid option.
 */
async function handleSelect(
  control: ControlDescriptor,
  ctx: HandlerContext,
): Promise<HandlerResult> {
  const selector = await resolveSelector(ctx.page, control);
  if (!selector) return notFound(control);

  const loc = await reveal(ctx.page, selector);

  const blocked = await ensureInteractable(control, ctx, loc);
  if (blocked) return blocked;

  const { opened, baseline, isNative } = await openControlOverlay(control, ctx, loc, selector);

  if (isNative) {
    const chosen = await selectFirstNativeOption(loc);
    await waitForStability(ctx.page, ctx.budgets.stabilityTimeoutMs);
    await ctx.capture();
    return {
      documented: true,
      note: chosen
        ? `native select set to "${chosen}" (list is OS-rendered)`
        : 'native select had no selectable option',
    };
  }

  // The expanded list is the evidence.
  await ctx.capture();

  if (!opened) {
    return { documented: true, note: 'dropdown did not visibly open' };
  }

  const chosen = await selectFirstOption(ctx.page, ctx.budgets.controlTimeoutMs, baseline);
  await captureDebugFrame(ctx.page, control, 'after-select');
  await closeOverlay(ctx.page, undefined, baseline);
  await waitForStability(ctx.page, ctx.budgets.stabilityTimeoutMs);

  return {
    documented: true,
    ...(chosen ? { note: `selected "${chosen}"` } : {}),
  };
}

/**
 * Clicks a selectable day in an open UI5 calendar.
 *
 * Day cells carry `data-sap-day="YYYYMMDD"`; cells outside the displayed month
 * or otherwise unavailable are marked `aria-disabled`. Today's cell is
 * preferred when it is selectable, since a date the application already
 * considers current is the least likely to fail validation.
 *
 * Returns the chosen date, or null when no calendar day could be clicked.
 */
async function pickCalendarDay(page: Page): Promise<string | null> {
  const cells = page.locator(
    '.sapUiCalItem[data-sap-day]:not([aria-disabled="true"]):not(.sapUiCalItemOtherMonth)',
  );

  const count = await cells.count().catch(() => 0);
  if (count === 0) return null;

  const today = page
    .locator('.sapUiCalItemNow[data-sap-day]:not([aria-disabled="true"])')
    .first();
  const target = (await today.count().catch(() => 0)) > 0 ? today : cells.first();

  const day = await target.getAttribute('data-sap-day').catch(() => null);
  const clicked = await target
    .click({ timeout: 5000 })
    .then(() => true)
    .catch(() => false);

  if (!clicked) return null;
  await page.waitForTimeout(250);
  return day;
}

/** Chooses the first meaningful option of a native <select>. */
async function selectFirstNativeOption(loc: Locator): Promise<string | null> {
  const options = await loc
    .evaluate((el: Element) =>
      Array.from((el as HTMLSelectElement).options)
        .filter((o) => !o.disabled && o.value !== '')
        .map((o) => ({ value: o.value, label: o.label || o.textContent || '' })),
    )
    .catch(() => [] as { value: string; label: string }[]);

  const first = options[0];
  if (!first) return null;

  await loc.selectOption(first.value, { timeout: 5000 }).catch(() => undefined);
  return first.label.trim() || first.value;
}

/**
 * Date and date-range pickers.
 *
 * Opens the calendar and photographs it, then sets the value by typing, which is
 * more reliable across UI5 versions than clicking a specific day cell.
 */
async function handleDate(
  control: ControlDescriptor,
  ctx: HandlerContext,
): Promise<HandlerResult> {
  const selector = await resolveSelector(ctx.page, control);
  if (!selector) return notFound(control);

  const loc = await reveal(ctx.page, selector);

  const blocked = await ensureInteractable(control, ctx, loc);
  if (blocked) return blocked;

  const { opened, baseline } = await openControlOverlay(control, ctx, loc, selector);

  // The open calendar is the evidence.
  await ctx.capture();

  /*
   * Prefer picking a day from the open calendar, which is what a tester does
   * and what the reference documents show. It also sidesteps date-format
   * mismatches entirely — the field's own locale formatting is applied by the
   * control rather than guessed at by typing a string.
   */
  if (opened) {
    const picked = await pickCalendarDay(ctx.page);
    await closeOverlay(ctx.page, undefined, baseline);
    if (picked) {
      await waitForStability(ctx.page, ctx.budgets.stabilityTimeoutMs);
      return { documented: true, note: `picked ${picked} from the calendar` };
    }
  }

  // No calendar to pick from: fall back to typing the value.
  const raw = ctx.testData.valueFor(control);
  if (raw) {
    const target = await editableLocator(ctx.page, selector);

    if (control.kind === 'dateRange') {
      const [from, to] = splitRange(raw);
      await target.fill(`${from} - ${to}`, { timeout: 5000 }).catch(() => undefined);
    } else {
      await target.fill(raw, { timeout: 5000 }).catch(() => undefined);
    }
    await ctx.page.keyboard.press('Enter').catch(() => undefined);
  }

  await waitForStability(ctx.page, ctx.budgets.stabilityTimeoutMs);
  return { documented: true };
}

/**
 * Value-help / lookup fields.
 *
 * These must not be typed into: the target system only accepts codes that exist.
 * The handler opens the lookup, photographs it, and selects a real row.
 */
async function handleValueHelp(
  control: ControlDescriptor,
  ctx: HandlerContext,
): Promise<HandlerResult> {
  const selector = await resolveSelector(ctx.page, control);
  if (!selector) return notFound(control);

  const loc = await reveal(ctx.page, selector);

  const blocked = await ensureInteractable(control, ctx, loc);
  if (blocked) return blocked;

  const { opened, baseline } = await openControlOverlay(control, ctx, loc, selector);

  // The open lookup dialog is the evidence.
  await ctx.capture();

  if (!opened) {
    return { documented: true, note: 'value help did not open' };
  }

  /*
   * A lookup dialog carries its own interactive content -- filter fields, a
   * variant selector, its own dropdowns -- exactly as the generic reveal path
   * (probeButton) already explores. Each of those earns its own point, so the
   * dialog is documented as thoroughly as the page that opened it, rather
   * than as a single screenshot of its initial state. `baseline` keeps that
   * nested exploration scoped to the dialog this interaction just opened,
   * not any leftover overlay already on screen alongside it.
   */
  await ctx.exploreRevealed?.(baseline);

  const chosen = await selectFirstOption(ctx.page, ctx.budgets.controlTimeoutMs, baseline);
  if (chosen) await confirmOverlay(ctx.page, baseline);
  await closeOverlay(ctx.page, undefined, baseline);
  await waitForStability(ctx.page, ctx.budgets.stabilityTimeoutMs);

  return {
    documented: true,
    ...(chosen ? { note: `selected "${chosen}"` } : { note: 'no selectable row' }),
  };
}

/** Multi-select controls: open the list, photograph it, tick one entry. */
async function handleMultiSelect(
  control: ControlDescriptor,
  ctx: HandlerContext,
): Promise<HandlerResult> {
  const selector = await resolveSelector(ctx.page, control);
  if (!selector) return notFound(control);

  const loc = await reveal(ctx.page, selector);

  const blocked = await ensureInteractable(control, ctx, loc);
  if (blocked) return blocked;

  const { opened, baseline } = await openControlOverlay(control, ctx, loc, selector);
  await ctx.capture();

  if (opened) {
    const chosen = await selectFirstOption(ctx.page, ctx.budgets.controlTimeoutMs, baseline);
    await closeOverlay(ctx.page, undefined, baseline);
    await waitForStability(ctx.page, ctx.budgets.stabilityTimeoutMs);
    return { documented: true, ...(chosen ? { note: `selected "${chosen}"` } : {}) };
  }
  return { documented: true, note: 'multi-select did not visibly open' };
}

/* ------------------------------------------------------------------ *
 * Toggles
 * ------------------------------------------------------------------ */

/** Checkboxes, switches and radio buttons: toggle, then photograph the result. */
async function handleToggle(
  control: ControlDescriptor,
  ctx: HandlerContext,
): Promise<HandlerResult> {
  const selector = await resolveSelector(ctx.page, control);
  if (!selector) return notFound(control);

  const loc = await reveal(ctx.page, selector);

  const blocked = await ensureInteractable(control, ctx, loc);
  if (blocked) return blocked;

  await loc.click({ timeout: ctx.budgets.controlTimeoutMs }).catch(() => undefined);
  await waitForStability(ctx.page, ctx.budgets.stabilityTimeoutMs);
  await ctx.capture();
  return { documented: true };
}

/**
 * File upload controls.
 *
 * The control is photographed in place; no file is actually uploaded, since
 * uploading would attach real data to a real record.
 */
async function handleFileUpload(
  control: ControlDescriptor,
  ctx: HandlerContext,
): Promise<HandlerResult> {
  const selector = await resolveSelector(ctx.page, control);
  if (!selector) return notFound(control);

  await reveal(ctx.page, selector);
  await ctx.capture();
  return { documented: true, note: 'upload control captured without uploading' };
}

/* ------------------------------------------------------------------ *
 * Buttons
 * ------------------------------------------------------------------ */

/**
 * Buttons, whose kind cannot be known without trying them.
 *
 * Fingerprints the page, clicks, and compares: new UI means this was a reveal
 * button (a documentation point); an unchanged page means it was a pure action
 * button (no point). Deny-listed buttons are never clicked at all.
 */
/**
 * TEMPORARY diagnostic: raw viewport screenshot taken immediately after a
 * selector-driven click, before any wait or overlay teardown, so the moment
 * right after `selectFirstOption()` picked something is visible directly --
 * rather than inferred from `chosen` text or the timing of later failures.
 * Written outside the evidence store entirely (its own folder, DEBUG- prefix)
 * so it can never become a documentation point or affect sequencing. Remove
 * once the redraw mechanism triggered by a real dropdown selection is
 * confirmed.
 */
async function captureDebugFrame(
  page: Page,
  control: ControlDescriptor,
  tag: string,
): Promise<void> {
  try {
    const dir = path.join(process.cwd(), 'output', 'debug');
    await mkdir(dir, { recursive: true });
    const safeLabel = (control.canonicalLabel || control.label || control.id)
      .replace(/[^a-zA-Z0-9._-]+/g, '_')
      .slice(0, 60);
    const file = path.join(
      dir,
      `DEBUG-${Date.now()}-${safeLabel}-${tag}.png`,
    );
    await page.screenshot({ path: file });
    log.debug(`  [debug] captured ${file}`);
  } catch {
    /* diagnostic only -- must never break a real run */
  }
}

export async function probeButton(
  control: ControlDescriptor,
  ctx: HandlerContext,
): Promise<HandlerResult> {
  const verdict = mayClick(control.label, ctx.safety);
  if (!verdict.allowed) {
    log.debug(`skipping unsafe button: ${verdict.reason}`);
    return {
      documented: false,
      reclassifiedAs: 'actionButton',
      note: `not clicked (${verdict.reason})`,
    };
  }

  const selector = await resolveSelector(ctx.page, control);
  if (!selector) return { ...notFound(control), reclassifiedAs: 'actionButton' };

  const loc = await reveal(ctx.page, selector);

  const blocked = await ensureInteractable(control, ctx, loc);
  if (blocked) return { ...blocked, reclassifiedAs: 'actionButton' };

  /*
   * UI5 fingerprint alone misses a plain DOM change on a page with no UI5
   * controls — a generic backdrop or panel appearing, for instance — so a
   * general DOM fingerprint is combined in as well. Either signal changing
   * counts as "revealed something".
   */
  const snapshot = async () => ({
    fingerprint: `${await ui5Fingerprint(ctx.page)}||${await domFingerprint(ctx.page)}`,
    overlays: await overlayCount(ctx.page),
    url: ctx.page.url(),
  });

  // Snapshot before opening anything — see `overlayBaseline`. Kept separate
  // from `before.overlays` above: that raw count is what detects whether a
  // new overlay appeared at all; this identifies *which* ones existed
  // already, so the actions below can be scoped to whatever is new.
  const baseline = await overlayBaseline(ctx.page);
  const before = await snapshot();
  await loc.click({ timeout: ctx.budgets.controlTimeoutMs }).catch(() => undefined);
  await waitForStability(ctx.page, ctx.budgets.stabilityTimeoutMs);
  const after = await snapshot();

  const openedOverlay = after.overlays > before.overlays;
  const navigated = after.url !== before.url;
  const changed = after.fingerprint !== before.fingerprint;

  if (openedOverlay) {
    /*
     * A button that merely raises a validation message has not revealed a
     * workflow step, so it is an action button and earns no point.
     */
    const top = await inspectTopDialog(ctx.page);
    if (top?.isMessage) {
      await acknowledgeMessageDialogs(ctx.page, {
        max: 3,
        stabilityMs: ctx.budgets.stabilityTimeoutMs,
      });
      return {
        documented: false,
        reclassifiedAs: 'actionButton',
        note: `raised a message: ${top.title || top.text.slice(0, 60)}`,
      };
    }

    /*
     * The dialog appears before its rows arrive, exactly as for a dedicated
     * value-help field (see handleValueHelp): a button that turns out to
     * open a lookup dialog goes through this generic reveal path instead,
     * and without the same wait its evidence would show a busy indicator or
     * a "Loading......" placeholder rather than the settled result (real
     * rows, or a definitive "No data found").
     */
    await waitForOverlayContent(ctx.page, ctx.budgets.controlTimeoutMs, baseline);

    // A dialog is inline evidence on the parent page: photograph it, fill in
    // whatever it revealed while it is still open, then dismiss it.
    await ctx.capture();
    await ctx.exploreRevealed?.(baseline);
    await closeOverlay(ctx.page, undefined, baseline);
    await waitForStability(ctx.page, ctx.budgets.stabilityTimeoutMs);
    return { documented: true, reclassifiedAs: 'revealButton', note: 'opened dialog' };
  }

  if (navigated || changed) {
    // The destination is the evidence for this point; a genuine navigation is
    // additionally flagged so the explorer treats it as a real child page
    // (fully explored, then verified back) rather than in-place content.
    await ctx.capture();
    return {
      documented: true,
      reclassifiedAs: 'revealButton',
      note: navigated ? 'navigated to new page' : 'revealed new UI',
      ...(navigated ? { navigatedAway: true } : {}),
    };
  }

  return { documented: false, reclassifiedAs: 'actionButton', note: 'no visible change' };
}

/* ------------------------------------------------------------------ *
 * Registry
 * ------------------------------------------------------------------ */

export type Handler = (
  control: ControlDescriptor,
  ctx: HandlerContext,
) => Promise<HandlerResult>;

const HANDLERS: Partial<Record<ControlKind, Handler>> = {
  input: handleTextual,
  textarea: handleTextual,
  select: handleSelect,
  date: handleDate,
  dateRange: handleDate,
  valueHelp: handleValueHelp,
  multiSelect: handleMultiSelect,
  checkbox: handleToggle,
  radio: handleToggle,
  fileUpload: handleFileUpload,
  revealButton: probeButton,
  actionButton: probeButton,
};

/** Returns the handler for a control kind, or null when it is not interactive. */
export function handlerFor(kind: ControlKind): Handler | null {
  return HANDLERS[kind] ?? null;
}

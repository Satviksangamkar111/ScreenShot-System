import type { Page } from '../automation/types.js';
import type { ControlDescriptor } from '../types.js';
import type { ManualGate } from '../state/manualGate.js';
import type { RemoteControl } from '../server/remoteControl.js';
import {
  editableLocator,
  ensureInteractable,
  notFound,
  openControlOverlay,
  resolveSelector,
  reveal,
  type HandlerContext,
  type HandlerResult,
} from './handlers.js';
import { log } from '../util/logger.js';

/**
 * Manual data-entry step.
 *
 * Runs in place of a control's normal handler when the operator selected
 * Manual mode. Everything up to "found and interactable" is the exact same
 * pipeline Automatic mode uses (`resolveSelector`, `reveal`,
 * `ensureInteractable`) — this only replaces the fill itself: instead of
 * clicking/typing/selecting, it scrolls the control into view, highlights it
 * in the visible browser window so the operator can find it, and waits for
 * confirmation from the web UI before capturing the same way `ctx.capture()`
 * always has.
 */
export async function runManualStep(
  control: ControlDescriptor,
  ctx: HandlerContext,
  gate: ManualGate,
  remote?: RemoteControl,
): Promise<HandlerResult> {
  const selector = await resolveSelector(ctx.page, control);
  if (!selector) {
    gate.setItemStatus(control.dedupeKey, 'skipped');
    return notFound(control);
  }

  const loc = await reveal(ctx.page, selector);

  const blocked = await ensureInteractable(control, ctx, loc);
  if (blocked) {
    gate.setItemStatus(control.dedupeKey, 'waiting');
    return blocked;
  }

  await highlight(ctx.page, selector);

  /*
   * Dropdowns, calendars and lookups all hide a trigger the operator would
   * otherwise have to find and click themselves inside the live view before
   * they could even see what to pick from -- confirmed as a real friction
   * point on a live run (Company Code's value-help icon). Automatic mode
   * already knows exactly how to open each of these kinds; reused verbatim
   * via `openControlOverlay` (the same function, same selectors) so the
   * operator's very first frame already shows the open list/calendar/dialog,
   * ready to click into. Deliberately NOT extended to actionButton/
   * revealButton: those may perform a real action or reveal something
   * unknown, which manual mode leaves entirely to the operator's own
   * judgement rather than clicking on their behalf.
   */
  if (
    control.kind === 'select' ||
    control.kind === 'multiSelect' ||
    control.kind === 'valueHelp' ||
    control.kind === 'date' ||
    control.kind === 'dateRange'
  ) {
    await openControlOverlay(control, ctx, loc, selector).catch(() => undefined);
  } else if (control.kind === 'input' || control.kind === 'textarea') {
    /*
     * The text box in the web UI sends typed characters via
     * `page.keyboard.insertText`, which lands wherever the REAL page's DOM
     * focus currently is -- not wherever the operator is looking. Nothing
     * up to this point ever focuses the field itself (`highlight()` only
     * draws an outline), so a field became active, the operator typed
     * straight into the box, and the keystrokes landed nowhere (or on
     * whatever the previous field left focused) unless they first clicked
     * the exact right pixel inside the live image. Same fix as the overlay
     * auto-open above, for the same reason: resolve the real editable
     * element (the wrapper's inner <input>, same as Automatic mode's
     * `handleTextual`) and focus it automatically. Triple-click selects any
     * existing value so the operator's typed text replaces it, matching
     * `fill()`'s full-replace behaviour in Automatic mode, rather than
     * inserting in the middle of or after whatever was already there.
     */
    const target = await editableLocator(ctx.page, selector);
    await target
      .click({ timeout: ctx.budgets.controlTimeoutMs, clickCount: 3 })
      .catch(() => undefined);
  }

  const label = control.canonicalLabel || control.label || control.id;
  log.debug(`  [manual] waiting on operator for "${label}"`);

  await remote?.start();

  let action: 'submit' | 'skip';
  try {
    action = await gate.activate(control.dedupeKey);
  } finally {
    await remote?.stop();
    await unhighlight(ctx.page);
  }

  if (action === 'skip') {
    gate.setItemStatus(control.dedupeKey, 'skipped');
    return { documented: false, note: 'skipped by operator (manual mode)' };
  }

  await ctx.capture();
  gate.setItemStatus(control.dedupeKey, 'completed');
  return { documented: true };
}

const HIGHLIGHT_ATTR = 'data-ui-doc-engine-active';

/** Adds a visible outline so the operator can spot the active control. */
async function highlight(page: Page, selector: string): Promise<void> {
  await page
    .locator(selector)
    .first()
    .evaluate((el: Element, attr: string) => {
      const target = el as HTMLElement;
      target.setAttribute(attr, '1');
      target.style.setProperty('outline', '3px solid #e11d48', 'important');
      target.style.setProperty('outline-offset', '2px', 'important');
    }, HIGHLIGHT_ATTR)
    .catch(() => undefined);
}

/** Removes the highlight added by `highlight()`. */
async function unhighlight(page: Page): Promise<void> {
  await page
    .locator(`[${HIGHLIGHT_ATTR}]`)
    .first()
    .evaluate((el: Element, attr: string) => {
      const target = el as HTMLElement;
      target.removeAttribute(attr);
      target.style.removeProperty('outline');
      target.style.removeProperty('outline-offset');
    }, HIGHLIGHT_ATTR)
    .catch(() => undefined);
}

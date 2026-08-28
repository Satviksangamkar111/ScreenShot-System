import type { Page } from '../automation/types.js';
import { waitForStability } from '../browser/stability.js';
import { log } from '../util/logger.js';

/**
 * Modal dialog handling.
 *
 * Two kinds of dialog matter and must be treated differently:
 *
 *  - A *message* dialog reports something ("Both Account Group and Sales Org is
 *    mandatory") and offers only an acknowledgement. It is incidental to the
 *    workflow, so it is dismissed with its own OK button and never documented.
 *
 *  - A *chooser* dialog asks the user to pick between alternatives ("Customer
 *    Category: Organization / Person"). Each alternative leads to a different
 *    workflow, so it is a branch point: every option must be explored.
 */

/** Labels that merely dismiss or acknowledge a dialog. */
const ACKNOWLEDGE_LABELS = ['ok', 'close', 'dismiss', 'continue', 'got it'];
const CANCEL_LABELS = ['cancel', 'back', 'no'];

export interface DialogOption {
  label: string;
  /** Index within the dialog's actionable elements, used for clicking. */
  index: number;
}

export interface DialogInfo {
  /** Dialog heading, when it has one. */
  title: string;
  text: string;
  /** Choices that are not simple acknowledgements. */
  options: DialogOption[];
  /** True when the only actions are acknowledgements. */
  isMessage: boolean;
}

/** Attribute stamped on the element a probe selected, so it can then be clicked. */
const MARK_ATTR = 'data-uidoc-target';

interface DialogProbeArgs {
  ack: string[];
  cancel: string[];
  /** Mark the actionable carrying this label. */
  markLabel?: string;
  /** Mark the first acknowledgement-style action instead. */
  markAck?: boolean;
  markAttr?: string;
}

interface DialogProbeResult {
  title: string;
  text: string;
  options: DialogOption[];
  isMessage: boolean;
  /** Label of the element that was marked, or null when nothing was. */
  marked: string | null;
}

/**
 * Finds the topmost visible dialog and, optionally, marks one of its actions.
 *
 * Describing a dialog and acting on it are the same problem — *which dialog,
 * and which element inside it* — so they are one routine rather than two that
 * can disagree. They previously did disagree: `inspectTopDialog` located an
 * option precisely, then `chooseOption` threw that away and re-found it with a
 * text selector, which could match a different (even hidden, leftover) dialog,
 * and resolved to the smallest element holding the text rather than the one
 * the framework listens on.
 *
 * The saved pages show why that last part matters. In the Customer Category
 * chooser the text "Organization" belongs to a bare `div.sapMSLITitleOnly`
 * nested four levels inside `li#__item28[role=option]`, which is the element
 * carrying the press handler. Marking is therefore applied to the entry from
 * this dialog's own actionable list — a `button` or `[role=option]`/`li` — and
 * never to whatever node happens to contain the text.
 *
 * Runs in the page; it is serialised to source, so it takes everything it
 * needs as arguments and holds no references to module scope.
 */
function probeTopDialog(args: DialogProbeArgs): DialogProbeResult | null {
  const ack = args.ack;
  const cancel = args.cancel;
  const markAttr = args.markAttr || 'data-uidoc-target';

  const visible = (el: Element): boolean => {
    const r = (el as HTMLElement).getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const s = getComputedStyle(el as HTMLElement);
    return s.visibility !== 'hidden' && s.display !== 'none';
  };
  const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

  const dialogs = Array.from(
    document.querySelectorAll('.sapMDialog, [role="dialog"], dialog[open]'),
  ).filter(visible) as HTMLElement[];
  if (dialogs.length === 0) return null;

  // Topmost = greatest z-index, falling back to document order.
  const top = dialogs
    .map((d) => {
      let z = 0;
      let node: HTMLElement | null = d;
      while (node) {
        const v = parseInt(getComputedStyle(node).zIndex || '0', 10);
        if (!Number.isNaN(v) && v > z) z = v;
        node = node.parentElement;
      }
      return { d, z };
    })
    .sort((a, b) => a.z - b.z)
    .at(-1)!.d;

  const titleEl = top.querySelector(
    '.sapMDialogTitle, .sapMTitle, h1, h2, h3, [role="heading"]',
  );
  const title = norm((titleEl as HTMLElement | null)?.innerText || '');

  // Everything the user could act on inside this dialog.
  const actionables = Array.from(
    top.querySelectorAll(
      'button, [role="button"], li, .sapMSLI, .sapMLIB, tbody tr, [role="option"]',
    ),
  ).filter(visible) as HTMLElement[];

  const seen: Record<string, boolean> = {};
  const entries: {
    label: string;
    index: number;
    isAck: boolean;
    isCancel: boolean;
  }[] = [];

  actionables.forEach((el, index) => {
    // Skip wrappers whose text merely repeats a nested control.
    if (el.querySelector('button, [role="button"], li, .sapMSLI')) return;

    const label = norm(el.innerText || el.getAttribute('aria-label') || '');
    if (!label) return;
    const key = label.toLowerCase();
    if (seen[key]) return;
    seen[key] = true;

    entries.push({
      label,
      index,
      isAck: ack.indexOf(key) !== -1,
      isCancel: cancel.indexOf(key) !== -1,
    });
  });

  const options = entries
    .filter((e) => !e.isAck && !e.isCancel)
    .map((e) => ({ label: e.label, index: e.index }));

  /*
   * A dialog that only offers an OK/Cancel with no button-like options is
   * usually a message — but not always: a filter or settings dialog can
   * be exactly that shape while still containing real fields to explore
   * (inputs, selects, checkboxes). Fillable content always means it is
   * not a message, regardless of how few buttons it has.
   */
  const hasFillableContent =
    Array.from(
      top.querySelectorAll(
        'input:not([type="hidden"]):not([type="button"]):not([type="submit"]), ' +
          'textarea, select, [contenteditable="true"], ' +
          '[role="combobox"], [role="checkbox"], [role="radio"], [role="switch"]',
      ),
    ).filter(visible).length > 0;

  let marked: string | null = null;
  if (args.markLabel !== undefined || args.markAck) {
    const previous = document.querySelectorAll('[' + markAttr + ']');
    for (let i = 0; i < previous.length; i++) previous[i]?.removeAttribute(markAttr);

    let chosen: { label: string; index: number } | undefined;
    if (args.markAck) {
      chosen = entries.filter((e) => e.isAck)[0];
    } else {
      const wanted = norm(args.markLabel || '');
      chosen =
        entries.filter((e) => e.label === wanted)[0] ||
        entries.filter((e) => e.label.toLowerCase() === wanted.toLowerCase())[0];
    }

    if (chosen) {
      const el = actionables[chosen.index];
      if (el) {
        el.setAttribute(markAttr, '1');
        marked = chosen.label;
      }
    }
  }

  return {
    title,
    text: norm(top.innerText || '').slice(0, 400),
    options,
    isMessage: options.length === 0 && !hasFillableContent,
    marked,
  };
}

/**
 * Describes the topmost visible dialog.
 *
 * When dialogs are stacked, the one with the highest stacking order is the one
 * the user must deal with first.
 */
export async function inspectTopDialog(page: Page): Promise<DialogInfo | null> {
  return page
    .evaluate(probeTopDialog, {
      ack: ACKNOWLEDGE_LABELS,
      cancel: CANCEL_LABELS,
    })
    .catch(() => null);
}

/** Removes any leftover mark, so a stale one can never be clicked later. */
async function clearMark(page: Page): Promise<void> {
  await page
    .evaluate((attr: string) => {
      const marked = document.querySelectorAll('[' + attr + ']');
      for (let i = 0; i < marked.length; i++) marked[i]?.removeAttribute(attr);
    }, MARK_ATTR)
    .catch(() => undefined);
}

/**
 * Marks one of the top dialog's actions in the page, then clicks it.
 *
 * Marking and clicking are separate steps because the click has to go through
 * the normal locator path — real mouse input at the element's centre, after
 * scrolling it into view — rather than a synthetic `el.click()`, which UI5
 * list items do not always honour. The attribute is the handoff between the
 * two, and is cleared afterwards either way.
 */
async function markAndClick(
  page: Page,
  args: Omit<DialogProbeArgs, 'ack' | 'cancel' | 'markAttr'>,
  timeoutMs: number,
): Promise<string | null> {
  const probe = await page
    .evaluate(probeTopDialog, {
      ack: ACKNOWLEDGE_LABELS,
      cancel: CANCEL_LABELS,
      markAttr: MARK_ATTR,
      ...args,
    })
    .catch(() => null);

  if (!probe?.marked) {
    await clearMark(page);
    return null;
  }

  const clicked = await page
    .locator(`[${MARK_ATTR}]`)
    .first()
    .click({ timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);

  await clearMark(page);
  return clicked ? probe.marked : null;
}

/**
 * Clicks through message dialogs until none remain.
 *
 * Acknowledgement is preferred over Escape: an application that raised a
 * validation message may re-raise it, and pressing its own OK button is what a
 * tester would do. Chooser dialogs are left untouched.
 */
export async function acknowledgeMessageDialogs(
  page: Page,
  opts: { max?: number; stabilityMs?: number } = {},
): Promise<string[]> {
  const max = opts.max ?? 6;
  const stabilityMs = opts.stabilityMs ?? 6000;
  const acknowledged: string[] = [];

  for (let i = 0; i < max; i++) {
    const dialog = await inspectTopDialog(page);
    if (!dialog || !dialog.isMessage) break;

    const signature = `${dialog.title}||${dialog.text}`;

    /*
     * Scoped to the dialog actually on top. The previous selector was not: it
     * searched every dialog in the document for a button reading OK, so a
     * stacked or leftover dialog underneath could supply the button that got
     * clicked while the one in front stayed up.
     */
    const clicked = (await markAndClick(page, { markAck: true }, 1500)) !== null;

    if (!clicked) {
      // Some message dialogs only offer Escape.
      await page.keyboard.press('Escape').catch(() => undefined);
    }
    await page.waitForTimeout(300);

    /*
     * The previous version logged "acknowledged" and looped again regardless
     * of whether anything actually closed, which meant an un-dismissable
     * dialog (no matching button, no Escape handler) silently burned every
     * remaining iteration's full stability wait for nothing. Verifying against
     * the same signature catches that immediately instead.
     */
    const still = await inspectTopDialog(page);
    if (still && `${still.title}||${still.text}` === signature) {
      log.warn(
        `  could not dismiss message dialog (no Close/OK/Escape worked): ` +
          `${dialog.title || dialog.text.slice(0, 60)}`,
      );
      break;
    }

    acknowledged.push(dialog.title || dialog.text.slice(0, 80));
    log.info(
      `  acknowledged message dialog: ${dialog.title || dialog.text.slice(0, 60)}`,
    );
    await waitForStability(page, stabilityMs).catch(() => undefined);
  }

  return acknowledged;
}

/**
 * Clears the topmost dialog when it is a message, leaving anything else alone.
 *
 * Filling a required field often makes the application raise a validation
 * message, which then covers the very control being documented. Clearing it
 * immediately before a screenshot keeps the evidence showing the workflow
 * rather than an incidental popup.
 *
 * Returns true when a message was dismissed.
 */
export async function acknowledgeIfMessage(
  page: Page,
  stabilityMs = 6000,
): Promise<boolean> {
  const dialog = await inspectTopDialog(page);
  if (!dialog || !dialog.isMessage) return false;
  const cleared = await acknowledgeMessageDialogs(page, { max: 3, stabilityMs });
  return cleared.length > 0;
}

/**
 * Returns the chooser dialog currently blocking the workflow, if any.
 *
 * A chooser offers at least two real alternatives; anything with fewer is
 * either a message or a single-path confirmation and is not a branch point.
 */
export async function detectChooser(page: Page): Promise<DialogInfo | null> {
  const dialog = await inspectTopDialog(page);
  if (!dialog || dialog.isMessage) return null;
  if (dialog.options.length < 2) return null;
  return dialog;
}

/**
 * Hides a chooser dialog that is still present after its option was taken.
 *
 * Selecting an option is expected to close its own dialog, the way a picker
 * or popover normally would. A real capture of this workflow shows that this
 * application's own chooser does not: its dialog stayed `visibility: visible`
 * well into the form that followed, its original option list still live in
 * the DOM. Every overlay-aware helper in this codebase scans for dialogs
 * indiscriminately, and `selectFirstOption`'s broadest fallback (`.sapMDialog
 * li`) matched that leftover list on a field whose own popup happened not to
 * match any of the narrower selectors tried first -- silently re-selecting
 * the branch already taken and resetting the whole workflow underneath the
 * field actually being documented.
 *
 * Escape/Cancel are not tried first, unlike `closeOverlay`: a dialog the
 * application itself keeps open, rather than one merely left mid-interaction,
 * has already shown neither works on it. Hidden rather than removed, so nothing
 * in the framework's own bookkeeping trips over a DOM node it still expects to
 * exist; hidden is already enough to drop it from every visibility check the
 * overlay helpers use (`getBoundingClientRect` and `display`/`visibility`).
 *
 * Matched purely by the title `detectChooser` already read from this
 * dialog at run time, so this works for any chooser in any application the
 * engine targets, not just the one it was found against.
 */
export async function hideConsumedChooser(page: Page, title: string): Promise<void> {
  const t = title.trim();
  if (!t) return;
  await page
    .evaluate((needle: string) => {
      const dialogs = Array.from(
        document.querySelectorAll('.sapMDialog, [role="dialog"], dialog[open]'),
      );
      for (const d of dialogs) {
        const titleEl = d.querySelector(
          '.sapMDialogTitle, .sapMTitle, h1, h2, h3, [role="heading"]',
        );
        const dTitle = (titleEl as HTMLElement | null)?.innerText?.trim() ?? '';
        if (dTitle === needle) {
          (d as HTMLElement).style.setProperty('display', 'none', 'important');
        }
      }
    }, t)
    .catch(() => undefined);
}

/**
 * Clicks one of a chooser's options by its visible label.
 *
 * The option is located by the same routine that listed it in the first place,
 * against the dialog that is topmost *now* — so a re-render between listing and
 * choosing changes which element is clicked, not whether the click lands on the
 * right thing.
 */
export async function chooseOption(
  page: Page,
  label: string,
  timeoutMs: number,
): Promise<boolean> {
  const marked = await markAndClick(page, { markLabel: label }, timeoutMs);
  return marked !== null;
}

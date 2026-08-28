import type { Page } from '../automation/types.js';

/**
 * UI5 control-registry introspection.
 *
 * SAP Fiori exposes a live registry of framework controls. Reading it gives
 * authoritative control types, editability and label associations, which is far
 * more reliable than inferring intent from DOM shape. Everything in this file
 * runs inside the page and must therefore be self-contained.
 */

/** A control as reported by the UI5 runtime. */
export interface Ui5RawControl {
  controlId: string;
  controlType: string;
  label: string;
  section: string;
  domId: string;
  domOrder: number;
  visible: boolean;
  enabled: boolean;
  editable: boolean;
  required: boolean;
  /** True for sap.m.Input controls with the value-help (F4) affordance. */
  showValueHelp: boolean;
  /** Button text, for reveal-vs-action classification. */
  text: string;
  /**
   * True when this control is a currently-open disclosure toggle
   * (`aria-expanded="true"` on its own DOM ref) — an accordion/panel header
   * built from `sap.m.Button` or similar rather than a plain DOM element.
   * Clicking it would collapse already-visible content rather than reveal
   * anything; see `ControlDescriptor.alreadyExpanded`.
   */
  alreadyExpanded: boolean;
}

/** True when the page is running SAP UI5. */
export async function hasUi5(page: Page): Promise<boolean> {
  return page
    .evaluate(() => {
      const w = window as unknown as Record<string, any>;
      return !!(w['sap'] && w['sap'].ui && (w['sap'].ui.getCore || w['sap'].ui.require));
    })
    .catch(() => false);
}

/**
 * Enumerates visible UI5 controls in document order.
 *
 * Handles both the modern `sap.ui.core.Element.registry` and the legacy
 * `sap.ui.getCore().byId` traversal, since Fiori landscapes commonly run
 * different UI5 versions across environments — exactly the old/new case here.
 */
export async function probeUi5Controls(page: Page): Promise<Ui5RawControl[]> {
  return page
    .evaluate(() => {
      const w = window as unknown as Record<string, any>;
      const sap = w['sap'];
      if (!sap?.ui) return [] as Ui5RawControl[];

      interface Ui5RawControl {
        controlId: string;
        controlType: string;
        label: string;
        section: string;
        domId: string;
        domOrder: number;
        visible: boolean;
        enabled: boolean;
        editable: boolean;
        required: boolean;
        showValueHelp: boolean;
        text: string;
        alreadyExpanded: boolean;
      }

      /** Collects every registered element across UI5 versions. */
      const collect = (): any[] => {
        const out: any[] = [];
        try {
          const registry = sap.ui.core?.Element?.registry;
          if (registry?.forEach) {
            registry.forEach((el: any) => out.push(el));
            if (out.length) return out;
          }
        } catch {
          /* fall through to legacy traversal */
        }
        try {
          const core = sap.ui.getCore?.();
          const elements = core?.mElements;
          if (elements && typeof elements === 'object') {
            for (const key of Object.keys(elements)) out.push(elements[key]);
            if (out.length) return out;
          }
        } catch {
          /* fall through to the rendered-markup traversal */
        }
        /*
         * Pre-registry releases -- the "old version" landscape runs UI5 1.24,
         * and neither path above can see a single control on it.
         * `Element.registry` did not exist before 1.67, and the registry that
         * preceded it, `mElements`, is a private field of the Core *instance*
         * while `sap.ui.getCore()` hands back only the Core's public interface
         * facade, which does not carry it. So this probe returned an empty
         * list for a form that was plainly on screen, and every field fell
         * through to the DOM probe instead -- which cannot tell a Select from
         * a button or a DatePicker from a lookup, and mislabels both.
         *
         * What such a release does expose is its own rendered markup: UI5
         * writes each control's id onto that control's element as
         * `data-sap-ui`, and `byId` *is* on the public facade. Walking the DOM
         * and resolving each id therefore recovers the live control objects.
         * This finds only *rendered* controls, which is all any caller here
         * uses -- every one of them already discards a control with no DOM
         * reference.
         */
        try {
          const core = sap.ui.getCore?.();
          if (typeof core?.byId === 'function') {
            const seen = new Set<string>();
            for (const node of Array.from(
              document.querySelectorAll('[data-sap-ui]'),
            )) {
              const id = node.getAttribute('data-sap-ui');
              if (!id || seen.has(id)) continue;
              seen.add(id);
              const el = core.byId(id);
              if (el) out.push(el);
            }
          }
        } catch {
          /* no control registry reachable at all */
        }
        return out;
      };

      const safe = <T,>(fn: () => T, fallback: T): T => {
        try {
          const v = fn();
          return v === undefined || v === null ? fallback : v;
        } catch {
          return fallback;
        }
      };

      /** Resolves a control's label via UI5 label association, then ARIA. */
      const labelOf = (el: any, dom: HTMLElement | null): string => {
        // 1. UI5 label association (most reliable).
        const byAssoc = safe(() => {
          const labels = el.getLabels?.();
          if (Array.isArray(labels) && labels.length) {
            const t = labels[0]?.getText?.();
            if (t) return String(t);
          }
          const labelledBy = el.getAriaLabelledBy?.();
          if (Array.isArray(labelledBy) && labelledBy.length) {
            const lbl = sap.ui.getCore?.().byId?.(labelledBy[0]);
            const t = lbl?.getText?.();
            if (t) return String(t);
          }
          return '';
        }, '');
        if (byAssoc) return byAssoc;

        // 2. LabelEnablement, which knows about form-layout labelling.
        const byEnablement = safe(() => {
          const LE = sap.ui.core?.LabelEnablement;
          const refs = LE?.getReferencingLabels?.(el);
          if (Array.isArray(refs) && refs.length) {
            const lbl = sap.ui.getCore?.().byId?.(refs[0]);
            const t = lbl?.getText?.();
            if (t) return String(t);
          }
          return '';
        }, '');
        if (byEnablement) return byEnablement;

        // 3. DOM-level ARIA / adjacent <label>.
        if (dom) {
          const aria = dom.getAttribute('aria-label');
          if (aria) return aria;
          const id = dom.id;
          if (id) {
            const forLabel = document.querySelector<HTMLElement>(
              `label[for="${CSS.escape(id)}"]`,
            );
            if (forLabel?.innerText) return forLabel.innerText;
          }

          /*
           * 4. Borrow the label of the field this control sits beside — but
           * only when the control has no textual identity of its own. A
           * "Search" or "Go" button placed inside the same form row as a
           * labelled field already has real text of its own (caught by the
           * `text` property below) and must keep it; overriding it here
           * would relabel every action button as whatever field happens to
           * share its row.
           *
           * The case this exists for is different: an icon-only match-code
           * lookup trigger — a genuinely separate sap.m.Button placed beside
           * a plain Input rather than that Input's own showValueHelp
           * affordance — has no text, no ARIA label, and no UI5 label
           * association at all. Left unlabelled, it fails
           * hasMeaningfulLabel() and the explorer silently skips it forever,
           * which is exactly the "Company Code lookup never gets clicked"
           * failure this recovers.
           */
          const ownText = safe(
            () => String(el.getText?.() || el.getTitle?.() || el.getHeaderText?.() || ''),
            '',
          ).trim();
          if (!ownText) {
            const group = dom.closest(
              '.sapUiFormElement, .sapMFormElement, .sapMListItem, tr, .row, [class*="field"]',
            );
            if (group) {
              const lbl = group.querySelector<HTMLElement>(
                '.sapMLabel, .sapUiFormLabel, label',
              );
              if (lbl?.innerText?.trim()) return lbl.innerText.trim();
            }
          }
        }
        return '';
      };

      /** Walks up the UI5 parent chain for an enclosing section title. */
      const sectionOf = (el: any): string => {
        let node = safe(() => el.getParent?.(), null);
        let hops = 0;
        while (node && hops < 12) {
          const type = safe(() => node.getMetadata?.().getName?.(), '') as string;
          if (
            /\.(Panel|IconTabFilter|ObjectPageSection|ObjectPageSubSection|Dialog|FormContainer|Page)$/.test(
              type,
            )
          ) {
            const title =
              safe(() => node.getTitle?.(), '') ||
              safe(() => node.getText?.(), '') ||
              safe(() => node.getHeaderText?.(), '');
            if (title && typeof title === 'string') return title;
            const titleObj = safe(() => node.getTitle?.()?.getText?.(), '');
            if (titleObj) return String(titleObj);
          }
          node = safe(() => node.getParent?.(), null);
          hops++;
        }
        return '';
      };

      const results: Ui5RawControl[] = [];
      const elements = collect();

      /*
       * The application versus the launchpad shell around it.
       *
       * Everything the shell renders -- header, side navigation, app-finder --
       * leads OUT of the application being documented, so following any of it
       * abandons the form mid-run: the closing "Full Page" then photographs
       * the launchpad instead of the finished form.
       *
       * Naming the shell's own markup cannot do this job. The two landscapes
       * this engine targets disagree on every such name: the older shell's
       * header is `#shell-hdr` under theme `sap_bluecrystal`, the newer one's
       * is `#shell-header` under Horizon, and a check for either is simply
       * dead code against the other. Per-UIArea separation is no better --
       * the older shell puts its chrome and the hosted application in one
       * shared `canvas` UIArea, so the two are indistinguishable by UIArea.
       *
       * What both landscapes DO agree on is UI5's own view scoping. A control
       * declared inside an XML view is registered as `<viewId>--<controlId>`
       * (`__xmlview2--DueDateId`, `__xmlview7--AccountHolderName`), while the
       * shell's controls carry no view scope at all. The view holding the most
       * controls is therefore the application's own, and its DOM element is a
       * subtree the shell is definitionally outside of.
       *
       * The view element alone is slightly too narrow: an application's footer
       * actions (Submit, Cancel, Share) are rendered by its container rather
       * than inside the view, so the subtree is widened to the outermost
       * ancestor still identifying itself with the current route -- the
       * launchpad names each running application's container after the intent
       * that launched it, and `semanticObjectOf` in the explorer already
       * relies on that same route identity. That container holds the view and
       * the footer, and still excludes the shell.
       */
      /*
       * Popups (value-help dialogs, dropdown lists, date pickers) are rendered
       * into UI5's static area, outside the application container, so they
       * would otherwise be filtered out along with the shell -- taking with
       * them the dialog contents this engine exists to document. They are
       * recognised by ARIA role, which is part of the accessibility contract
       * both landscapes already satisfy, rather than by any theme class.
       */
      const POPUP_ROLES = '[role="dialog"], dialog[open], [role="listbox"], [role="grid"]';

      /*
       * The vote is taken only over elements outside any open popup. A value-
       * help dialog's own results table can easily register more controls
       * (one row of a search result becomes several columns' worth) than the
       * form behind it ever had, at the exact moment a control inside it is
       * being explored -- outvoting the real form's view and pointing
       * appRoot at the dialog instead, which lets exactly the fields this
       * exists to protect fall back to the far cruder DOM probe. That probe
       * cannot tell a date field's calendar trigger from a lookup icon, so
       * losing the real handler for a field this way is what silently
       * breaks its calendar.
       */
      const scopeCounts = new Map<string, number>();
      for (const el of elements) {
        const id = safe(() => String(el.getId?.() ?? ''), '');
        const sep = id.indexOf('--');
        if (sep <= 0) continue;
        const dom = safe<HTMLElement | null>(() => el.getDomRef?.() ?? null, null);
        if (dom && dom.closest(POPUP_ROLES)) continue;
        const scope = id.slice(0, sep);
        // See the DOM probe's note: the older launchpad's own ids contain a
        // `--` from the entry URL's empty `CATEGORY=` parameter, inventing
        // scopes that name no element and can outvote the real view.
        if (!document.getElementById(scope)) continue;
        scopeCounts.set(scope, (scopeCounts.get(scope) ?? 0) + 1);
      }
      let dominantScope = '';
      let dominantCount = 0;
      for (const [scope, count] of scopeCounts) {
        if (count > dominantCount) {
          dominantCount = count;
          dominantScope = scope;
        }
      }

      let appRoot: HTMLElement | null = null;
      if (dominantScope) {
        const viewEl = document.getElementById(dominantScope);
        if (viewEl) {
          appRoot = viewEl;
          const hash = decodeURIComponent(location.hash.replace(/^#/, ''));
          const semanticObject = ((hash.split('?')[0] ?? '').split('-')[0] ?? '').trim();
          if (semanticObject) {
            let node: HTMLElement | null = viewEl.parentElement;
            while (node && node !== document.body) {
              // Highest ancestor still naming this route wins, so the whole
              // application container is taken rather than an inner fragment.
              if (node.id && node.id.indexOf(semanticObject) !== -1) appRoot = node;
              node = node.parentElement;
            }
          }
        }
      }

      for (const el of elements) {
        const controlType = safe(
          () => String(el.getMetadata?.().getName?.() ?? ''),
          '',
        );
        if (!controlType) continue;

        // Only framework controls that can carry a documentation point or drive
        // navigation are of interest; layout containers are skipped.
        if (
          !/\.(Input|TextArea|Select|ComboBox|MultiComboBox|MultiInput|DatePicker|DateRangeSelection|DateTimePicker|TimePicker|CheckBox|RadioButton|Switch|FileUploader|UploadSet|Button|ToggleButton|IconTabFilter|SearchField|StepInput|Slider|RatingIndicator|SegmentedButton|Link|MenuButton|MenuItem|ObjectListItem|StandardListItem|ColumnListItem)$/.test(
            controlType,
          )
        ) {
          continue;
        }

        const dom = safe<HTMLElement | null>(
          () => el.getDomRef?.() ?? null,
          null,
        );

        /*
         * Visibility must be tested the same way the interaction layer tests
         * it. `offsetParent !== null` alone is far too weak: it stays non-null
         * for a control that is zero-sized or `visibility: hidden` — which is
         * exactly how a collapsed filter panel renders its fields. Those
         * controls were being discovered, queued, and then rejected one by one
         * by the editability gate as "not visible", producing a run that
         * reported 140 controls discovered and documented almost none of them.
         *
         * Excluding them here is not a loss: a control hidden right now is
         * picked up by a later re-discovery sweep once whatever hides it has
         * been opened.
         */
        const visible =
          !!dom &&
          safe(() => el.getVisible?.() !== false, true) &&
          (() => {
            const style = getComputedStyle(dom);
            if (dom.offsetParent === null && style.position !== 'fixed') return false;
            const rect = dom.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return false;
            return style.visibility !== 'hidden' && style.display !== 'none';
          })();
        if (!visible) continue;

        /*
         * See appRoot above: anything outside the application's own container
         * is launchpad chrome, whatever it happens to be called in this
         * landscape. Popups are exempt because they render in the static area
         * by design. When no view scope was found at all -- a page that is not
         * an XML-view application -- appRoot stays null and nothing is
         * filtered, leaving such pages discovered exactly as before.
         */
        if (appRoot && !appRoot.contains(dom) && !dom.closest(POPUP_ROLES)) {
          continue;
        }

        results.push({
          controlId: safe(() => String(el.getId?.() ?? ''), ''),
          controlType,
          label: labelOf(el, dom),
          section: sectionOf(el),
          domId: dom?.id ?? '',
          domOrder: 0, // assigned below in document order
          visible,
          enabled: safe(() => el.getEnabled?.() !== false, true),
          editable: safe(() => el.getEditable?.() !== false, true),
          required: safe(() => el.getRequired?.() === true, false),
          showValueHelp: safe(() => el.getShowValueHelp?.() === true, false),
          // List-row and menu controls carry their label as a title, not text.
          text: safe(
            () =>
              String(
                el.getText?.() || el.getTitle?.() || el.getHeaderText?.() || '',
              ),
            '',
          ),
          alreadyExpanded: dom?.getAttribute('aria-expanded') === 'true',
        });
      }

      // Assign document order from actual DOM position so that processing follows
      // the visual reading order (section -> row -> control).
      const withNodes = results
        .map((r) => ({
          r,
          node: r.domId ? document.getElementById(r.domId) : null,
        }))
        .filter((x) => x.node !== null) as { r: Ui5RawControl; node: HTMLElement }[];

      const all = Array.from(document.querySelectorAll<HTMLElement>('*'));
      const indexOf = new Map<HTMLElement, number>();
      all.forEach((n, i) => indexOf.set(n, i));

      for (const { r, node } of withNodes) {
        r.domOrder = indexOf.get(node) ?? Number.MAX_SAFE_INTEGER;
      }

      return withNodes
        .map((x) => x.r)
        .sort((a, b) => a.domOrder - b.domOrder);
    })
    .catch(() => [] as Ui5RawControl[]);
}

/**
 * Builds a fingerprint of the current UI5 control tree.
 *
 * Used for loop detection and for reveal-vs-action button classification. UI5
 * ids are stable within a view, so a change in this set reliably indicates that
 * the visible UI actually changed.
 */
export async function ui5Fingerprint(page: Page): Promise<string> {
  return page
    .evaluate(() => {
      const w = window as unknown as Record<string, any>;
      const sap = w['sap'];
      const parts: string[] = [];

      /*
       * Collected the same two ways as `probeUi5Controls`, and judged visible
       * by the same test. Consulting only the modern registry made this return
       * nothing at all on a release that does not expose it, which silently
       * reduced page identity to "title + URL + open dialogs" — and left
       * `probeButton` with no UI5 signal for deciding whether a click revealed
       * anything.
       */
      const collect = (): any[] => {
        const out: any[] = [];
        try {
          const registry = sap?.ui?.core?.Element?.registry;
          if (registry?.forEach) {
            registry.forEach((el: any) => out.push(el));
            if (out.length) return out;
          }
        } catch {
          /* fall through to legacy traversal */
        }
        try {
          const core = sap?.ui?.getCore?.();
          const elements = core?.mElements;
          if (elements && typeof elements === 'object') {
            for (const key of Object.keys(elements)) out.push(elements[key]);
            if (out.length) return out;
          }
        } catch {
          /* fall through to the rendered-markup traversal */
        }
        // Pre-registry releases expose neither registry; see the same
        // fallback in `probeUi5Controls` for why the rendered markup is the
        // only way to reach their controls. Without it this fingerprint was
        // empty on the old landscape, which collapsed page identity to
        // "title + URL + open dialogs" -- and on a launchpad that never
        // changes either, to a single constant value for the whole run.
        try {
          const core = sap?.ui?.getCore?.();
          if (typeof core?.byId === 'function') {
            const seen = new Set<string>();
            for (const node of Array.from(
              document.querySelectorAll('[data-sap-ui]'),
            )) {
              const id = node.getAttribute('data-sap-ui');
              if (!id || seen.has(id)) continue;
              seen.add(id);
              const el = core.byId(id);
              if (el) out.push(el);
            }
          }
        } catch {
          /* no control registry reachable at all */
        }
        return out;
      };

      if (sap?.ui) {
        try {
          const ids: string[] = [];
          for (const el of collect()) {
            try {
              const dom = el.getDomRef?.();
              if (!dom) continue;
              const style = getComputedStyle(dom);
              if (dom.offsetParent === null && style.position !== 'fixed') continue;
              const rect = dom.getBoundingClientRect();
              if (rect.width === 0 || rect.height === 0) continue;
              if (style.visibility === 'hidden' || style.display === 'none') continue;
              ids.push(
                `${el.getMetadata?.().getName?.() ?? '?'}#${el.getId?.() ?? '?'}`,
              );
            } catch {
              /* skip control */
            }
          }
          ids.sort();
          parts.push(ids.join('|'));
        } catch {
          /* fall through */
        }
      }

      // Dialog stack participates in identity: the same page with a dialog open
      // is a different state.
      const dialogs = Array.from(
        document.querySelectorAll('.sapMDialog, .sapMPopover, [role="dialog"]'),
      )
        .filter((d) => (d as HTMLElement).offsetParent !== null)
        .map((d) => (d as HTMLElement).id || 'anon')
        .sort();
      parts.push(`dialogs:${dialogs.join(',')}`);

      return parts.join('||');
    })
    .catch(() => '');
}

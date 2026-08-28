import type { Page } from '../automation/types.js';
import type { ControlDescriptor, ControlKind } from '../types.js';
import { POINT_KINDS } from '../types.js';
import type { AppConfig } from '../config/schema.js';
import { canonicalise, hasMeaningfulLabel, type LabelResolver } from './labels.js';
import { probeUi5Controls, hasUi5, type Ui5RawControl } from './ui5-probe.js';
import { probeDomControls, type DomRawControl } from './dom-probe.js';
import { log } from '../util/logger.js';

/**
 * Turns raw probe output into typed `ControlDescriptor`s.
 *
 * Classification is a lookup, not an inference: the UI5 control type maps
 * directly to a `ControlKind`, which in turn decides whether the control earns a
 * documentation point. Buttons are the sole exception — whether a button reveals
 * new UI can only be determined by clicking it, so they are provisionally typed
 * here and resolved later by the interaction layer.
 */

/** Maps a UI5 control type to its documentation kind. */
function kindFromUi5(c: Ui5RawControl): ControlKind {
  const type = c.controlType.split('.').pop() ?? '';

  // A non-editable control is evidence-free by rule: read-only fields are skipped.
  const inert = !c.enabled || !c.editable;

  switch (type) {
    case 'Input':
      if (inert) return 'readonly';
      return c.showValueHelp ? 'valueHelp' : 'input';
    case 'SearchField':
      return inert ? 'readonly' : 'input';
    case 'TextArea':
      return inert ? 'readonly' : 'textarea';
    case 'StepInput':
      return inert ? 'readonly' : 'input';
    case 'Select':
    case 'ComboBox':
      return inert ? 'readonly' : 'select';
    case 'MultiComboBox':
    case 'MultiInput':
      return inert ? 'readonly' : 'multiSelect';
    case 'DatePicker':
    case 'DateTimePicker':
    case 'TimePicker':
      return inert ? 'readonly' : 'date';
    case 'DateRangeSelection':
      return inert ? 'readonly' : 'dateRange';
    case 'CheckBox':
    case 'Switch':
      return inert ? 'readonly' : 'checkbox';
    case 'RadioButton':
      return inert ? 'readonly' : 'radio';
    case 'FileUploader':
    case 'UploadSet':
      return inert ? 'readonly' : 'fileUpload';
    case 'IconTabFilter':
      // A disabled tab cannot be entered, so it is not a branch to explore.
      return c.enabled ? 'tab' : 'readonly';
    case 'Button':
    case 'ToggleButton':
    case 'SegmentedButton':
    case 'Link':
    case 'MenuButton':
    case 'MenuItem':
      // Provisional: whether these reveal something is only known by clicking,
      // resolved by the same click-and-diff logic used for buttons.
      return inert ? 'readonly' : 'actionButton';
    case 'ObjectListItem':
    case 'StandardListItem':
    case 'ColumnListItem':
    case 'CustomListItem':
    case 'GroupHeaderListItem':
      /*
       * Rows of a sap.m.List/Table are selection data, not UI to document --
       * confirmed on a live capture (Delivery Plant value-help): the dialog's
       * result list rendered ~600 rows, every one classified as actionButton,
       * queuing each for an individual click-and-diff probe. That list is
       * virtualized, so a row's DOM id gets recycled the moment anything
       * scrolls or re-renders -- almost every queued row was already stale
       * ("element no longer in the page") by the time its turn came, and
       * clicking one for real would have committed a selection anyway
       * (exactly what `selectFirstOption` exists to do deliberately, once).
       * Not one of the control kinds "What becomes a documentation point"
       * lists, so this earns no point and no exploration.
       */
      return 'unknown';
    default:
      return 'unknown';
  }
}

/** Maps a plain DOM element to its documentation kind. */
function kindFromDom(c: DomRawControl): ControlKind {
  /*
   * A lookup field's own <input> is deliberately rendered `readonly` by the
   * framework -- confirmed on a live capture (Company Code, Sales Office
   * Code): the underlying element carries `readonly="readonly"` even though
   * the control is fully interactive through its value-help trigger, by
   * design, to force entry through the popup rather than free typing. Tested
   * before the general readonly exclusion below, or this path -- consulted
   * whenever the UI5 registry hasn't already claimed the control -- silently
   * classifies every value-help field as inert and never attempts it. A
   * value-help field that is genuinely `disabled` (not merely read-only) is
   * still excluded.
   */
  if (c.valueHelp) return c.disabled ? 'readonly' : 'valueHelp';

  if (c.disabled || c.readOnly) return 'readonly';

  if (c.tag === 'select') return 'select';
  if (c.tag === 'textarea') return 'textarea';
  if (c.role === 'tab') return 'tab';

  if (c.tag === 'button' || c.role === 'button') return 'actionButton';

  /*
   * Links, menu items and expandable-section toggles all behave the same way
   * for documentation purposes: clicking one either reveals something (a
   * point) or does not (skipped), which is exactly what the provisional
   * actionButton click-and-diff path already resolves.
   */
  if (
    c.tag === 'a' ||
    c.role === 'link' ||
    c.role === 'menuitem' ||
    c.role === 'menuitemcheckbox' ||
    c.role === 'menuitemradio' ||
    c.expandable
  ) {
    return 'actionButton';
  }

  if (c.tag === 'input') {
    // valueHelp already handled above, ahead of the readonly exclusion.
    switch (c.type) {
      case 'checkbox':
        return 'checkbox';
      case 'radio':
        return 'radio';
      case 'date':
      case 'datetime-local':
      case 'month':
      case 'week':
      case 'time':
        return 'date';
      case 'file':
        return 'fileUpload';
      case 'submit':
      case 'button':
      case 'reset':
        return 'actionButton';
      default:
        return 'input';
    }
  }

  if (c.role === 'combobox') return 'select';
  if (c.role === 'checkbox') return 'checkbox';
  if (c.role === 'radio') return 'radio';
  return 'unknown';
}

/** Normalises a label for comparison and exclusion matching. */
function normalise(label: string): string {
  return label.trim().replace(/\s+/g, ' ').replace(/[:*]+$/, '').trim();
}

/**
 * Discovers every control on the current page, UI5-first with a DOM fallback.
 *
 * Elements already described by the UI5 registry are not re-added from the DOM
 * probe, so each control yields exactly one descriptor.
 */
export async function discoverControls(
  page: Page,
  app: AppConfig,
  resolver: LabelResolver,
): Promise<ControlDescriptor[]> {
  const out: ControlDescriptor[] = [];
  const claimedDomIds = new Set<string>();
  const excluded = new Set(app.excludeLabels.map((l) => normalise(l).toLowerCase()));

  const ui5IsPresent = await hasUi5(page);
  let ui5Found = 0;
  let domFound = 0;
  let domSkippedAsClaimed = 0;

  if (ui5IsPresent) {
    const ui5Controls = await probeUi5Controls(page);
    ui5Found = ui5Controls.length;
    for (const c of ui5Controls) {
      const kind = kindFromUi5(c);
      const rawLabel = normalise(c.label || c.text);
      if (c.domId) claimedDomIds.add(c.domId);

      out.push(
        makeDescriptor({
          id: c.controlId || c.domId,
          kind,
          rawLabel,
          section: normalise(c.section),
          selector: c.controlId
            ? `#${cssEscape(c.controlId)}`
            : `#${cssEscape(c.domId)}`,
          domOrder: c.domOrder,
          required: c.required,
          resolver,
          excluded,
          alreadyExpanded: c.alreadyExpanded,
          ui5: { controlType: c.controlType, controlId: c.controlId },
        }),
      );
    }
  }

  const domControls = await probeDomControls(page);
  for (const c of domControls) {
    // Skip anything the UI5 probe already described, including inner elements of
    // a UI5 control (whose ids are prefixed with the control id).
    if (c.domId && claimedDomIds.has(c.domId)) {
      domSkippedAsClaimed++;
      continue;
    }
    if (c.domId && [...claimedDomIds].some((id) => c.domId.startsWith(`${id}-`))) {
      domSkippedAsClaimed++;
      continue;
    }
    if (!c.selector) continue;

    domFound++;
    const kind = kindFromDom(c);
    out.push(
      makeDescriptor({
        id: c.domId || c.selector,
        kind,
        rawLabel: normalise(c.label || c.text),
        section: normalise(c.section),
        selector: c.selector,
        domOrder: c.domOrder,
        required: c.required,
        resolver,
        excluded,
        alreadyExpanded: c.expandable && c.expanded,
        ...(c.type ? { inputType: c.type } : {}),
      }),
    );
  }

  const byKind = new Map<ControlKind, number>();
  let pointCount = 0;
  for (const c of out) {
    byKind.set(c.kind, (byKind.get(c.kind) ?? 0) + 1);
    if (c.isPoint) pointCount++;
  }
  const kindSummary = [...byKind.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([kind, n]) => `${kind}:${n}`)
    .join(' ');
  log.debug(
    `  [discover] ui5=${ui5Found}${ui5IsPresent ? '' : ' (no UI5 runtime)'} dom=${domFound} ` +
      `(${domSkippedAsClaimed} already claimed by UI5) total=${out.length} points=${pointCount} — ${kindSummary}`,
  );

  return out.sort((a, b) => a.domOrder - b.domOrder);
}

function makeDescriptor(args: {
  id: string;
  kind: ControlKind;
  rawLabel: string;
  section: string;
  selector: string;
  domOrder: number;
  required: boolean;
  resolver: LabelResolver;
  excluded: Set<string>;
  alreadyExpanded?: boolean;
  ui5?: { controlType: string; controlId: string };
  inputType?: string;
}): ControlDescriptor {
  const label = args.rawLabel;
  const canonicalLabel = canonicalise(label, args.resolver);
  const isExcluded =
    args.excluded.has(label.toLowerCase()) ||
    args.excluded.has(canonicalLabel.toLowerCase());

  /*
   * A control with no resolvable label cannot become a documentation point:
   * every point in the reference documents is identified by its label. Such a
   * control is still filled, so that the closing full-page capture shows a
   * complete form, but it contributes no screenshot of its own.
   */
  const hasLabel =
    hasMeaningfulLabel(canonicalLabel) || hasMeaningfulLabel(label);

  const fallbackSelector = stableIdSelector(args.id);

  const descriptor: ControlDescriptor = {
    id: args.id,
    dedupeKey: dedupeKeyFor(args.kind, label, canonicalLabel, args.section, args.id),
    kind: args.kind,
    label,
    canonicalLabel,
    selector: args.selector,
    ...(fallbackSelector ? { fallbackSelector } : {}),
    ...(args.inputType ? { inputType: args.inputType } : {}),
    domOrder: args.domOrder,
    required: args.required,
    isPoint: POINT_KINDS.has(args.kind) && !isExcluded && hasLabel,
  };
  if (args.alreadyExpanded) descriptor.alreadyExpanded = true;
  if (args.section) descriptor.section = args.section;
  if (args.ui5) descriptor.ui5 = args.ui5;
  return descriptor;
}

/**
 * Builds the identity used to decide whether a control has already been
 * processed.
 *
 * Prefers the application-authored id suffix over the resolved label: a
 * control's label can legitimately read differently between two discovery
 * sweeps of the same physical element -- a real run selected a value-help
 * row and, on the very next sweep, that field's own control was rediscovered
 * with its label resolving to the code just selected ("A43578") instead of
 * "Contract Person Code". A label-keyed identity treats that as a brand-new,
 * never-before-seen control and documents it a second time under the wrong
 * name. The id suffix survives UI5 view renumbering (see `stableIdSuffix`)
 * and does not depend on label resolution at all, so the same field keeps
 * the same identity regardless of what its label happens to read at each
 * sweep.
 *
 * Next preference is the raw id, ahead of label+section -- confirmed needed
 * on a live capture: a personalization-dialog trigger button (an
 * application-authored id with no `--` view prefix, so the branch above does
 * not apply) is a framework-reused singleton re-attached under a *different*
 * enclosing Dialog each time it is invoked, so `sectionOf()` legitimately
 * returns a different title at each discovery even though it is the exact
 * same element both times. Keying by section+label treated that as two
 * distinct controls and queued the second one behind the first's own
 * side-effects, so it went stale before its turn came. A UI5 id is unique
 * across the whole application at any instant by construction (that is
 * exactly what `Element.registry` indexes on), so two discoveries reporting
 * the same id are always the same control, regardless of which container
 * happens to enclose it at each moment -- a strictly more reliable signal
 * than section, which only describes transient DOM ancestry. Falls back to
 * label+section only when there is no id at all to key on.
 */
function dedupeKeyFor(
  kind: ControlKind,
  label: string,
  canonicalLabel: string,
  section: string,
  id: string,
): string {
  const stableId = stableIdSuffix(id);
  if (stableId) return `${kind}|${stableId}`;

  if (id) return `${kind}|${id}`;

  const name = (canonicalLabel || label).trim().toLowerCase();
  if (name) return `${kind}|${section.trim().toLowerCase()}|${name}`;
  return `${kind}|unknown`;
}

/**
 * The application-authored part of a UI5 id -- the portion from `--` onward,
 * ignoring the auto-generated view-instance prefix.
 *
 * `__xmlview2--DueDateId-inner` yields `--DueDateId-inner`, which still
 * identifies the same field after UI5 renumbers the view to `__xmlview3`.
 * Returns undefined for ids with no view prefix (`SalesAreaDialog-cancel`,
 * already application-authored) or too short a suffix to identify anything.
 */
function stableIdSuffix(id: string): string | undefined {
  const marker = id.indexOf('--');
  if (marker <= 0) return undefined;

  const stable = id.slice(marker);
  if (stable.length < 4) return undefined;

  return stable;
}

/**
 * Builds an id-suffix CSS selector that ignores UI5's auto-generated view
 * prefix, so the selector keeps matching after a view renumber.
 */
function stableIdSelector(id: string): string | undefined {
  const stable = stableIdSuffix(id);
  if (!stable) return undefined;
  return `[id$="${stable.replace(/["\\]/g, '\\$&')}"]`;
}

/** CSS.escape equivalent for building selectors in Node. */
function cssEscape(value: string): string {
  return value.replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1');
}

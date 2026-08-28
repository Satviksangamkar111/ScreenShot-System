import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '../automation/types.js';
import type {
  ControlDescriptor,
  Evidence,
  ExceptionRecord,
  InteractionType,
  PageState,
  VersionId,
} from '../types.js';
import { captureScrollSegments } from './scroll-capture.js';
import { log } from '../util/logger.js';

/**
 * Evidence store.
 *
 * Owns screenshot capture, sequencing and the on-disk trace. Sequence numbers
 * are global to a run and define document order, so the assembly stage never has
 * to reconstruct chronology.
 */
export class EvidenceStore {
  private seq = 0;
  private readonly evidence: Evidence[] = [];
  private readonly exceptions: ExceptionRecord[] = [];
  private readonly pages: PageState[] = [];
  private shotCount = 0;

  constructor(
    private readonly runId: string,
    private readonly version: VersionId,
    private readonly runDir: string,
  ) {}

  get screenshotDir(): string {
    return path.join(this.runDir, 'screenshots');
  }

  get counts() {
    return {
      evidence: this.evidence.length,
      exceptions: this.exceptions.length,
      pages: this.pages.length,
      screenshots: this.shotCount,
      points: this.evidence.filter(
        (e) =>
          e.interactionType !== 'initialFullPage' &&
          e.interactionType !== 'finalFullPage',
      ).length,
    };
  }

  async init(): Promise<void> {
    await mkdir(this.screenshotDir, { recursive: true });
  }

  registerPage(page: PageState): void {
    this.pages.push(page);
  }

  markPageComplete(pageId: string): void {
    const p = this.pages.find((x) => x.pageId === pageId);
    if (p) p.completed = true;
  }

  /**
   * Captures a screenshot and records it as evidence.
   *
   * Every shot here is a plain viewport capture; a "Full Page" point is built
   * separately, from consecutive scroll segments (see evidence/scroll-capture.ts)
   * rather than a single tall image, because an open dropdown or dialog is
   * positioned relative to the viewport and a full-page capture would render
   * it detached from its field.
   */
  async capture(args: {
    page: Page;
    pageState: PageState;
    label: string;
    canonicalLabel: string;
    interactionType: InteractionType;
    tab?: string;
    section?: string;
    controlKind?: ControlDescriptor['kind'];
  }): Promise<Evidence> {
    const seq = ++this.seq;
    const isFullPage =
      args.interactionType === 'initialFullPage' ||
      args.interactionType === 'finalFullPage';

    const baseName = `${String(seq).padStart(4, '0')}-${slug(
      args.canonicalLabel || args.interactionType,
    )}`;

    let fileName = `${baseName}.png`;
    let extraFiles: string[] = [];

    try {
      if (isFullPage) {
        /*
         * A whole-page capture is taken as consecutive screenfuls rather than
         * one tall image, matching the reference documents and staying legible
         * at the document's fixed embed width.
         */
        const segments = await captureScrollSegments(args.page, {
          outputDir: this.screenshotDir,
          baseName,
        });
        if (segments.length > 0) {
          fileName = segments[0]!;
          extraFiles = segments.slice(1);
          this.shotCount += segments.length;
        }
      } else {
        await args.page.screenshot({
          path: path.join(this.screenshotDir, fileName),
          fullPage: false,
          animations: 'disabled',
        });
        this.shotCount++;
      }
    } catch (err) {
      log.warn(`screenshot failed for "${args.label}": ${errMsg(err)}`);
    }

    const record: Evidence = {
      seq,
      runId: this.runId,
      version: this.version,
      workflowPath: [...args.pageState.workflowPath],
      pageId: args.pageState.pageId,
      pageTitle: args.pageState.title,
      label: args.label,
      canonicalLabel: args.canonicalLabel,
      interactionType: args.interactionType,
      screenshotPath: path.join('screenshots', fileName),
      status: 'ok',
    };
    if (extraFiles.length > 0) {
      record.additionalScreenshots = extraFiles.map((f) =>
        path.join('screenshots', f),
      );
    }
    if (args.tab) record.tab = args.tab;
    if (args.section) record.section = args.section;
    if (args.controlKind) record.controlKind = args.controlKind;

    this.evidence.push(record);
    return record;
  }

  /**
   * Captures the page as a batch of top-to-bottom scroll segments and
   * returns their evidence-relative paths, without creating an Evidence
   * record of its own.
   *
   * Building block for `finalizeFullPage`: a page's "Full Page" evidence is
   * assembled from one call to this per section (Form Section, Copy Section,
   * ...), each still showing that section's own filled data, rather than a
   * single shot taken after the whole page is done. Capturing immediately
   * after each section — instead of once at the very end — is what actually
   * fixes the defect this replaced: a live run showed a chooser dialog the
   * next section's own interactions had reopened still on screen by the time
   * a single closing shot got taken, silently documenting that dialog again
   * in place of the filled form.
   */
  async captureFullPageSection(
    page: Page,
    pageState: PageState,
    tab?: string,
  ): Promise<string[]> {
    const seq = ++this.seq;
    const baseName = `${String(seq).padStart(4, '0')}-full-page${tab ? `-${slug(tab)}` : ''}`;

    let segments: string[] = [];
    try {
      segments = await captureScrollSegments(page, {
        outputDir: this.screenshotDir,
        baseName,
      });
      this.shotCount += segments.length;
    } catch (err) {
      log.warn(
        `full-page section capture failed for "${pageState.title}"` +
          `${tab ? ` (${tab})` : ''}: ${errMsg(err)}`,
      );
    }

    return segments.map((f) => path.join('screenshots', f));
  }

  /**
   * Turns previously captured full-page segments into this page's one "Full
   * Page" evidence record, in document order. Returns null and records
   * nothing when there is nothing to record.
   */
  finalizeFullPage(pageState: PageState, segments: string[]): Evidence | null {
    if (segments.length === 0) return null;

    const seq = ++this.seq;
    const record: Evidence = {
      seq,
      runId: this.runId,
      version: this.version,
      workflowPath: [...pageState.workflowPath],
      pageId: pageState.pageId,
      pageTitle: pageState.title,
      label: 'Full Page',
      canonicalLabel: 'Full Page',
      interactionType: 'finalFullPage',
      screenshotPath: segments[0]!,
      status: 'ok',
    };
    if (segments.length > 1) record.additionalScreenshots = segments.slice(1);

    this.evidence.push(record);
    return record;
  }

  /**
   * Records a control that could not be automated.
   *
   * Captures the current screen so a human can see what blocked it. Exceptions
   * never appear in the generated document — they belong to the internal report.
   */
  async recordException(args: {
    page: Page;
    pageState: PageState;
    control: ControlDescriptor;
    action: string;
    error: unknown;
  }): Promise<void> {
    const seq = ++this.seq;
    const fileName = `exc-${String(seq).padStart(4, '0')}-${slug(
      args.control.canonicalLabel || args.control.id,
    )}.png`;
    const abs = path.join(this.screenshotDir, fileName);

    let shot: string | undefined;
    try {
      await args.page.screenshot({ path: abs, animations: 'disabled' });
      shot = path.join('screenshots', fileName);
      this.shotCount++;
    } catch {
      /* the page may be gone; the record still matters */
    }

    const record: ExceptionRecord = {
      seq,
      pageId: args.pageState.pageId,
      workflowPath: [...args.pageState.workflowPath],
      label: args.control.canonicalLabel || args.control.label,
      controlKind: args.control.kind,
      action: args.action,
      message: errMsg(args.error),
      at: new Date().toISOString(),
    };
    if (shot) record.screenshotPath = shot;

    this.exceptions.push(record);
    log.warn(`  exception on "${record.label}" (${args.action}): ${record.message}`);
  }

  getEvidence(): Evidence[] {
    return [...this.evidence];
  }

  getExceptions(): ExceptionRecord[] {
    return [...this.exceptions];
  }

  getPages(): PageState[] {
    return [...this.pages];
  }

  /** Writes the trace, the contract consumed by the assembly stage. */
  async writeTrace(trace: unknown): Promise<string> {
    const file = path.join(this.runDir, 'trace.json');
    await writeFile(file, JSON.stringify(trace, null, 2), 'utf8');
    return file;
  }

  async writeReport(report: unknown): Promise<string> {
    const file = path.join(this.runDir, 'report.json');
    await writeFile(file, JSON.stringify(report, null, 2), 'utf8');
    return file;
  }
}

/** Filesystem-safe slug for screenshot names. */
function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'shot'
  );
}

export function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

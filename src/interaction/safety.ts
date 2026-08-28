import type { SafetyPolicy } from '../config/schema.js';

/**
 * Destructive-action policy.
 *
 * The engine drives a real business system with dummy data. Clicking Save,
 * Create or Post would produce genuine records, so those buttons are classified
 * without ever being clicked. Because pure action buttons yield no documentation
 * point, refusing to click them costs the document nothing.
 */

export type ClickVerdict =
  | { allowed: true }
  | { allowed: false; reason: string };

/** Decides whether a button with this label may be clicked. */
export function mayClick(label: string, policy: SafetyPolicy): ClickVerdict {
  const text = label.trim().toLowerCase();
  if (!text) return { allowed: true };

  // An explicit allow entry wins: these are read-only queries needed to navigate.
  if (policy.allowLabels.some((a) => matches(text, a))) {
    return { allowed: true };
  }

  const hit = policy.denyLabels.find((d) => matches(text, d));
  if (hit) {
    return {
      allowed: false,
      reason: `button labelled "${label}" matches deny rule "${hit}"`,
    };
  }
  return { allowed: true };
}

/**
 * Whole-word match, so "Save" blocks a Save button without also blocking
 * something like "Saved Searches".
 */
function matches(text: string, rule: string): boolean {
  const r = rule.trim().toLowerCase();
  if (!r) return false;
  if (text === r) return true;
  const pattern = new RegExp(`\\b${escapeRegex(r)}\\b`);
  return pattern.test(text);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

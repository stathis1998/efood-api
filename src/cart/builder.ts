/**
 * Turns plain option names (or codes) into the option codes and unit price of
 * a cart line, using the item's option groups ("tiers") from the product call.
 *
 * Rules, taken from how the product payload is shaped:
 *  - a `radio` tier needs exactly one choice. Nothing is guessed: if it has
 *    more than one option and none was asked for, that is an error.
 *  - a `checkbox` tier is optional; `maximum_selections` (when > 0) caps it.
 *  - a tier with `dependent_options` only applies once one of those options is
 *    chosen (e.g. "type of sugar" only after picking a sweetness).
 *  - an option's price can change with another chosen option (`dependencies`).
 */
import { cleanText, round2 } from '../efood/types.js';

interface RawDependency {
  code: string | number;
  price?: number;
  enabled?: boolean;
}
interface RawOption {
  code: string | number;
  name?: string;
  price?: number;
  shortage?: boolean;
  dependencies?: RawDependency[];
}
interface RawTier {
  code: string | number;
  name?: string;
  type?: string;
  maximum_selections?: number;
  shortage?: boolean;
  dependent_options?: Array<string | number>;
  options?: RawOption[];
}

export interface CatalogTier {
  tier: string;
  /** True when exactly one option must be chosen. */
  required: boolean;
  /** Most options that may be chosen; 0 means no limit. */
  max: number;
  /** True when the tier only applies after choosing an option of another tier. */
  conditional: boolean;
  options: Array<{ code: string; name: string; price: number; available: boolean }>;
}

export interface SelectedOption {
  code: string;
  name: string;
  tier: string;
  price: number;
}

export interface ResolveResult {
  /** Chosen options, in the item's own tier order. */
  selected: SelectedOption[];
  /** Base price plus the chosen options. */
  unitPrice: number;
  errors: string[];
}

/** Lowercase, strip tags and accents, fold final sigma, collapse punctuation. */
export function norm(s: string): string {
  return cleanText(String(s ?? ''))
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/ς/g, 'σ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function tiersOf(itemRaw: unknown): RawTier[] {
  const tiers = (itemRaw as { tiers?: unknown } | null)?.tiers;
  return Array.isArray(tiers) ? (tiers as RawTier[]) : [];
}

const isRadio = (t: RawTier) => t.type === 'radio';
const tierName = (t: RawTier) => cleanText(String(t.name ?? t.code));
const optName = (o: RawOption) => cleanText(String(o.name ?? o.code));

/** The option groups of an item, for display. */
export function describeTiers(itemRaw: unknown): CatalogTier[] {
  return tiersOf(itemRaw).map((t) => ({
    tier: tierName(t),
    required: isRadio(t),
    max: isRadio(t) ? 1 : (t.maximum_selections ?? 0),
    conditional: (t.dependent_options ?? []).length > 0,
    options: (t.options ?? []).map((o) => ({
      code: String(o.code),
      name: optName(o),
      price: typeof o.price === 'number' ? o.price : 0,
      available: o.shortage !== true,
    })),
  }));
}

/** How well a requested name matches an option name; 0 means no match. */
function score(optionName: string, wanted: string): number {
  if (optionName === wanted) return 100;
  if (optionName.startsWith(`${wanted} `)) return 80;
  if (` ${optionName} `.includes(` ${wanted} `)) return 60;
  if (optionName.includes(wanted)) return 40;
  return 0;
}

export function resolveSelections(itemRaw: unknown, requested: string[]): ResolveResult {
  const tiers = tiersOf(itemRaw);
  const basePrice = Number((itemRaw as { price?: unknown } | null)?.price) || 0;
  const all = tiers.flatMap((tier) => (tier.options ?? []).map((opt) => ({ tier, opt, code: String(opt.code) })));
  const errors: string[] = [];
  const picked = new Map<string, (typeof all)[number]>();

  for (const token of requested) {
    const t = token.trim();
    if (!t) continue;
    let match = all.find((o) => o.code === t);
    if (!match) {
      const wanted = norm(t);
      const scored = all
        .map((o) => ({ o, s: score(norm(optName(o.opt)), wanted) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s);
      if (scored.length === 0) {
        errors.push(`no option matches "${t}"`);
        continue;
      }
      if (scored.length > 1 && scored[0].s === scored[1].s) {
        const names = scored.filter((x) => x.s === scored[0].s).map((x) => optName(x.o.opt));
        errors.push(`"${t}" is ambiguous (${names.join(' / ')}); use the full name or the code`);
        continue;
      }
      match = scored[0].o;
    }
    if (match.opt.shortage === true || match.tier.shortage === true) {
      errors.push(`"${optName(match.opt)}" is out of stock`);
      continue;
    }
    picked.set(match.code, match);
  }

  const applies = (tier: RawTier) => {
    const deps = tier.dependent_options ?? [];
    return deps.length === 0 || deps.some((d) => picked.has(String(d)));
  };

  for (const tier of tiers) {
    const options = (tier.options ?? []).filter((o) => o.shortage !== true);
    const chosen = [...picked.values()].filter((p) => p.tier === tier);
    if (!applies(tier)) {
      if (chosen.length) {
        errors.push(`"${tierName(tier)}" does not apply with the other options chosen`);
      }
      continue;
    }
    if (isRadio(tier)) {
      if (chosen.length > 1) {
        errors.push(`"${tierName(tier)}" takes one choice, got ${chosen.length}`);
      } else if (chosen.length === 0) {
        if (options.length === 1) {
          picked.set(String(options[0].code), { tier, opt: options[0], code: String(options[0].code) });
        } else if (options.length > 1) {
          errors.push(`choose one for "${tierName(tier)}"`);
        }
      }
    } else if ((tier.maximum_selections ?? 0) > 0 && chosen.length > tier.maximum_selections!) {
      errors.push(`"${tierName(tier)}" takes at most ${tier.maximum_selections}, got ${chosen.length}`);
    }
  }

  const selected: SelectedOption[] = [];
  let price = basePrice;
  for (const o of all) {
    if (!picked.has(o.code)) continue;
    // An option's price may be overridden by another chosen option.
    const dep = (o.opt.dependencies ?? []).find((d) => picked.has(String(d.code)));
    if (dep?.enabled === false) {
      errors.push(`"${optName(o.opt)}" cannot be combined with the other options chosen`);
    }
    const optionPrice = Number(dep?.price ?? o.opt.price) || 0;
    price += optionPrice;
    selected.push({ code: o.code, name: optName(o.opt), tier: tierName(o.tier), price: optionPrice });
  }

  return { selected, unitPrice: round2(price), errors };
}

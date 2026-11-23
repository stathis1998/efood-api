#!/usr/bin/env node
/**
 * Command line for the efood client. `efood help` lists the commands.
 */
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { Efood, EfoodError, type CartLine, type OrderResult, type PendingConfirmation } from './index.js';
import { createEfoodServer } from './server.js';

const HELP = `efood - unofficial efood.gr client

Session
  efood login [session-id]        save a session id (prompts when omitted)
  efood whoami                    show the logged-in account

Account
  efood addresses                 saved delivery addresses
  efood orders [--limit 20] [--shop id-or-name]    past orders, optionally of one shop
  efood cards                     saved payment cards

Browse
  efood shops [--q text] [--favorites] [--open] [--address id | --lat n --lon n]
  efood menu <shop> [--q text]
  efood options <shop> <item>     option groups of one item

Cart (the cart efood saves per shop, shared with the app)
  efood cart show <shop>
  efood cart add <shop> <item> [--opt name]... [--qty 1] [--comment text] [--dry]
  efood cart remove <shop> <line-number>
  efood cart clear <shop>
  efood checkout <shop> [--yes] [--max-total n] [--address id] [--pay cash|card] [--card 1234]

Favourites (saved order templates)
  efood fav save <name> <shop> [--address id] [--max-total n] [--pay cash|card] [--card 1234]
  efood fav list
  efood fav remove <name>
  efood fav order <name> [--yes] [--force] [--max-total n] [--pay cash|card] [--card 1234]

Orders
  efood status <order-id>
  efood stats [--since 2026-01-01] [--until 2026-12-31] [--top 15]
                                  money spent per shop and in total, over all past orders

Service
  efood serve [--port 8787] [--host 0.0.0.0]    needs EFOOD_API_TOKEN

checkout and fav order only validate unless --yes is given.
Payment is cash on delivery unless --pay card; --card picks a saved card by its
last four digits (default: the account's default card).
<item> is an item code (IT_...) or a name. Add --json to any command for raw output.
Colours are used on a terminal; turn them off with --no-color or NO_COLOR=1.
Get the session id from the browser: log in on e-food.gr, open the console
and run  window.app.userSid  (or copy the "sparks-sid" cookie).`;

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    json: { type: 'boolean' },
    'no-color': { type: 'boolean' },
    yes: { type: 'boolean' },
    force: { type: 'boolean' },
    dry: { type: 'boolean' },
    favorites: { type: 'boolean' },
    open: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
    q: { type: 'string' },
    limit: { type: 'string' },
    since: { type: 'string' },
    until: { type: 'string' },
    top: { type: 'string' },
    shop: { type: 'string' },
    address: { type: 'string' },
    lat: { type: 'string' },
    lon: { type: 'string' },
    opt: { type: 'string', multiple: true },
    qty: { type: 'string' },
    comment: { type: 'string' },
    'max-total': { type: 'string' },
    pay: { type: 'string' },
    card: { type: 'string' },
    port: { type: 'string' },
    host: { type: 'string' },
  },
});

// Colours: only on a terminal, and never with --no-color or NO_COLOR (https://no-color.org).
const colorAllowed = !flags['no-color'] && !process.env.NO_COLOR;
const forced = Boolean(process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0');
const useColor = {
  out: colorAllowed && (forced || process.stdout.isTTY === true),
  err: colorAllowed && (forced || process.stderr.isTTY === true),
};
type Style = (text: string) => string;
const style = (open: number, close: number, stream: 'out' | 'err' = 'out'): Style => (text) =>
  useColor[stream] && text ? `\x1b[${open}m${text}\x1b[${close}m` : text;
const bold = style(1, 22);
const dim = style(2, 22);
const red = style(31, 39);
const green = style(32, 39);
const yellow = style(33, 39);
const cyan = style(36, 39);
const errRed = style(31, 39, 'err');
const errDim = style(2, 22, 'err');
const errCyan = style(36, 39, 'err');
const plain: Style = (text) => text;

function printHelp(): void {
  const lines = HELP.split('\n').map((line, i) => {
    if (i === 0) return bold(line);
    if (/^[A-Z][A-Za-z]+( \(.*\))?$/.test(line)) return line.replace(/^\w+/, (w) => bold(yellow(w)));
    return line.replace(/^  efood [a-z]+( (show|add|remove|clear|save|list|order)(?= |$))?/, (m) => `  ${cyan(m.trim())}`);
  });
  console.log(lines.join('\n'));
}

function fail(message: string): never {
  throw new EfoodError('bad_request', message);
}

function numFlag(name: 'limit' | 'top' | 'address' | 'lat' | 'lon' | 'qty' | 'max-total' | 'port'): number | undefined {
  const v = flags[name];
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) fail(`--${name} must be a number.`);
  return n;
}

function payFlag(): 'cash' | 'card' | undefined {
  const v = flags.pay;
  if (v === undefined || v === 'cash' || v === 'card') return v;
  return fail('--pay must be "cash" or "card".');
}

function arg(index: number, what: string): string {
  return positionals[index] ?? fail(`Missing ${what}. See \`efood help\`.`);
}

function shopArg(index: number): number {
  const n = Number(arg(index, 'shop id'));
  if (!Number.isInteger(n) || n <= 0) fail('Shop id must be a number (see `efood shops`).');
  return n;
}

const eur = (n: number | undefined) => (n === undefined ? '-' : `${n.toFixed(2)}€`);

/**
 * Prints aligned columns. `styles` colours a column (by index); with `header`
 * the first row is a heading. Cells are padded before they are coloured, so
 * colour codes never upset the alignment.
 */
function table(
  rows: Array<Array<string | number | undefined>>,
  opts: { header?: boolean; styles?: Array<Style | undefined> } = {},
): void {
  const cells = rows.map((r) => r.map((c) => (c === undefined ? '-' : String(c))));
  const widths = cells[0]?.map((_, i) => Math.max(...cells.map((r) => r[i].length))) ?? [];
  cells.forEach((r, row) => {
    let last = r.length - 1;
    while (last > 0 && r[last] === '') last -= 1;
    const line = r.slice(0, last + 1).map((c, i) => {
      const padded = i === last ? c : c.padEnd(widths[i]);
      return opts.header && row === 0 ? bold(dim(padded)) : (opts.styles?.[i] ?? plain)(padded);
    });
    console.log(line.join('  '));
  });
}

/** Colours a status word by what it says. */
const status: Style = (text) => {
  const t = text.trim().toLowerCase();
  if (/closed|expired|inactive|out of stock/.test(t)) return red(text);
  if (/open|default/.test(t)) return green(text);
  return text;
};

function printLines(lines: CartLine[]): void {
  lines.forEach((l, i) => {
    console.log(`${dim(`${i + 1}.`)} ${l.quantity} x ${bold(String(l.name ?? ''))}  ${yellow(eur(l.total))}`);
    if (l.optionNames.length) console.log(dim(`     ${l.optionNames.join(', ')}`));
    if (l.comment) console.log(dim(`     note: ${l.comment}`));
  });
}

function printOrder(r: OrderResult): void {
  console.log(`${bold(cyan(String(r.shopName ?? r.shopId)))}  ${dim(`(address ${r.addressId})`)}`);
  printLines(r.lines);
  const how = r.payment === 'card' ? `card ${r.card}` : 'cash on delivery';
  console.log(`Items ${eur(r.itemsTotal)}, ${r.dryRun ? 'total quoted by efood' : 'total charged by efood'} ${bold(yellow(eur(r.total)))}, ${r.dryRun ? 'to be paid' : 'paid'} by ${how}`);
  if (r.dryRun) {
    console.log(`${yellow('Dry run:')} efood accepted the order as valid. Nothing was ordered. Add --yes to place it.`);
  } else {
    console.log(`${bold(green('ORDER PLACED.'))} Order id: ${bold(r.orderId || '(not returned)')}${r.eta ? `, expected in ${r.eta}` : ''}`);
  }
}

function openInBrowser(url: string): void {
  if (!/^https:\/\//.test(url)) return;
  const [cmd, args] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {
    // The link is printed as well.
  }
}

/**
 * Runs an order. When the bank asks for a confirmation (3-D Secure), opens the
 * confirmation page and waits for the order to appear.
 */
async function ordering(efood: Efood, place: () => Promise<OrderResult>, show: (value: unknown, human: () => void) => void): Promise<void> {
  let result: OrderResult;
  try {
    result = await place();
  } catch (err) {
    if (!(err instanceof EfoodError) || err.code !== 'confirmation_required' || flags.json) throw err;
    const pending = err.details as PendingConfirmation;
    console.log(`${bold(yellow('Your bank wants this payment confirmed.'))} ${pending.shopName ?? ''} ${yellow(eur(pending.total))}`);
    console.log(`Opening the confirmation page in your browser. If it does not open, use this link:\n${cyan(pending.url)}`);
    openInBrowser(pending.url);
    console.log(dim('Waiting up to 10 minutes for the order to appear (Ctrl+C stops waiting, not the payment)...'));
    const order = await efood.waitForConfirmation(pending);
    if (!order) {
      process.exitCode = 1;
      console.log(`${red('No order appeared.')} If you approved the payment, check \`efood orders\` or the efood app before ordering again.`);
      return;
    }
    console.log(`${bold(green('ORDER PLACED.'))} Order id: ${bold(String(order.id))}, ${yellow(eur(order.total))}${order.status ? `, ${order.status}` : ''}`);
    return;
  }
  show(result, () => printOrder(result));
}

async function main(): Promise<void> {
  const [command, sub] = positionals;
  if (!command || command === 'help' || flags.help) {
    printHelp();
    return;
  }
  try {
    process.loadEnvFile(fileURLToPath(new URL('../../.env', import.meta.url)));
  } catch {
    // No .env file is fine.
  }

  const efood = new Efood();
  const out = (value: unknown, human: () => void) => {
    if (flags.json) console.log(JSON.stringify(value, null, 2));
    else human();
  };

  switch (command) {
    case 'login': {
      let sid = positionals[1];
      if (!sid) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        sid = await rl.question('Session id (window.app.userSid on e-food.gr): ');
        rl.close();
      }
      const account = await efood.setSession(sid);
      console.log(`${green('Session saved.')} Logged in as ${bold(account.firstName ?? account.email ?? 'your account')}.`);
      return;
    }
    case 'whoami': {
      const a = await efood.me();
      return out(a, () => console.log(`${bold(`${a.firstName ?? ''} ${a.lastName ?? ''}`.trim())} ${dim(`<${a.email ?? '?'}>`)}`.trim()));
    }
    case 'addresses': {
      const list = await efood.addresses();
      return out(list, () =>
        table([['ID', 'LABEL', 'ADDRESS', ''], ...list.map((a) => [a.id, a.label, a.street, a.isDefault ? 'default' : ''])], {
          header: true,
          styles: [cyan, bold, undefined, status],
        }),
      );
    }
    case 'cards': {
      const list = await efood.cards();
      return out(list, () =>
        table([
          ['CARD', 'BRAND', 'BANK', 'EXPIRES', ''],
          ...list.map((c) => [
            c.number,
            c.brand,
            c.bank,
            c.expires,
            [c.isDefault ? 'default' : '', c.expired ? 'EXPIRED' : '', c.isActive ? '' : 'inactive'].filter(Boolean).join(' '),
          ]),
        ], { header: true, styles: [cyan, undefined, undefined, undefined, status] }),
      );
    }
    case 'orders': {
      const list = await efood.orders({ limit: numFlag('limit'), shop: flags.shop });
      return out(list, () => {
        if (!list.length) console.log(flags.shop ? `No past orders from a shop matching "${flags.shop}".` : 'No past orders.');
        for (const o of list) {
          console.log(`${dim(String(o.date ?? '?'))}  #${o.id}  ${bold(String(o.shopName ?? ''))} ${dim(`(shop ${o.shopId})`)}  ${yellow(eur(o.total))}  ${o.status ?? ''}`.trimEnd());
          for (const it of o.items) {
            console.log(`    ${it.quantity} x ${it.name} ${dim(`[${it.code}]`)}${it.customisation ? dim(`  ${it.customisation.split(/\s*\n\s*/).join(', ')}`) : ''}`);
          }
        }
      });
    }
    case 'shops': {
      const list = await efood.shops({
        query: flags.q,
        favoritesOnly: flags.favorites,
        openOnly: flags.open,
        addressId: numFlag('address'),
        latitude: numFlag('lat'),
        longitude: numFlag('lon'),
      });
      return out(list, () =>
        table([
          ['ID', 'NAME', 'OPEN', 'MIN', 'DELIVERY', 'ETA'],
          ...list.map((s) => [
            s.id,
            s.name,
            s.isOpen === false ? 'closed' : 'open',
            eur(s.minimumOrder),
            eur(s.deliveryCost),
            s.etaMinutes === undefined ? '-' : `${s.etaMinutes}'`,
          ]),
        ], { header: true, styles: [cyan, bold, status, yellow, yellow] }),
      );
    }
    case 'menu': {
      const menu = await efood.menu(shopArg(1));
      const q = flags.q?.toLowerCase();
      return out(menu, () => {
        const s = menu.shop;
        console.log(`${bold(cyan(String(s.name ?? '')))}  ${status(s.isOpen === false ? 'CLOSED' : 'open')}  min ${yellow(eur(s.minimumOrder))}  delivery ${yellow(eur(s.deliveryCost))}`);
        for (const c of menu.categories) {
          const items = c.items.filter((it) => !q || (it.name ?? '').toLowerCase().includes(q));
          if (!items.length) continue;
          console.log(`\n${bold(String(c.name ?? ''))}`);
          table(items.map((it) => [`  ${it.code}`, it.name, eur(it.price), it.available ? '' : 'out of stock']), { styles: [dim, undefined, yellow, status] });
        }
      });
    }
    case 'options': {
      const o = await efood.itemOptions(shopArg(1), arg(2, 'item'));
      return out(o, () => {
        console.log(`${bold(cyan(String(o.name ?? '')))} ${dim(`[${o.code}]`)}  ${yellow(eur(o.price))}${o.available ? '' : red('  OUT OF STOCK')}`);
        for (const t of o.tiers) {
          console.log(`\n${bold(String(t.tier))}  ${t.required ? yellow('(choose one)') : dim('(optional)')}`);
          table(t.options.map((op) => [`  ${op.code}`, op.name, op.price ? `+${eur(op.price)}` : '']), { styles: [dim, undefined, yellow] });
        }
      });
    }
    case 'cart': {
      const cart = efood.cart(shopArg(2));
      if (sub === 'clear') {
        await cart.clear();
        console.log(green('Cart cleared.'));
        return;
      }
      const add = () => ({
        item: arg(3, 'item'),
        options: flags.opt,
        quantity: numFlag('qty'),
        comment: flags.comment,
      });
      if (sub === 'add' && flags.dry) {
        const line = await cart.preview(add());
        return out(line, () => printLines([line]));
      }
      const result =
        sub === 'show'
          ? await cart.get()
          : sub === 'add'
            ? await cart.add(add())
            : sub === 'remove'
              ? await cart.remove(Number(arg(3, 'line number')))
              : fail('Use: efood cart show|add|remove|clear <shop>');
      return out(result, () => {
        if (!result.lines.length) return console.log('The cart is empty.');
        printLines(result.lines);
        console.log(`Total ${bold(yellow(eur(result.total)))}`);
      });
    }
    case 'checkout': {
      const shopId = shopArg(1);
      return ordering(
        efood,
        () =>
          efood.checkout(shopId, {
            dryRun: !flags.yes,
            maxTotal: numFlag('max-total'),
            addressId: numFlag('address'),
            payment: payFlag(),
            card: flags.card,
          }),
        out,
      );
    }
    case 'fav': {
      if (sub === 'list') {
        const list = efood.favorites.list();
        return out(list, () => {
          if (!list.length) return console.log('No favourites saved. See `efood fav save`.');
          for (const f of list) {
            const last = efood.favorites.lastOrder(f.name);
            console.log(`${bold(cyan(f.name))}: ${f.shopName} ${dim(`(shop ${f.shopId})`)}, limit ${yellow(eur(f.maxTotal))}, ${f.payment === 'card' ? `card ending ${f.cardLast4}` : 'cash'}${last ? `, last ordered ${last.date}` : ''}`);
            printLines(f.lines);
          }
        });
      }
      const name = arg(2, 'favourite name');
      if (sub === 'save') {
        const f = await efood.favorites.saveFromCart(name, shopArg(3), {
          addressId: numFlag('address'),
          maxTotal: numFlag('max-total'),
          payment: payFlag(),
          card: flags.card,
        });
        return out(f, () => {
          const how = f.payment === 'card' ? `card ending ${f.cardLast4}` : 'cash';
          console.log(`${green('Saved')} "${bold(f.name)}" from ${f.shopName}, limit ${yellow(eur(f.maxTotal))}, paid by ${how}:`);
          printLines(f.lines);
        });
      }
      if (sub === 'remove') {
        efood.favorites.remove(name);
        console.log(`Removed "${name}".`);
        return;
      }
      if (sub === 'order') {
        return ordering(
          efood,
          () =>
            efood.favorites.order(name, {
              dryRun: !flags.yes,
              force: flags.force,
              maxTotal: numFlag('max-total'),
              payment: payFlag(),
              card: flags.card,
            }),
          out,
        );
      }
      return fail('Use: efood fav save|list|remove|order');
    }
    case 'stats': {
      const s = await efood.stats({ since: flags.since, until: flags.until });
      return out(s, () => {
        if (!s.orders) return console.log('No orders in that period.');
        const top = numFlag('top') ?? 15;
        const pct = (share: number) => `${(share * 100).toFixed(1)}%`;
        const shown = top > 0 ? s.shops.slice(0, top) : s.shops;
        const rest = s.shops.slice(shown.length);
        const restTotal = rest.reduce((n, x) => n + x.total, 0);
        console.log(`${bold(String(s.orders))} orders from ${bold(String(s.shops.length))} shops, ${dim(`${(s.from ?? '').slice(0, 10)} to ${(s.to ?? '').slice(0, 10)}`)}\n`);
        table(
          [
            ['SHOP', 'ORDERS', 'SPENT', 'SHARE', 'AVERAGE', 'LAST ORDER'],
            ...shown.map((x) => [x.shopName, x.orders, eur(x.total), pct(x.share), eur(x.average), (x.lastOrder ?? '').slice(0, 10)]),
            ...(rest.length
              ? [[`${rest.length} more shops`, rest.reduce((n, x) => n + x.orders, 0), eur(restTotal), pct(s.total ? restTotal / s.total : 0), '', '']]
              : []),
          ],
          { header: true, styles: [bold, undefined, yellow, dim, undefined, dim] },
        );
        if (s.years.length > 1) {
          console.log('');
          table([['YEAR', 'ORDERS', 'SPENT'], ...s.years.map((y) => [y.year, y.orders, eur(y.total)])], { header: true, styles: [bold, undefined, yellow] });
        }
        console.log(`\nTotal spent ${bold(yellow(eur(s.total)))}, ${eur(s.average)} per order`);
        if (s.excluded) console.log(dim(`${s.excluded} cancelled or rejected orders are not counted.`));
        if (s.truncated) console.log(yellow('The history is longer than this command reads; the oldest orders are missing.'));
      });
    }
    case 'status': {
      console.log(JSON.stringify(await efood.orderStatus(arg(1, 'order id')), null, 2));
      return;
    }
    case 'serve': {
      const token = process.env.EFOOD_API_TOKEN?.trim();
      if (!token) fail('Set EFOOD_API_TOKEN (in the environment or .env) before starting the service.');
      const port = numFlag('port') ?? Number(process.env.EFOOD_PORT ?? 8787);
      const host = flags.host ?? process.env.EFOOD_HOST ?? '0.0.0.0';
      createEfoodServer({ efood, token }).listen(port, host, () => {
        console.log(`efood service listening on ${cyan(`http://${host}:${port}`)}`);
        if (!efood.hasSession()) console.log(yellow('No session saved yet: POST /session or run `efood login`.'));
      });
      return;
    }
    default:
      fail(`Unknown command "${command}". See \`efood help\`.`);
  }
}

main().catch((err: unknown) => {
  if (err instanceof EfoodError) {
    console.error(`${errRed(`Error (${err.code}):`)} ${err.message}`);
    const details = err.details as { tiers?: Array<{ tier: string; options: Array<{ name: string }> }>; candidates?: Array<{ code?: string; name?: string }> } | undefined;
    for (const t of details?.tiers ?? []) {
      console.error(`  ${errCyan(String(t.tier))}: ${t.options.map((o) => o.name).join(errDim(' | '))}`);
    }
    for (const c of details?.candidates ?? []) console.error(`  ${errDim(String(c.code ?? ''))}  ${c.name}`);
    if (err.code === 'session_expired' || err.code === 'no_session') {
      console.error('Get a fresh session id from the browser and run `efood login`.');
    }
  } else {
    console.error(err);
  }
  process.exitCode = 1;
});

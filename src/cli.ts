#!/usr/bin/env node
/**
 * Command line for the efood client. `efood help` lists the commands.
 */
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Efood, EfoodError, type CartLine, type OrderResult } from './index.js';
import { createEfoodServer } from './server.js';

const HELP = `efood - unofficial efood.gr client

Session
  efood login [session-id]        save a session id (prompts when omitted)
  efood whoami                    show the logged-in account

Account
  efood addresses                 saved delivery addresses
  efood orders [--limit 20]       past orders

Browse
  efood shops [--q text] [--favorites] [--open] [--address id | --lat n --lon n]
  efood menu <shop> [--q text]
  efood options <shop> <item>     option groups of one item

Cart (the cart efood saves per shop, shared with the app)
  efood cart show <shop>
  efood cart add <shop> <item> [--opt name]... [--qty 1] [--comment text] [--dry]
  efood cart remove <shop> <line-number>
  efood cart clear <shop>
  efood checkout <shop> [--yes] [--max-total n] [--address id]

Favourites (saved order templates)
  efood fav save <name> <shop> [--address id] [--max-total n]
  efood fav list
  efood fav remove <name>
  efood fav order <name> [--yes] [--force] [--max-total n]

Orders
  efood status <order-id>

Service
  efood serve [--port 8787] [--host 0.0.0.0]    needs EFOOD_API_TOKEN

checkout and fav order only validate unless --yes is given.
<item> is an item code (IT_...) or a name. Add --json to any command for raw output.
Get the session id from the browser: log in on e-food.gr, open the console
and run  window.app.userSid  (or copy the "sparks-sid" cookie).`;

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    json: { type: 'boolean' },
    yes: { type: 'boolean' },
    force: { type: 'boolean' },
    dry: { type: 'boolean' },
    favorites: { type: 'boolean' },
    open: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
    q: { type: 'string' },
    limit: { type: 'string' },
    address: { type: 'string' },
    lat: { type: 'string' },
    lon: { type: 'string' },
    opt: { type: 'string', multiple: true },
    qty: { type: 'string' },
    comment: { type: 'string' },
    'max-total': { type: 'string' },
    port: { type: 'string' },
    host: { type: 'string' },
  },
});

function fail(message: string): never {
  throw new EfoodError('bad_request', message);
}

function numFlag(name: 'limit' | 'address' | 'lat' | 'lon' | 'qty' | 'max-total' | 'port'): number | undefined {
  const v = flags[name];
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) fail(`--${name} must be a number.`);
  return n;
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

function table(rows: Array<Array<string | number | undefined>>): void {
  const cells = rows.map((r) => r.map((c) => (c === undefined ? '-' : String(c))));
  const widths = cells[0]?.map((_, i) => Math.max(...cells.map((r) => r[i].length))) ?? [];
  for (const r of cells) console.log(r.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd());
}

function printLines(lines: CartLine[]): void {
  lines.forEach((l, i) => {
    console.log(`${i + 1}. ${l.quantity} x ${l.name}  ${eur(l.total)}`);
    if (l.optionNames.length) console.log(`     ${l.optionNames.join(', ')}`);
    if (l.comment) console.log(`     note: ${l.comment}`);
  });
}

function printOrder(r: OrderResult): void {
  console.log(`${r.shopName ?? r.shopId}  (address ${r.addressId})`);
  printLines(r.lines);
  console.log(`Items ${eur(r.itemsTotal)} + delivery ${eur(r.deliveryCost)} = ${eur(r.estimatedTotal)} (cash)`);
  if (r.dryRun) {
    console.log('Dry run: efood accepted the order as valid. Nothing was ordered. Add --yes to place it.');
  } else {
    console.log(`ORDER PLACED. Order id: ${r.orderId || '(not returned)'}${r.eta ? `, expected in ${r.eta}` : ''}`);
  }
}

async function main(): Promise<void> {
  const [command, sub] = positionals;
  if (!command || command === 'help' || flags.help) {
    console.log(HELP);
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
      console.log(`Session saved. Logged in as ${account.firstName ?? account.email ?? 'your account'}.`);
      return;
    }
    case 'whoami': {
      const a = await efood.me();
      return out(a, () => console.log(`${a.firstName ?? ''} ${a.lastName ?? ''} <${a.email ?? '?'}>`.trim()));
    }
    case 'addresses': {
      const list = await efood.addresses();
      return out(list, () =>
        table([['ID', 'LABEL', 'ADDRESS', ''], ...list.map((a) => [a.id, a.label, a.street, a.isDefault ? 'default' : ''])]),
      );
    }
    case 'orders': {
      const list = await efood.orders({ limit: numFlag('limit') });
      return out(list, () => {
        for (const o of list) {
          console.log(`${o.date ?? '?'}  #${o.id}  ${o.shopName} (shop ${o.shopId})  ${eur(o.total)}  ${o.status ?? ''}`);
          for (const it of o.items) {
            console.log(`    ${it.quantity} x ${it.name} [${it.code}]${it.customisation ? `  ${it.customisation}` : ''}`);
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
        ]),
      );
    }
    case 'menu': {
      const menu = await efood.menu(shopArg(1));
      const q = flags.q?.toLowerCase();
      return out(menu, () => {
        const s = menu.shop;
        console.log(`${s.name}  ${s.isOpen === false ? 'CLOSED' : 'open'}  min ${eur(s.minimumOrder)}  delivery ${eur(s.deliveryCost)}`);
        for (const c of menu.categories) {
          const items = c.items.filter((it) => !q || (it.name ?? '').toLowerCase().includes(q));
          if (!items.length) continue;
          console.log(`\n${c.name}`);
          table(items.map((it) => [`  ${it.code}`, it.name, eur(it.price), it.available ? '' : 'out of stock']));
        }
      });
    }
    case 'options': {
      const o = await efood.itemOptions(shopArg(1), arg(2, 'item'));
      return out(o, () => {
        console.log(`${o.name} [${o.code}]  ${eur(o.price)}${o.available ? '' : '  OUT OF STOCK'}`);
        for (const t of o.tiers) {
          console.log(`\n${t.tier}  (${t.required ? 'choose one' : 'optional'})`);
          table(t.options.map((op) => [`  ${op.code}`, op.name, op.price ? `+${eur(op.price)}` : '']));
        }
      });
    }
    case 'cart': {
      const cart = efood.cart(shopArg(2));
      if (sub === 'clear') {
        await cart.clear();
        console.log('Cart cleared.');
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
        console.log(`Total ${eur(result.total)}`);
      });
    }
    case 'checkout': {
      const r = await efood.checkout(shopArg(1), {
        dryRun: !flags.yes,
        maxTotal: numFlag('max-total'),
        addressId: numFlag('address'),
      });
      return out(r, () => printOrder(r));
    }
    case 'fav': {
      if (sub === 'list') {
        const list = efood.favorites.list();
        return out(list, () => {
          if (!list.length) return console.log('No favourites saved. See `efood fav save`.');
          for (const f of list) {
            const last = efood.favorites.lastOrder(f.name);
            console.log(`${f.name}: ${f.shopName} (shop ${f.shopId}), limit ${eur(f.maxTotal)}${last ? `, last ordered ${last.date}` : ''}`);
            printLines(f.lines);
          }
        });
      }
      const name = arg(2, 'favourite name');
      if (sub === 'save') {
        const f = await efood.favorites.saveFromCart(name, shopArg(3), {
          addressId: numFlag('address'),
          maxTotal: numFlag('max-total'),
        });
        return out(f, () => {
          console.log(`Saved "${f.name}" from ${f.shopName}, limit ${eur(f.maxTotal)}:`);
          printLines(f.lines);
        });
      }
      if (sub === 'remove') {
        efood.favorites.remove(name);
        console.log(`Removed "${name}".`);
        return;
      }
      if (sub === 'order') {
        const r = await efood.favorites.order(name, {
          dryRun: !flags.yes,
          force: flags.force,
          maxTotal: numFlag('max-total'),
        });
        return out(r, () => printOrder(r));
      }
      return fail('Use: efood fav save|list|remove|order');
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
        console.log(`efood service listening on http://${host}:${port}`);
        if (!efood.hasSession()) console.log('No session saved yet: POST /session or run `efood login`.');
      });
      return;
    }
    default:
      fail(`Unknown command "${command}". See \`efood help\`.`);
  }
}

main().catch((err: unknown) => {
  if (err instanceof EfoodError) {
    console.error(`Error (${err.code}): ${err.message}`);
    const details = err.details as { tiers?: Array<{ tier: string; options: Array<{ name: string }> }>; candidates?: Array<{ code?: string; name?: string }> } | undefined;
    for (const t of details?.tiers ?? []) {
      console.error(`  ${t.tier}: ${t.options.map((o) => o.name).join(' | ')}`);
    }
    for (const c of details?.candidates ?? []) console.error(`  ${c.code}  ${c.name}`);
    if (err.code === 'session_expired' || err.code === 'no_session') {
      console.error('Get a fresh session id from the browser and run `efood login`.');
    }
  } else {
    console.error(err);
  }
  process.exitCode = 1;
});

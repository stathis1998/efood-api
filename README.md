# efood-api

Unofficial client for efood.gr: a TypeScript library, a command-line tool, and a small HTTP service for automations (anything that can send an HTTP request). No runtime dependencies; Node 20 or newer.

With it you can log in, list past orders, browse shops and menus, fill the cart and place an order, either by hand or on a schedule.

It is not affiliated with efood. It talks to the same endpoints the efood app and website use, which can change without notice. Use it with your own account, at your own risk.

## Status

| Part | State |
|---|---|
| Shop list, menu, item options | Works; checked against the live API, no login needed |
| Login, addresses, past orders, order status | Works; checked with a real session |
| Saved cart (add, remove, clear) and dry-run checkout | Works; checked with a real session |
| Placing an order (cash) | Written; never run for real |
| Card payment | Not implemented |

## Setup

```sh
npm install
npm run build
npm link        # optional: makes the `efood` command available everywhere
```

Without `npm link`, use `node dist/src/cli.js` in place of `efood`.

### Log in

The client reuses the session of your browser, so it works whichever way you sign in (email, Google, Apple, Facebook):

1. Log in on https://www.e-food.gr.
2. Open the browser console and run `window.app.userSid` (or copy the value of the `sparks-sid` cookie).
3. Run `efood login` and paste the value.

The session id is stored in `data/state.json`. Treat it like a password: anyone who has it can use your account. Sessions are long-lived (one was still valid after 12 weeks), but efood does not document how long; when one stops working, commands fail with `session_expired` and you repeat the steps above.

## Example: a repeatable order

The shop id, item and options below are examples; use the ones the commands show you.

```sh
efood addresses                        # your saved addresses
efood shops --q badger                 # find the shop id
efood menu 4489803 --q freddo          # find the item
efood options 4489803 "freddo espresso"

efood cart clear 4489803
efood cart add 4489803 "freddo espresso" --opt regular --opt μέτριος
efood cart show 4489803

efood fav save coffee 4489803          # save the cart as a favourite named "coffee"
efood fav order coffee                 # dry run: validates, orders nothing
efood fav order coffee --yes           # places the order, cash on delivery
```

Orders go to the account's default address unless you pass `--address <id>`.

You can also build the cart in the efood app and then run `efood fav save`: the cart is efood's own saved cart, shared with the app.

### Safety rules

- `checkout` and `fav order` only validate unless `--yes` is given (in the library and the service: unless `dryRun` is exactly `false`).
- A favourite is ordered at most once per calendar day unless `--force`.
- A favourite has a price limit (`--max-total`, default: the price when saved plus 20%). An order is refused when the total efood quotes for it, fees included, is above the limit.
- An order is refused when the shop is closed, does not deliver to the address, does not take cash, an item is out of stock, or the total is under the shop minimum.
- Every placed order is appended to `data/orders.log`.

Required options are never guessed: if an item needs a size or a sweetness and you did not give one, `cart add` fails and lists the choices.

## Library

```ts
import { Efood } from 'efood-api';

const efood = new Efood();                       // loads the saved session
await efood.setSession(sid);
await efood.orders({ limit: 10 });
await efood.shops({ query: 'coffee', openOnly: true });
await efood.menu(shopId);
await efood.itemOptions(shopId, 'freddo espresso');
await efood.cart(shopId).add({ item: 'freddo espresso', options: ['regular', 'μέτριος'] });
await efood.checkout(shopId);                    // dry run
await efood.favorites.saveFromCart('coffee', shopId);
await efood.favorites.order('coffee', { dryRun: false });
```

Errors are `EfoodError` with a stable `code`: `no_session`, `session_expired`, `blocked`, `rate_limited`, `network_error`, `api_error`, `not_found`, `ambiguous`, `option_not_found`, `bad_request`, `empty_cart`, `shop_closed`, `out_of_stock`, `below_minimum`, `over_max_total`, `payment_unavailable`, `already_ordered_today`.

## HTTP service

```sh
cp .env.example .env     # set EFOOD_API_TOKEN
efood serve              # http://0.0.0.0:8787
```

Settings, from the environment or `.env`:

| Variable | Meaning | Default |
|---|---|---|
| `EFOOD_API_TOKEN` | Token callers must send. Required. | none |
| `EFOOD_PORT` | Port to listen on | `8787` |
| `EFOOD_HOST` | Interface to listen on | `0.0.0.0` |
| `EFOOD_DATA_DIR` | Where the session, favourites and order log are kept | `data/` in the project |

Every request needs `Authorization: Bearer <EFOOD_API_TOKEN>`.

| Route | Purpose |
|---|---|
| `GET /health` | `{ok, session: valid/expired/missing/unknown, user, lastOrders}` |
| `POST /session` | Body `{"sessionId": "..."}`: check and save a new session |
| `GET /addresses` | Saved addresses |
| `GET /orders?limit=20` | Past orders |
| `GET /orders/:id/status` | Status of a placed order |
| `GET /shops?q=&open=true&favorites=true&addressId=` | Shops for an address |
| `GET /shops/:id/menu` | Shop details and menu |
| `GET /shops/:id/cart` | The saved cart for a shop |
| `GET /favorites` | Saved favourites |
| `POST /favorites/:name/order` | Body `{"dryRun": false, "maxTotal": 4, "force": false}`, all optional |

Errors come back as `{"error": "<code>", "message": "..."}`: 400/404 for bad input, 409 when an order guard refuses, 503 when the efood session is missing or expired, 502 when efood itself fails.

The service has no TLS and one shared token. Keep it on your home network.

### Example: Home Assistant

One way to use the service: order a favourite on a schedule and get notified if the session expires. Replace `EFOOD_HOST` with the machine running `efood serve`.

```yaml
# configuration.yaml
rest_command:
  efood_order:
    url: "http://EFOOD_HOST:8787/favorites/{{ favorite }}/order"
    method: post
    headers:
      Authorization: !secret efood_bearer     # "Bearer <token>" in secrets.yaml
    content_type: "application/json"
    payload: '{"dryRun": {{ dry_run | default(true) | tojson }}}'
    timeout: 60

rest:
  - resource: "http://EFOOD_HOST:8787/health"
    headers:
      Authorization: !secret efood_bearer
    scan_interval: 1800
    binary_sensor:
      - name: "efood session"
        value_template: "{{ value_json.ok }}"
```

```yaml
# automations.yaml
- alias: "Order morning coffee"
  trigger:
    - platform: time
      at: "08:30:00"
  condition:
    - condition: time
      weekday: [mon, tue, wed, thu, fri]
  action:
    - service: rest_command.efood_order
      data: { favorite: coffee, dry_run: false }
      response_variable: order
    - service: notify.notify
      data:
        message: >
          {% if order.status == 200 %}Coffee ordered, {{ order.content.total }}€.
          {% else %}Coffee NOT ordered: {{ order.content.message }}{% endif %}

- alias: "efood session expired"
  trigger:
    - platform: state
      entity_id: binary_sensor.efood_session
      to: "off"
  action:
    - service: notify.notify
      data: { message: "efood session expired. Run `efood login` with a fresh session id." }
```

## Development

```sh
npm test          # compiles, then runs the tests against saved fixtures; no network
```

Layout: `src/efood/` is the HTTP layer (client, endpoints, parsers), `src/cart/` builds cart lines and order payloads, `src/index.ts` is the public `Efood` class, `src/cli.ts` and `src/server.ts` sit on top of it.

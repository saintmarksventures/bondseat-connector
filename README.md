# BondSeat connector

Snag hard-to-get tables on Resy. BondSeat watches for cancellations or tries to book right when reservations open, then automatically books a table that matches your preferences.

BondSeat carefully manages your credentials and paces availability checks, keeping routine monitoring separate from your personal Resy account.

The agent uses booking tools. The connector keeps the access token, setup codes,
retry identifiers and polling state private. The diner only opens a setup link.
No token needs to be copied into chat or remembered by the agent.

This is an MCP server using the official TypeScript SDK and local stdio transport.
It works with clients that can launch a local MCP process. It is not a hosted HTTP
MCP endpoint. The underlying REST API also remains available to custom runtimes.

## Install

Requires Node.js 22 or newer. Configure an MCP client that supports local stdio:

```json
{
  "mcpServers": {
    "bondseat": {
      "command": "npx",
      "args": ["--yes", "@bondseat/mcp@0.1.2"]
    }
  }
}
```

The default connects to the production BondSeat API. There is no API key to copy:
when setup is needed, the diner opens a link to connect Resy and authorize the
$10 USD success fee. Unsuccessful requests incur no fee. The account-free flow
supports Resy; the diner needs a saved card in Resy for restaurant charges and
separately authorizes BondSeat's fee through Stripe.

The executable starts MCP when called without arguments. A CLI is also available:

```sh
npx --yes @bondseat/mcp@0.1.2 --help
npx --yes @bondseat/mcp@0.1.2 schema request
npx --yes @bondseat/mcp@0.1.2 restaurants <<'BONDSEAT_INPUT'
{"q":"La Vara","city":"Brooklyn"}
BONDSEAT_INPUT
```

Commands: `restaurants`, `request`, `status`, `requests`, `stop`, `resume`, `connect`.
Pass JSON through stdin. `schema <command>` prints the MCP tool's input schema
without contacting the API. CLI exits: 0 for a result (including pending setup),
1 for an action-required result or runtime error, 2 for invalid input. Read JSON
results even on exit 1. Diagnostics never include raw inputs or stored credentials.

The [BondSeat skill](skills/bondseat/SKILL.md) provides the workflow for OpenClaw
and other skill-capable agents. It can use either connected MCP tools or the CLI.
Installing the skill does not by itself configure an MCP connection.

## Runtime configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `BONDSEAT_API_URL` | Production API at `https://6qq9f4msd4.execute-api.us-east-1.amazonaws.com/agent/v1` | Trusted HTTPS BondSeat API base. |
| `BONDSEAT_STATE_FILE` | `~/.bondseat/connection.json` | Private, persistent state for one diner and environment. |

A multi-user host must isolate each diner's state. The same file must remain
available to subsequent CLI calls and scheduled follow-ups. If a client executes
in a sandbox, configure Node, network access and persistent storage there.

For QA development, explicitly configure **both** variables:

```json
{
  "BONDSEAT_API_URL": "https://31clusup32.execute-api.us-east-1.amazonaws.com/agent/v1",
  "BONDSEAT_STATE_FILE": "/absolute/private/path/bondseat/qa.json"
}
```

Local source development can launch `node server.mjs` or `node cli.mjs` from this
package after installing dependencies. Remote-only clients need a hosted adapter;
this package does not expose an HTTP MCP endpoint.

## Agent workflow

1. Start directly with a name and location:
   `bondseat_request({restaurant: "La Vara", city: "Cobble Hill", partySize: 2, date, startTime: "18:00", endTime: "19:00", confirmed: true})`.
   BondSeat looks up the venue and adds it if missing. Multiple matches return choices without starting a request. No diner-managed restaurant IDs, directory additions or provider credentials are needed for lookup.
2. For a separate search, use `bondseat_restaurants({q: "La Vara", city: "Brooklyn"})` or `{url: "https://resy.com/cities/new-york-ny/venues/la-vara"}`. Pass the matching `restaurantId` to `bondseat_request`, or pass `restaurantUrl` directly:
   use the diner's actual authorized date and details. The original instruction
   may authorize automatic booking; do not ask again when a table appears.
3. Show the returned `setupUrl` if setup is required. The diner connects Resy and
   authorizes the displayed fee on BondSeat/Stripe. The connector retains codes.
4. Call `bondseat_status({})` after `pollAfterSeconds` to finish setup. It returns
   the started request; closing/restarting the connector preserves setup state.
5. `bondseat_status({kind, id})` reads saved status. Reads are cached for 60 seconds.
   Schedule these calls with the agent runtime's background/scheduled task facility;
   the connector does not schedule itself or push updates. Continue after the chat turn ends
   until `terminal` or user action is needed, then notify the diner and end that follow-up.
   Monitor `outcome: FIRED` (even with `status: PAUSED`) or scheduled `status: SUCCEEDED`
   means booked. Report the actual `bookedSlot` and dining details; follow `agentInstruction`.
   If the runtime cannot schedule follow-ups, disclose that and share the BondSeat manage page.
   Never promise a proactive update without scheduling one.
   Cancellation with `nextAction: verify_provider` leaves the booking outcome unconfirmed.
   Ask the diner to check their reservations with the provider; an in-flight attempt may still
   finish. Do not claim no booking exists or keep polling indefinitely. Later status reads
   can still report a completed booking.
6. If credentials need repair, show the returned reconnect link, then use
   `bondseat_resume({kind, id})` when authorized. `bondseat_connect({})` restores
   expired connector access without creating/resuming work or collecting a card.
7. `bondseat_stop({kind, id})` stops future attempts. It cannot cancel an existing
   restaurant reservation. Payment issues are resolved through `paymentUrl`,
   never by submitting another booking.

`bondseat_requests({kind: "monitor"})` lists existing requests; pass `nextCursor`
as `cursor`. Repeat for `kind: "scheduled"`. No API token or idempotency key is a
tool argument. Identical dining details intentionally reuse the same request;
use resume to repair paused work, not another request.

## Storage and deployment

One state file represents one diner and environment. Use a private directory
outside the repository, synced folders and prompt attachments. The reference
store writes mode-0600 files atomically, locks across processes, and rejects
symlinks. It stores credentials on disk with filesystem access protection, not
OS-keychain encryption. Custom runtimes can inject their own transactional secret
store via `withState(callback)`; the callback receives `(state, save)` and may
persist recovery identifiers before network calls.

The connector persists identifiers before submitting and retries a lost response
once with identical identifiers. It honors Retry-After, never polls providers,
and never returns bearer tokens or device codes in tool results. Server-side
recovery material is KMS-encrypted. Token-exchange replay is allowed for 24 hours
and always checks revocation. After that, reconnect restores access to existing
requests. Connecting another diner clears the previous diner's cached requests.

Do not point a QA test at production. Production deployment and a real booking
test require explicit approval and actual dining details. A success fee is only
collected for a successful booking; setup is uncharged.

## Validation

```sh
npm install
npm test
```

Tests use an MCP client and simulated REST responses to cover first submission,
lost setup/exchange responses, process restarts, concurrent stores, returning
diners, payment setup, credential expiry, status caching and secret-free tool
results. They never make a restaurant booking or payment.

Protocol references: [MCP stdio transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports),
[official SDK](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x).

The release test packs the npm artifact, installs it in a clean temporary directory,
and verifies CLI execution and MCP discovery without making live bookings or payments.
The connector is MIT licensed; the skill is separately MIT-0 for ClawHub distribution.

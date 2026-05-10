# Cross-DAG Coin Swap Test Protocol

**Goal:** Alice (you) creates an offer on her DAG, exports it as a ChangeBundle, sends it to Bob (remote agent), who imports it into his DAG, pays, settles, and claims. Then Bob sends his completed bundle back for Alice to import and claim her side.

**Prerequisites**
- Both parties run `glonFiggies` from `main` (commit `4935906` or later)
- Both have `npx tsx scripts/daemon.ts` running in a separate terminal
- Both have a wallet key (`coin wallet create default` or use existing)
- Both know their pubkey (`coin wallet list`)

**Important:** The CLI commands below go through the REPL (`npx tsx src/client.ts`), not `scripts/dispatch.ts`. `dispatch.ts` only routes typedActions, not CLI handler commands like `coin offer create`.

---

## Phase 1: Setup (both sides)

Start daemon on each machine (leave it running):
```bash
cd glonFiggies && npx tsx scripts/daemon.ts
```

In another terminal, start the REPL:
```bash
cd glonFiggies && npx tsx src/client.ts
```

Check wallet:
```
glon> coin wallet list
```

**Share pubkeys** over Discord so each side knows the other's address.

---

## Phase 2: Create & Export Offer (Alice)

Alice wants to sell 10 FOO for 25 BAR.

```
glon> coin balance <FOO_TOKEN_ID> <ALICE_PUBKEY>
glon> coin offer create <FOO_TOKEN_ID> 10 <BAR_TOKEN_ID> 25 --key=default
```

Note the offer_id from the response.

```
glon> coin offer export <OFFER_ID> --file=/tmp/offer-<OFFER_ID>.bundle
```

The file is raw binary protobuf. Base64 it for Discord:
```bash
# In a separate shell:
base64 /tmp/offer-<OFFER_ID>.bundle > /tmp/offer-<OFFER_ID>.b64
```

**Send to Bob:** Paste the base64 string (or the `.bundle` file via DM).

---

## Phase 3: Import & Accept (Bob)

```bash
# In a separate shell:
echo '<PASTE_BASE64_HERE>' | base64 -d > /tmp/offer-import.bundle
```

Then in the REPL:
```
glon> coin offer import /tmp/offer-import.bundle
glon> coin offer info <OFFER_ID>
glon> coin balance <BAR_TOKEN_ID> <BOB_PUBKEY>
glon> coin offer accept <OFFER_ID> --key=default
glon> coin offer claim <OFFER_ID> --key=default
```

If accept + claim succeed:
- Bob's BAR is reduced by 25
- Bob's bucket for FOO gains 10
- Offer status is now "settled"

---

## Phase 4: Export Completed Bundle (Bob → Alice)

```
glon> coin offer export <OFFER_ID> --file=/tmp/offer-completed-<OFFER_ID>.bundle
```

```bash
# In a separate shell:
base64 /tmp/offer-completed-<OFFER_ID>.bundle > /tmp/offer-completed.b64
```

**Send to Alice.**

---

## Phase 5: Import & Claim (Alice)

```bash
echo '<PASTE_BASE64>' | base64 -d > /tmp/offer-completed.bundle
```

In the REPL:
```
glon> coin offer import /tmp/offer-completed.bundle
glon> coin offer claim <OFFER_ID> --key=default
```

**Expected result:** Alice's BAR bucket gains 25, FOO reduced by 10.

---

## What Actually Travels

| Direction | Content | Format |
|---|---|---|
| Alice → Bob | Offer ChangeBundle (genesis + escrow) | Binary `.bundle` (protobuf `ChangeBundle`) |
| Bob → Alice | Completed ChangeBundle (+ payment + settle + claim) | Binary `.bundle` |

Each `.bundle` contains a `ChangeBundle` message with all the `.pb` changes for the offer object. The recipient imports each change via the kernel's normal `pushChanges` path.

---

## Troubleshooting

**"Program not running"** — daemon hasn't finished bootstrapping. Wait for `Done. X created, Y updated` in daemon output before starting the REPL.

**"Insufficient balance"** — mint more tokens first:
```
glon> coin mint <token_id> <amount> --key=default
```

**"Not found or not an offer" after import** — double-check the offer ID and that the bundle was saved correctly (binary, not corrupted by copy-paste).

**"Validation rejected" on accept** — the offer terms may not match what Bob has. Double-check token IDs and amounts. Also verify Bob's wallet key has sufficient balance.

**"Only the maker can cancel"** — cancel authority is enforced in the validator. Good, that means the security fix is working.

---

## Minimal Test (using existing Figgies token)

If both sides already have the Figgies token `b1aa1f2da78048a6a2051db9`:
1. Alice: `coin offer create b1aa1f2da78048a6a2051db9 10 b1aa1f2da78048a6a2051db9 5 --key=default`
2. Alice: `coin offer export <offer_id> --file=/tmp/offer.bundle`
3. Send `/tmp/offer.bundle` to Bob (base64 encode for Discord)
4. Bob: `echo '<base64>' | base64 -d > /tmp/offer.bundle`
5. Bob: `coin offer import /tmp/offer.bundle`
6. Bob: `coin offer accept <offer_id> --key=default`
7. Bob: `coin offer claim <offer_id> --key=default`
8. Bob exports completed bundle, sends back
9. Alice: imports completed bundle, claims her side

# OSRS Hiscores contract

Status: Verified 2026-07-24

This integration is exclusively for Jagex's **Old School RuneScape (OSRS)**
Hiscores. RuneScape 3 endpoints and data are outside the product.

## Individual endpoint strategy

OSLeaders uses the named JSON response at:

```text
https://secure.runescape.com/m={endpoint}/index_lite.json?player={encoded RSN}
```

| Displayed mode         | Endpoint                             | Verification statement                                                                |
| ---------------------- | ------------------------------------ | ------------------------------------------------------------------------------------- |
| Main                   | `hiscore_oldschool`                  | Server-managed label                                                                  |
| Ironman                | `hiscore_oldschool_ironman`          | Endpoint-verifiable after excluding the more specific Hardcore and Ultimate endpoints |
| Hardcore Ironman       | `hiscore_oldschool_hardcore_ironman` | Endpoint-verifiable listing; it does not prove that the account is still alive        |
| Ultimate Ironman       | `hiscore_oldschool_ultimate`         | Endpoint-verifiable                                                                   |
| Group Ironman          | `hiscore_oldschool`                  | Server-managed label                                                                  |
| Hardcore Group Ironman | `hiscore_oldschool`                  | Server-managed label                                                                  |

The standard endpoint proves that Jagex can return current individual OSRS
statistics. It does not prove Main mode because iron and group-iron accounts
can also be represented there.

The general Ironman endpoint includes accounts also found on the more specific
Hardcore and Ultimate endpoints. A future registration validator must therefore
check the specific endpoints before describing an account as regular Ironman.

Jagex exposes Group Ironman and Hardcore Group Ironman pages by group name and
group size. They do not provide an equivalent individual-player lite endpoint.
OSLeaders consequently validates the individual account through the standard
OSRS endpoint and stores the selected group mode as server-managed information.

## Response shape

The current JSON response contains a submitted name, named skill rows, and named
activity rows. On the verification date it contained Overall plus all 24 OSRS
skills, including Sailing, and 91 activities.

Jagex adds skills, bosses, and activities over time. The parser therefore:

- requires every OSLeaders skill and boss name known by this contract;
- rejects duplicate IDs or names;
- rejects invalid field types and unsupported numeric values;
- treats a missing required row as incomplete rather than malformed;
- accepts additional named rows so an upstream addition does not shift or
  invalidate existing data.

The returned `name` can reflect submitted casing, underscores, or surrounding
whitespace. It is not a canonical-name source and must not silently replace the
server's stored display name.

## New boss update procedure

When Jagex adds a boss that OSLeaders should support, verify its exact activity
name against the live JSON endpoint, then update the central
`OSRS_BOSS_ACTIVITY_NAMES` catalog and the representative fixture. Update the
fixture activity count and add focused parser and shared-menu coverage. The
catalog is deliberately the single source for boss parsing, lookups,
leaderboards, competition metrics, and daily-recap baseline and gain handling;
no per-command boss list should be added.
When the supported activity is a raid, add it to
`OSRS_RAID_ACTIVITY_NAMES` as well, so the shared Discord selector places it
in the dedicated Raids menu; other bosses remain in the alphabetical menus.

Existing recap baselines can predate a newly supported boss. Their next
successful collection records the new current value but omits a gain for that
boss because no prior comparable value exists. This repairs the baseline without
misreporting an account's all-time KC as daily activity. Add the boss name to
the narrowly scoped legacy-baseline compatibility list in recap collection at
the same time; missing established boss fields remain a `baseline_incomplete`
failure so corruption cannot be silently repaired.

## Numeric values

Skill rows contain safe integer `id`, `rank`, `level`, and `xp` fields. Activity
rows contain safe integer `id`, `rank`, and `score` fields. Values outside
JavaScript's safe-integer range are rejected so a lossy JSON number can never
be accepted as a valid XP or KC snapshot.

Jagex uses `-1` for unranked values. A score of `-1` is not converted to zero:
ranking thresholds mean unranked does not reliably prove literal zero KC.
Callers must retain that distinction.

## Failure categories

The centralized client result model distinguishes:

- success;
- not found;
- mode incompatibility;
- timeout;
- temporary upstream failure;
- malformed response;
- incomplete response.

This parser branch produces success, malformed response, and incomplete
response. HTTP status mapping, timeout, retry, concurrency, and cache policy
belong to the next Stage 3 transport branch.

## Verification evidence

The investigation used live public responses from the official
`secure.runescape.com` OSRS endpoints. It verified:

- HTTP 200 JSON and CSV responses for ranked accounts;
- HTTP 404 for absent accounts and incompatible mode endpoints;
- the standard -> Ironman -> Hardcore/Ultimate endpoint hierarchy;
- case-insensitive queries and percent-encoded or `+` spaces;
- the current named skill and activity layout;
- group-oriented GIM and HCGIM pages rather than individual lite endpoints.

Deterministic automated tests use a sanitized representative response with all
25 current skill rows and all 91 current activity rows, plus focused derived
cases for future additional activities and malformed data. They never require
live Jagex access.

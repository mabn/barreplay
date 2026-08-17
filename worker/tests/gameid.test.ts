// parseGameId is the TypeScript twin of barapi.ParseGameID
// (internal/barapi/barapi_test.go's TestParseGameID is the same table). The
// two must agree: the Go side is what eventually looks the game up, so a link
// the worker accepts and Go rejects becomes a job that can only fail.
import { strict as assert } from "node:assert";
import test from "node:test";

import { parseGameId } from "../src/worker/gameid";

const ID = "836d486a5480a9e830be54db7d2c7be9";

test("parseGameId finds the id in every link a replay is shared as", () => {
  for (const input of [
    ID,
    ID.toUpperCase(),
    `  ${ID}  `,
    `https://gex.honu.pw/match/${ID}`,
    `https://bar-rts.com/replays/${ID}`,
    `https://bar-rts.com/replays/${ID}/`,
    `https://api.bar-rts.com/replays/${ID}`,
    `https://www.beyondallreason.info/replays?gameId=${ID}`,
    `https://www.beyondallreason.info/replays?foo=1&gameId=${ID}&bar=2`,
    // A pasted URL routinely loses its scheme. `new URL` throws on this one,
    // which is exactly why the parser does not use it — Go's url.Parse reads
    // it as a path and finds the id.
    `bar-rts.com/replays/${ID}`,
    // Fragments and queries must not glue onto the last segment.
    `https://bar-rts.com/replays/${ID}#chat`,
    `https://bar-rts.com/replays/${ID}?tab=stats`,
  ]) {
    assert.equal(parseGameId(input), ID, `parseGameId(${JSON.stringify(input)})`);
  }
});

test("parseGameId rejects anything that is not a game id", () => {
  for (const input of [
    "",
    "   ",
    "not-a-replay",
    "https://bar-rts.com/replays/",
    "https://bar-rts.com/replays",
    ID.slice(0, 31), // one hex short
    ID + "a", // one hex long
    `https://bar-rts.com/replays/${ID.slice(0, 31)}`,
    "https://www.beyondallreason.info/replays?gameId=deadbeef",
    // The id has to be the LAST segment, like the Go original.
    `https://bar-rts.com/replays/${ID}/frames`,
  ]) {
    assert.equal(parseGameId(input), null, `parseGameId(${JSON.stringify(input)})`);
  }
});

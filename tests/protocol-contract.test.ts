import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  parseEvent,
  parseGrant,
  withinGrant,
} from "../packages/sync-protocol/src/index.js";
test("published synthetic contract fixtures preserve corrections and strict metadata scope", () => {
  const fixture = JSON.parse(
    fs.readFileSync(
      new URL("../packages/sync-protocol/fixtures.json", import.meta.url),
      "utf8",
    ),
  );
  const scope = {
    ...parseGrant(fixture.grant),
    id: "grant-synthetic",
    userId: "user-synthetic",
  };
  for (const row of fixture.events) {
    const event = parseEvent(row);
    assert.equal(
      withinGrant(event, scope, Date.parse("2030-01-02T12:00:00Z")),
      null,
    );
    assert.throws(
      () => parseEvent({ ...row, prompt: "synthetic forbidden body" }),
      /Unexpected field/,
    );
  }
  assert.equal(fixture.events[1].correctsEventId, fixture.events[0].eventId);
  assert.equal(fixture.events[2].quota.remainingPercent, null);
  assert.throws(
    () =>
      parseEvent({
        ...fixture.events[0],
        usage: { input: 1, cached: 2, output: 1, reasoning: 0 },
      }),
    /subsets/,
  );
});

/**
 * Unit tests for src/rotation.ts pure state-machine functions.
 *
 * Run: node --experimental-strip-types --test test/rotation.test.ts
 *
 * All tests use an injectable `now` clock so assertions are deterministic.
 * File I/O is only used in the loadRotationConfigFrom suite.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

import { classifyLogContent } from "../src/execute.ts";
import {
	checkPinUsable,
	loadRotationConfigFrom,
	markExhausted,
	markFlagged,
	markSuccess,
	pickNextAccount,
	refreshAccountState,
	todayStamp,
} from "../src/rotation.ts";
import type { RotationAccountState, RotationConfig, RotationState } from "../src/types.ts";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const T0 = 1_000_000_000_000; // fixed epoch ms for tests

function makeConfig(names = ["dv", "jn"]): RotationConfig {
	return {
		accounts: names.map((n) => ({ name: n, home: `/fake/home/${n}` })),
		dbusAddress: "unix:path=/tmp/fake-dbus",
		dailySoftCap: 90,
		defaultCooldownSec: 60,
		protectivePauseHours: 6,
		jitterMs: [400, 1200],
	};
}

function makeAccountState(overrides: Partial<RotationAccountState> = {}): RotationAccountState {
	return {
		status: "AVAILABLE",
		cooldownUntil: 0,
		requestsToday: 0,
		dayStamp: todayStamp(T0),
		requestsSinceRotation: 0,
		lastUsedMs: 0,
		lastError: null,
		...overrides,
	};
}

function makeState(names = ["dv", "jn"], current = "dv"): RotationState {
	const accounts: Record<string, RotationAccountState> = {};
	for (const n of names) accounts[n] = makeAccountState();
	return { globalPauseUntil: 0, current, accounts };
}

// ── markSuccess ───────────────────────────────────────────────────────────────

describe("markSuccess", () => {
	it("increments counters and sets current", () => {
		const state = makeState();
		markSuccess(state, "dv", T0);
		assert.equal(state.accounts.dv.requestsToday, 1);
		assert.equal(state.accounts.dv.requestsSinceRotation, 1);
		assert.equal(state.accounts.dv.lastUsedMs, T0);
		assert.equal(state.accounts.dv.status, "AVAILABLE");
		assert.equal(state.current, "dv");
	});

	it("clears lastError on success", () => {
		const state = makeState();
		state.accounts.dv.lastError = "previous error";
		markSuccess(state, "dv", T0);
		assert.equal(state.accounts.dv.lastError, null);
	});

	it("is a no-op for unknown account name", () => {
		const state = makeState();
		markSuccess(state, "unknown", T0); // must not throw
		assert.equal(state.current, "dv"); // unchanged
	});
});

// ── markExhausted ─────────────────────────────────────────────────────────────

describe("markExhausted", () => {
	it("sets EXHAUSTED status and correct cooldownUntil", () => {
		const state = makeState();
		markExhausted(state, "dv", 120, T0); // 120s cooldown
		assert.equal(state.accounts.dv.status, "EXHAUSTED");
		assert.equal(state.accounts.dv.cooldownUntil, T0 + 120 * 1000);
		assert.equal(state.accounts.dv.lastUsedMs, T0);
	});

	it("sets lastError string", () => {
		const state = makeState();
		markExhausted(state, "dv", 60, T0);
		assert.ok(state.accounts.dv.lastError?.includes("quota exhausted"));
	});

	it("is a no-op for unknown account", () => {
		const state = makeState();
		markExhausted(state, "unknown", 60, T0); // must not throw
	});
});

// ── markFlagged ───────────────────────────────────────────────────────────────

describe("markFlagged", () => {
	it("sets FLAGGED status and global protective pause", () => {
		const state = makeState();
		markFlagged(state, "dv", 6, T0); // 6h pause
		assert.equal(state.accounts.dv.status, "FLAGGED");
		assert.equal(state.globalPauseUntil, T0 + 6 * 3_600_000);
	});

	it("sets lastError string mentioning ban", () => {
		const state = makeState();
		markFlagged(state, "dv", 6, T0);
		assert.ok(state.accounts.dv.lastError?.includes("ToS ban"));
	});
});

// ── refreshAccountState ───────────────────────────────────────────────────────

describe("refreshAccountState", () => {
	it("restores EXHAUSTED → AVAILABLE after cooldown expires", () => {
		const acct = makeAccountState({ status: "EXHAUSTED", cooldownUntil: T0 + 5000 });
		refreshAccountState(acct, T0 + 6000); // after cooldown
		assert.equal(acct.status, "AVAILABLE");
	});

	it("keeps EXHAUSTED when cooldown has NOT expired", () => {
		const acct = makeAccountState({ status: "EXHAUSTED", cooldownUntil: T0 + 60_000 });
		refreshAccountState(acct, T0 + 1000); // still cooling
		assert.equal(acct.status, "EXHAUSTED");
	});

	it("resets requestsToday on day rollover", () => {
		const yesterday = todayStamp(T0 - 86_400_000);
		const acct = makeAccountState({ requestsToday: 50, dayStamp: yesterday });
		refreshAccountState(acct, T0);
		assert.equal(acct.requestsToday, 0);
		assert.equal(acct.dayStamp, todayStamp(T0));
	});

	it("does NOT reset requestsToday when dayStamp matches today", () => {
		const acct = makeAccountState({ requestsToday: 50, dayStamp: todayStamp(T0) });
		refreshAccountState(acct, T0);
		assert.equal(acct.requestsToday, 50);
	});

	it("does NOT restore FLAGGED accounts on cooldown expiry", () => {
		const acct = makeAccountState({ status: "FLAGGED", cooldownUntil: T0 - 1000 });
		refreshAccountState(acct, T0);
		assert.equal(acct.status, "FLAGGED"); // FLAGGED is permanent
	});
});

// ── pickNextAccount ───────────────────────────────────────────────────────────

describe("pickNextAccount", () => {
	it("returns current account first (drain strategy)", () => {
		const config = makeConfig(["dv", "jn"]);
		const state = makeState(["dv", "jn"], "dv");
		const result = pickNextAccount(state, config, new Set(), T0);
		assert.equal(result.kind, "ok");
		if (result.kind === "ok") assert.equal(result.account.name, "dv");
	});

	it("advances to next config entry when current is EXHAUSTED", () => {
		const config = makeConfig(["dv", "jn"]);
		const state = makeState(["dv", "jn"], "dv");
		// Mark dv exhausted
		state.accounts.dv.status = "EXHAUSTED";
		state.accounts.dv.cooldownUntil = T0 + 60_000;
		const result = pickNextAccount(state, config, new Set(), T0);
		assert.equal(result.kind, "ok");
		if (result.kind === "ok") assert.equal(result.account.name, "jn");
	});

	it("skips FLAGGED accounts entirely", () => {
		const config = makeConfig(["dv", "jn", "extra"]);
		const state = makeState(["dv", "jn", "extra"], "dv");
		state.accounts.dv.status = "FLAGGED";
		state.accounts.jn.status = "FLAGGED";
		const result = pickNextAccount(state, config, new Set(), T0);
		assert.equal(result.kind, "ok");
		if (result.kind === "ok") assert.equal(result.account.name, "extra");
	});

	it("skips accounts in the exclude set (no-hammer guarantee)", () => {
		const config = makeConfig(["dv", "jn"]);
		const state = makeState(["dv", "jn"], "dv");
		const result = pickNextAccount(state, config, new Set(["dv"]), T0);
		assert.equal(result.kind, "ok");
		if (result.kind === "ok") assert.equal(result.account.name, "jn");
	});

	it("returns kind=exhausted when all accounts are EXHAUSTED", () => {
		const config = makeConfig(["dv", "jn"]);
		const state = makeState(["dv", "jn"], "dv");
		state.accounts.dv.status = "EXHAUSTED";
		state.accounts.dv.cooldownUntil = T0 + 30_000;
		state.accounts.jn.status = "EXHAUSTED";
		state.accounts.jn.cooldownUntil = T0 + 60_000;
		const result = pickNextAccount(state, config, new Set(), T0);
		assert.equal(result.kind, "exhausted");
		if (result.kind === "exhausted") {
			// soonestCooldownUntil should be the minimum of both cooldowns
			assert.equal(result.soonestCooldownUntil, T0 + 30_000);
		}
	});

	it("returns kind=exhausted when all accounts are FLAGGED (no cooldown available)", () => {
		const config = makeConfig(["dv", "jn"]);
		const state = makeState(["dv", "jn"], "dv");
		state.accounts.dv.status = "FLAGGED";
		state.accounts.jn.status = "FLAGGED";
		const result = pickNextAccount(state, config, new Set(), T0);
		// FLAGGED accounts provide no cooldown; fallback is now + 60s
		assert.equal(result.kind, "exhausted");
	});

	it("returns kind=paused during global protective pause", () => {
		const config = makeConfig(["dv", "jn"]);
		const state = makeState(["dv", "jn"], "dv");
		state.globalPauseUntil = T0 + 6 * 3_600_000;
		const result = pickNextAccount(state, config, new Set(), T0);
		assert.equal(result.kind, "paused");
		if (result.kind === "paused") assert.equal(result.until, T0 + 6 * 3_600_000);
	});

	it("does NOT pause after global pause has expired", () => {
		const config = makeConfig(["dv", "jn"]);
		const state = makeState(["dv", "jn"], "dv");
		state.globalPauseUntil = T0 - 1; // expired 1ms ago
		const result = pickNextAccount(state, config, new Set(), T0);
		assert.equal(result.kind, "ok");
	});

	it("lazily restores EXHAUSTED → AVAILABLE when cooldown has expired", () => {
		const config = makeConfig(["dv", "jn"]);
		const state = makeState(["dv", "jn"], "dv");
		// Mark dv exhausted with a past cooldown (already expired)
		state.accounts.dv.status = "EXHAUSTED";
		state.accounts.dv.cooldownUntil = T0 - 5000; // expired 5s ago
		// pick with now = T0 (after cooldown) should restore and use dv
		const result = pickNextAccount(state, config, new Set(), T0);
		assert.equal(result.kind, "ok");
		if (result.kind === "ok") assert.equal(result.account.name, "dv");
		assert.equal(state.accounts.dv.status, "AVAILABLE"); // lazily restored
	});

	it("lazily resets requestsToday on day rollover", () => {
		const config = makeConfig(["dv"]);
		const state = makeState(["dv"], "dv");
		const yesterday = todayStamp(T0 - 86_400_000);
		state.accounts.dv.dayStamp = yesterday;
		state.accounts.dv.requestsToday = 88;
		pickNextAccount(state, config, new Set(), T0);
		assert.equal(state.accounts.dv.requestsToday, 0);
	});
});

// ── Integration: full single-account rotation cycle ──────────────────────────

describe("rotation cycle", () => {
	it("drains account A then switches to B on quota, never re-hitting A", () => {
		const config = makeConfig(["dv", "jn"]);
		const state = makeState(["dv", "jn"], "dv");

		// Attempt 1: pick dv (current)
		const pick1 = pickNextAccount(state, config, new Set(), T0);
		assert.equal(pick1.kind, "ok");
		if (pick1.kind !== "ok") return;
		assert.equal(pick1.account.name, "dv");

		// dv gets a quota error → mark exhausted, add to excluded
		markExhausted(state, "dv", 60, T0);
		const excluded = new Set(["dv"]);

		// Attempt 2: dv is excluded + exhausted → should pick jn
		const pick2 = pickNextAccount(state, config, excluded, T0);
		assert.equal(pick2.kind, "ok");
		if (pick2.kind !== "ok") return;
		assert.equal(pick2.account.name, "jn");

		// jn succeeds
		markSuccess(state, "jn", T0 + 1000);
		assert.equal(state.accounts.jn.requestsToday, 1);
		assert.equal(state.current, "jn");
	});

	it("returns exhausted when all accounts used up within one call", () => {
		const config = makeConfig(["dv", "jn"]);
		const state = makeState(["dv", "jn"], "dv");

		// Both 429'd within this call
		markExhausted(state, "dv", 60, T0);
		markExhausted(state, "jn", 60, T0);

		const result = pickNextAccount(state, config, new Set(["dv", "jn"]), T0);
		assert.equal(result.kind, "exhausted");
	});
});

// ── checkPinUsable — pin must respect global pause ─────────────────────────────

describe("checkPinUsable", () => {
	it("blocks pinned call during active global pause", () => {
		const state = makeState(["dv", "jn"], "dv");
		state.globalPauseUntil = T0 + 6 * 3_600_000;
		const err = checkPinUsable(state, "dv", T0);
		assert.ok(err !== null, "should block during global pause");
		assert.ok(err!.includes("paused"), `message should mention 'paused', got: ${err}`);
	});

	it("allows pinned call after global pause expires", () => {
		const state = makeState(["dv", "jn"], "dv");
		state.globalPauseUntil = T0 - 1; // expired 1ms ago
		const err = checkPinUsable(state, "dv", T0);
		assert.equal(err, null);
	});

	it("global pause checked before FLAGGED status (order matters)", () => {
		const state = makeState(["dv", "jn"], "dv");
		state.globalPauseUntil = T0 + 3_600_000;
		state.accounts.dv.status = "FLAGGED";
		const err = checkPinUsable(state, "dv", T0);
		// Should mention 'paused', not 'flagged', because pause is checked first
		assert.ok(err !== null);
		assert.ok(err!.includes("paused"), `should mention pause not flag, got: ${err}`);
	});

	it("blocks FLAGGED account (no global pause)", () => {
		const state = makeState(["dv", "jn"], "dv");
		state.accounts.dv.status = "FLAGGED";
		const err = checkPinUsable(state, "dv", T0);
		assert.ok(err !== null);
		assert.ok(err!.toLowerCase().includes("flagged"));
	});

	it("blocks EXHAUSTED account in cooldown (no global pause)", () => {
		const state = makeState(["dv", "jn"], "dv");
		state.accounts.dv.status = "EXHAUSTED";
		state.accounts.dv.cooldownUntil = T0 + 60_000;
		const err = checkPinUsable(state, "dv", T0);
		assert.ok(err !== null);
		assert.ok(err!.includes("cooldown"));
	});

	it("allows EXHAUSTED account after its cooldown expires (no global pause)", () => {
		const state = makeState(["dv", "jn"], "dv");
		state.accounts.dv.status = "EXHAUSTED";
		state.accounts.dv.cooldownUntil = T0 - 1; // just expired
		const err = checkPinUsable(state, "dv", T0);
		assert.equal(err, null);
	});
});

// ── buildTryOrder wrap-around — current=middle → next is right-of-middle ────────

describe("buildTryOrder wrap-around", () => {
	it("[dv,jn,extra] current=jn: after jn exhausted, picks extra before dv", () => {
		const config = makeConfig(["dv", "jn", "extra"]);
		const state = makeState(["dv", "jn", "extra"], "jn");
		// jn (current, index 1) is exhausted
		state.accounts.jn.status = "EXHAUSTED";
		state.accounts.jn.cooldownUntil = T0 + 60_000;
		// With wrap-around from idx 1: next offset is (1+1)%3=2 = extra, then (1+2)%3=0 = dv
		const result = pickNextAccount(state, config, new Set(), T0);
		assert.equal(result.kind, "ok");
		if (result.kind === "ok") {
			assert.equal(
				result.account.name,
				"extra",
				"wrap-around: extra (idx 2) should come before dv (idx 0)",
			);
		}
	});

	it("[dv,jn,extra] current=jn, extra also excluded: picks dv (full wrap)", () => {
		const config = makeConfig(["dv", "jn", "extra"]);
		const state = makeState(["dv", "jn", "extra"], "jn");
		state.accounts.jn.status = "EXHAUSTED";
		state.accounts.jn.cooldownUntil = T0 + 60_000;
		// exclude extra too → only dv should remain
		const result = pickNextAccount(state, config, new Set(["extra"]), T0);
		assert.equal(result.kind, "ok");
		if (result.kind === "ok") {
			assert.equal(result.account.name, "dv", "full wrap: dv comes after extra");
		}
	});

	it("[dv,jn,extra] current=extra (last): wraps to dv first", () => {
		const config = makeConfig(["dv", "jn", "extra"]);
		const state = makeState(["dv", "jn", "extra"], "extra");
		state.accounts.extra.status = "EXHAUSTED";
		state.accounts.extra.cooldownUntil = T0 + 60_000;
		// current=extra (idx 2), exhausted. Next offset: (2+1)%3=0 = dv
		const result = pickNextAccount(state, config, new Set(), T0);
		assert.equal(result.kind, "ok");
		if (result.kind === "ok") {
			assert.equal(result.account.name, "dv", "wraps from last to first");
		}
	});
});

// ── classifyLogContent — fixture-based log classification tests ────────────────
// These tests use SYNTHETIC log strings to verify the classification logic
// without requiring a real agy binary or quota errors.
//
// ⚠ The 'banned' path is PROVISIONAL — unverified against a real 403 log.
// These tests lock the current regex behavior; update them when Spike S0
// (real 403 log capture) is completed.

describe("classifyLogContent — log classification fixtures", () => {
	it("RESOURCE_EXHAUSTED-only → 'quota'", () => {
		const log = "RESOURCE_EXHAUSTED: some model: Individual quota reached.";
		assert.equal(classifyLogContent(log, false), "quota");
	});

	it("Individual quota reached pattern → 'quota'", () => {
		const log = "Individual quota reached. Please wait 60s.";
		assert.equal(classifyLogContent(log, false), "quota");
	});

	it("PERMISSION_DENIED-only → 'banned'", () => {
		const log = "PERMISSION_DENIED: This API endpoint is not available.";
		assert.equal(classifyLogContent(log, false), "banned");
	});

	it("both RESOURCE_EXHAUSTED and PERMISSION_DENIED → 'quota' (safe ambiguity policy)", () => {
		// When both appear, prefer 'quota' (rotate+cooldown) over 'banned' (6h pause).
		// Wrong toward quota is safe; wrong toward banned is costly.
		const log = "RESOURCE_EXHAUSTED: quota exceeded\nPERMISSION_DENIED: also flagged";
		assert.equal(classifyLogContent(log, false), "quota");
	});

	it("neither quota nor ban + nonzero exit → 'error'", () => {
		const log = "Some other error occurred during execution";
		assert.equal(classifyLogContent(log, true), "error");
	});

	it("neither quota nor ban + zero exit → 'ok'", () => {
		const log = "Normal operation completed successfully";
		assert.equal(classifyLogContent(log, false), "ok");
	});

	it("Terms of Service pattern → 'banned'", () => {
		const log = "Error: Terms of Service violation detected";
		assert.equal(classifyLogContent(log, false), "banned");
	});
});

// ── loadRotationConfigFrom — duplicate detection + numeric validation ───────────

describe("loadRotationConfigFrom — config validation", () => {
	function writeTmp(name: string, content: string): string {
		const p = path.join(os.tmpdir(), `pi-agy-test-${name}-${process.pid}.json`);
		fs.writeFileSync(p, content, "utf-8");
		return p;
	}
	function cleanup(p: string): void {
		try {
			fs.unlinkSync(p);
		} catch {
			/* ignore */
		}
	}

	it("absent file → null (silent)", () => {
		const result = loadRotationConfigFrom("/tmp/__nonexistent_pi_agy_config_xyz__.json");
		assert.equal(result, null);
	});

	it("valid 2-account config → returns config", () => {
		const p = writeTmp("valid", JSON.stringify({
			accounts: [
				{ name: "dv", home: "/home/jet/.ag-acp/accounts/dv" },
				{ name: "jn", home: "/home/jet/.ag-acp/accounts/jn" },
			],
			dbusAddress: "unix:path=/tmp/fake",
		}));
		try {
			const cfg = loadRotationConfigFrom(p);
			assert.ok(cfg !== null, "should parse successfully");
			assert.equal(cfg!.accounts.length, 2);
			assert.equal(cfg!.accounts[0].name, "dv");
			assert.equal(cfg!.defaultCooldownSec, 60); // default
		} finally {
			cleanup(p);
		}
	});

	it("duplicate account name → null", () => {
		const p = writeTmp("dup-name", JSON.stringify({
			accounts: [
				{ name: "dv", home: "/tmp/pi-agy-test-acct-a" },
				{ name: "dv", home: "/tmp/pi-agy-test-acct-b" },
			],
		}));
		try {
			const cfg = loadRotationConfigFrom(p);
			assert.equal(cfg, null, "duplicate name should invalidate config");
		} finally {
			cleanup(p);
		}
	});

	it("duplicate home path (same resolved path) → null", () => {
		// Use /tmp twice (always exists, resolves to same canonical path)
		const p = writeTmp("dup-home", JSON.stringify({
			accounts: [
				{ name: "acct-a", home: "/tmp" },
				{ name: "acct-b", home: "/tmp" },
			],
		}));
		try {
			const cfg = loadRotationConfigFrom(p);
			assert.equal(cfg, null, "duplicate home should invalidate config");
		} finally {
			cleanup(p);
		}
	});

	it("NaN defaultCooldownSec → falls back to 60", () => {
		const p = writeTmp("nan-cooldown", JSON.stringify({
			accounts: [{ name: "dv", home: "/tmp/pi-agy-test-dv" }],
			defaultCooldownSec: Number.NaN,
		}));
		try {
			const cfg = loadRotationConfigFrom(p);
			assert.ok(cfg !== null, "bad optional number should not kill config");
			assert.equal(cfg!.defaultCooldownSec, 60, "NaN should fall back to 60");
		} finally {
			cleanup(p);
		}
	});

	it("negative protectivePauseHours → falls back to 6", () => {
		const p = writeTmp("neg-pause", JSON.stringify({
			accounts: [{ name: "dv", home: "/tmp/pi-agy-test-dv" }],
			protectivePauseHours: -1,
		}));
		try {
			const cfg = loadRotationConfigFrom(p);
			assert.ok(cfg !== null);
			assert.equal(cfg!.protectivePauseHours, 6);
		} finally {
			cleanup(p);
		}
	});

	it("inverted jitterMs [1200, 400] → falls back to [400, 1200]", () => {
		const p = writeTmp("bad-jitter", JSON.stringify({
			accounts: [{ name: "dv", home: "/tmp/pi-agy-test-dv" }],
			jitterMs: [1200, 400],
		}));
		try {
			const cfg = loadRotationConfigFrom(p);
			assert.ok(cfg !== null);
			assert.deepEqual(cfg!.jitterMs, [400, 1200], "inverted range should fall back to default");
		} finally {
			cleanup(p);
		}
	});

	it("zero-max jitterMs [0, 0] → falls back to [400, 1200]", () => {
		const p = writeTmp("zero-jitter", JSON.stringify({
			accounts: [{ name: "dv", home: "/tmp/pi-agy-test-dv" }],
			jitterMs: [0, 0],
		}));
		try {
			const cfg = loadRotationConfigFrom(p);
			assert.ok(cfg !== null);
			assert.deepEqual(cfg!.jitterMs, [400, 1200], "zero-max jitter should fall back to default");
		} finally {
			cleanup(p);
		}
	});

	it("invalid account name (not alphanumeric/hyphen/underscore) → null", () => {
		const p = writeTmp("bad-name", JSON.stringify({
			accounts: [{ name: "bad name!", home: "/tmp/pi-agy-test" }],
		}));
		try {
			const cfg = loadRotationConfigFrom(p);
			assert.equal(cfg, null);
		} finally {
			cleanup(p);
		}
	});

	it("non-absolute home path → null", () => {
		const p = writeTmp("rel-home", JSON.stringify({
			accounts: [{ name: "dv", home: "relative/path" }],
		}));
		try {
			const cfg = loadRotationConfigFrom(p);
			assert.equal(cfg, null);
		} finally {
			cleanup(p);
		}
	});
});

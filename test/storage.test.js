"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { ReviewStorage, comparisonKey, importLegacy, reviewDatabase } = require("../src/storage");
const { git } = require("../src/git");
const versions = require("../src/versions");

function setup(t) {
    const parent = fs.realpathSync.native(os.tmpdir());
    const root = fs.mkdtempSync(path.join(parent, "pr-review-test-"));
    const database = path.join(root, "reviews.sqlite");
    const stores = [];
    const open = (filename = database, workspace = root) => {
        const store = new ReviewStorage([workspace], filename);
        stores.push(store);
        return store;
    };
    t.after(() => {
        for (const store of stores) store.dispose();
        assert.equal(path.dirname(root), parent);
        assert.match(path.basename(root), /^pr-review-test-/);
        fs.rmSync(root, { recursive: true, force: true });
    });
    return { root, qoder: open(), code: open(database, path.join(root, ".")), database, open };
}

function version(number, headTree, opinions = []) {
    return { number, range: { base: "base", head: headTree, headTree }, read: {}, clarifications: {},
        opinions, summaries: {} };
}

test("imports the reviewed timeline over an empty comparison from another IDE", async t => {
    const { qoder, code } = setup(t);
    const note = { id: "comment", revision: "edit", replies: [{ requestId: "job", revision: "edit", text: "reply" }] };
    const legacy = { versions: [version("v0001", "first"), version("v0002", "second", [note])],
        receipts: { job: { version: "v0002", status: "completed" } } };
    await code.change("pair", () => ({ data: { versions: [version("v0001", "second")] } }));
    const state = await qoder.change("pair", current => ({ data: importLegacy(current, legacy) }));
    assert.deepEqual(state.data.versions, legacy.versions);
    assert.deepEqual(code.read("pair").data.versions[1].opinions, [note]);
    assert.equal(code.read("pair").data.receipts.job.version, "v0002");
    const repeated = await code.change("pair", current => ({ data: importLegacy(current, legacy) }));
    assert.equal(repeated.revision, state.revision);
});

test("merges reviews, summaries and line clarifications for the same snapshot", async t => {
    const { qoder, code } = setup(t);
    const a = version("v0001", "same", [{ id: "q", revision: "r", replies: [] }]);
    a.clarifications.f = { digest: "d", points: [{ side: "new", start: 1, end: 2, text: "one" }] };
    const b = version("v0001", "same", [{ id: "v", revision: "s", replies: [] }]);
    b.clarifications.f = { digest: "d", points: [{ side: "new", start: 3, end: 4, text: "two" }] };
    b.summaries.f = { digest: "d", sentences: ["purpose"] };
    await qoder.change("pair", () => ({ data: { versions: [a] } }));
    await code.change("pair", current => ({ data: importLegacy(current, { versions: [b] }) }));
    const result = qoder.read("pair").data.versions[0];
    assert.deepEqual(result.opinions.map(note => note.id), ["q", "v"]);
    assert.equal(result.clarifications.f.points.length, 2);
    assert.deepEqual(result.summaries.f, b.summaries.f);
});

test("merges read markers without making an unrelated opened diff the latest version", () => {
    const reviewed = version("v0001", "reviewed", [{ id: "q", revision: "r", replies: [] }]);
    const opened = version("v0001", "other");
    opened.read.other = true;
    const matching = version("v0002", "reviewed");
    matching.read.same = true;
    const result = importLegacy({ versions: [reviewed] }, { versions: [opened, matching] });
    assert.deepEqual(result.versions.map(item => item.number), ["v0001"]);
    assert.deepEqual(result.versions[0].read, { same: true });
});

test("retries a stale write and keeps both IDEs' updates", async t => {
    const { root, qoder, code, database } = setup(t);
    await qoder.change("pair", () => ({ data: { notes: [] } }));
    let unblock;
    const blocked = new Promise(resolve => { unblock = resolve; });
    const slower = qoder.change("pair", async current => {
        await blocked;
        current.notes.push("Qoder");
        return { data: current };
    });
    await code.change("pair", current => {
        current.notes.push("VS Code");
        return { data: current };
    });
    unblock();
    await slower;
    assert.deepEqual(code.read("pair").data.notes, ["VS Code", "Qoder"]);
    const other = new ReviewStorage([path.join(root, "other-workspace")], database);
    try {
        assert.deepEqual(other.read("pair"), { data: undefined, revision: 0 });
    } finally {
        other.dispose();
    }
});

test("shares snapshots from Git metadata even with a long checkout path", async t => {
    const { root: workspace, open } = setup(t);
    const root = path.join(workspace, "workspace-with-a-long-folder-name", "review-repository");
    fs.mkdirSync(root, { recursive: true });
    await git(root, ["init", "-b", "main"]);
    const filename = await reviewDatabase(root);
    assert.equal(filename, path.join(root, ".git", "workspace-pr-review.sqlite"));
    const qoder = open(filename);
    const code = open(filename);
    await git(root, ["config", "user.name", "Review Test"]);
    await git(root, ["config", "user.email", "review-test@example.invalid"]);
    const file = path.join(root, "train.py");
    fs.writeFileSync(file, "baseline\n");
    await git(root, ["add", "train.py"]);
    await git(root, ["commit", "-m", "baseline"]);
    await git(root, ["checkout", "-b", "feature"]);
    fs.writeFileSync(file, "baseline\nfeature\n");
    await git(root, ["add", "train.py"]);
    await git(root, ["commit", "-m", "feature"]);
    const target = "refs/heads/main";
    const source = "refs/heads/feature";
    const key = comparisonKey(root, target, source);
    await qoder.change(key, async () => {
        const data = { versions: [] };
        const { version, snapshot } = await versions.refresh(root, target, source, data);
        version.opinions.push({ id: "qoder", revision: "r1", path: "train.py", fileId: snapshot.files[0].id,
            side: "new", start: 2, end: 2, digest: snapshot.files[0].digest, text: "review note", replies: [] });
        return { data };
    });
    assert.equal(code.read(key).data.versions[0].opinions[0].text, "review note");
    fs.appendFileSync(file, "local edit\n");
    await code.change(key, async data => ({ data, result: await versions.refresh(root, target, source, data) }));
    const history = qoder.read(key).data.versions;
    assert.deepEqual(history.map(item => item.number), ["v0001", "v0002"]);
    assert.equal(history[1].opinions[0].text, "review note");
    assert.equal(history[1].range.working, true);
    assert.match(await git(root, ["status", "--porcelain", "-uall"]), /^ M train\.py\r?\n$/);
    const { base, head } = history[1].range;
    for (const commit of [base, head]) {
        const pin = await git(root, ["rev-parse", "refs/workspace-pr-review/objects/" + commit]);
        assert.equal(pin.trim(), commit);
    }
});

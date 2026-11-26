"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { branches, git, resolve, updateUpstream } = require("../src/git");

async function commit(repository, file, text) {
    await fs.writeFile(path.join(repository, file), text);
    await git(repository, ["add", "--", file]);
    await git(repository, ["-c", "user.name=Review Test", "-c", "user.email=review-test@example.invalid",
        "commit", "-m", "Update " + file]);
    return resolve(repository, "HEAD");
}

test("fetches the upstream default branch up to the last clean commit without touching the source", async t => {
    const temp = await fs.realpath(os.tmpdir());
    const sandbox = await fs.mkdtemp(path.join(temp, "review-upstream-test-"));
    t.after(async () => {
        assert.equal(path.dirname(sandbox), temp);
        assert.match(path.basename(sandbox), /^review-upstream-test-/);
        await fs.rm(sandbox, { recursive: true, force: true });
    });
    const remote = path.join(sandbox, "remote");
    const repository = path.join(sandbox, "checkout");
    await fs.mkdir(remote);
    await git(remote, ["init", "-b", "trunk"]);
    const base = await commit(remote, "shared.txt", "original\n");
    await git(sandbox, ["clone", "--origin", "upstream", remote, repository]);
    await git(repository, ["update-ref", "refs/remotes/origin/main", base]);
    const initial = await branches(repository);
    assert.equal(initial.hasUpstream, true);
    assert.deepEqual(initial.defaultTargets, ["refs/remotes/upstream/trunk", "refs/remotes/origin/main"]);
    await git(repository, ["update-ref", "-d", "refs/remotes/upstream/trunk"]);
    assert.deepEqual((await branches(repository)).defaultTargets, ["refs/remotes/origin/main"]);

    await git(repository, ["switch", "-c", "feature"]);
    const source = "refs/heads/feature";
    const sourceHead = await commit(repository, "shared.txt", "source change\n");
    await fs.writeFile(path.join(repository, "staged.txt"), "staged work\n");
    await git(repository, ["add", "--", "staged.txt"]);
    await fs.writeFile(path.join(repository, "untracked.txt"), "untracked work\n");
    const status = await git(repository, ["status", "--porcelain=v1"]);
    const staged = await git(repository, ["diff", "--cached"]);

    const clean = await commit(remote, "clean.txt", "upstream change\n");
    const conflict = await commit(remote, "shared.txt", "upstream conflict\n");
    const tip = await commit(remote, "later.txt", "another change\n");
    const stopped = await updateUpstream(repository, source);
    assert.deepEqual(stopped, {
        target: "refs/remotes/upstream/trunk", commit: clean, tip, blocked: { commit: conflict, files: ["shared.txt"] },
    });
    assert.equal(await resolve(repository, "upstream/trunk"), clean);
    assert.equal(await resolve(repository, "upstream/HEAD"), clean);
    assert.equal(await resolve(repository, "HEAD"), sourceHead);
    assert.equal(await git(repository, ["status", "--porcelain=v1"]), status);
    assert.equal(await git(repository, ["diff", "--cached"]), staged);
    assert.equal(await fs.readFile(path.join(repository, "untracked.txt"), "utf8"), "untracked work\n");
    assert.equal(await git(repository, ["for-each-ref", "refs/workspace-pr-review/fetch"]), "");

    const resolved = await commit(remote, "shared.txt", "original\n");
    const advanced = await updateUpstream(repository, source);
    assert.equal(advanced.commit, resolved);
    assert.equal(advanced.blocked, undefined);
    assert.equal(await resolve(repository, "upstream/trunk"), resolved);
    assert.equal(await resolve(repository, "HEAD"), sourceHead);
    assert.equal(await git(repository, ["status", "--porcelain=v1"]), status);
    await assert.rejects(updateUpstream(repository, "refs/remotes/upstream/trunk"), /选择其他来源分支/);
});

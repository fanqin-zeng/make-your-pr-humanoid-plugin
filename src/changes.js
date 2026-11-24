"use strict";

const { git } = require("./git");

function automation(value) {
    const push = value?.push === true;
    const commit = push || value?.commit === true;
    return { edit: commit || value?.edit === true, commit, push };
}

async function assertHead(repository, source, head) {
    const [active, current] = await Promise.all([
        git(repository, ["symbolic-ref", "--quiet", "HEAD"]).catch(() => ""),
        git(repository, ["rev-parse", "--verify", "HEAD"]),
    ]);
    if (!source.startsWith("refs/heads/") || active.trim() !== source) {
        throw new Error("自动修改需要在所选来源分支的本地工作树中运行。");
    }
    if (current.trim() !== head) throw new Error("来源分支已前进，请刷新比较后再运行。");
}

async function pushDestination(repository, source) {
    const fields = await git(repository, ["for-each-ref", "--format=%(refname)%00%(push:remotename)%00%(push:remoteref)%00%(upstream:remotename)%00%(upstream:remoteref)", source]);
    const line = fields.split(/\r?\n/).map(row => row.split("\0")).find(row => row[0] === source);
    const [, preferred, preferredRef, upstream, upstreamRef] = line || [];
    const remote = preferred || upstream;
    const ref = preferredRef || (remote === upstream ? upstreamRef : "") || source;
    const remotes = (await git(repository, ["remote"])).trim().split(/\r?\n/);
    if (!remote || remote.startsWith("-") || !remotes.includes(remote) || !ref.startsWith("refs/heads/")) {
        throw new Error("当前来源分支没有可确认的 Git 推送目标。");
    }
    return { remote, ref };
}

module.exports = { automation, assertHead, pushDestination };

"use strict";

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { git, resolve, compare, comparison, renamedPaths, digest } = require("./git");

function number(index) {
    return "v" + String(index + 1).padStart(4, "0");
}

async function workingTree(repository, source, head, knownPaths) {
    const [tree, active] = await Promise.all([
        resolve(repository, head, "tree"), git(repository, ["symbolic-ref", "--quiet", "HEAD"]).catch(() => ""),
    ]);
    if (source !== active.trim()) return tree;
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-review-version-"));
    const index = path.join(directory, "index");
    const isolated = { env: { GIT_INDEX_FILE: index } };
    try {
        const additions = await git(repository, ["diff", "--cached", "--name-only", "--diff-filter=A", "-z", head, "--"]);
        await git(repository, ["read-tree", head], isolated);
        await git(repository, ["add", "-u", "--", ":/"], isolated);
        const extra = new Set([...additions.split("\0").filter(Boolean), ...knownPaths]);
        for (const name of extra) {
            const file = await fs.lstat(path.join(repository, name)).catch(error => {
                if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
                throw error;
            });
            if (file?.isFile() || file?.isSymbolicLink()) {
                await git(repository, ["add", "--", ":(literal)" + name], isolated);
            }
        }
        const captured = (await git(repository, ["write-tree"], isolated)).trim();
        if (head !== await resolve(repository, source)) throw new Error("快照生成时来源分支发生变化，请刷新比较。");
        return captured;
    } finally {
        await fs.unlink(index).catch(() => {});
        await fs.rmdir(directory).catch(() => {});
    }
}

function addedFiles(snapshot, list) {
    for (const name of list || []) {
        if (snapshot.files.some(file => file.path === name)) continue;
        snapshot.files.push({ id: digest(name).slice(0, 24), path: name, oldPath: null, status: "U",
            patch: "", rows: [], digest: digest("") });
    }
    return snapshot;
}

async function load(repository, target, source, version) {
    return addedFiles(await comparison(repository, target, source, version.range), version.extraFiles);
}

async function blobId(repository, object, file) {
    if (!file) return null;
    const entry = await git(repository, ["ls-tree", "-z", object, "--", ":(literal)" + file]);
    return entry.match(/^\d{6} blob ([a-f0-9]+)\t/)?.[1] || null;
}

function shiftRange(diff, start, end) {
    let shift = 0;
    let hasHunk = false;
    for (const hunk of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@/gm)) {
        hasHunk = true;
        const position = Number(hunk[1]);
        const removed = Number(hunk[2] ?? 1);
        const added = Number(hunk[3] ?? 1);
        if (removed) {
            if (position + removed - 1 < start) shift += added - removed;
            else if (position <= end) return null;
        } else if (position < start) shift += added;
        else if (position < end) return null;
    }
    return hasHunk ? { start: start + shift, end: end + shift } : null;
}

function sidePath(file, side) {
    return side === "old" ? file.oldPath || file.path : file.path;
}

async function carry(repository, before, after, prior) {
    const opinions = [];
    const extraFiles = [];
    const renames = new Map();
    const blobs = new Map();
    const edits = new Map();
    function once(cache, key, action) {
        if (!cache.has(key)) cache.set(key, action());
        return cache.get(key);
    }

    for (const opinion of prior.opinions) {
        const file = before.files.find(item => item.id === opinion.fileId);
        if (!file || opinion.digest !== file.digest) continue;
        const { side } = opinion;
        const left = side === "old" ? before.base : before.head;
        const right = side === "old" ? after.base : after.head;
        const previousPath = sidePath(file, side);
        const renamed = await once(renames, side, () => renamedPaths(repository, left, right));
        const nextPath = renamed.get(previousPath) || previousPath;
        const [oldId, newId] = await Promise.all([
            once(blobs, left + "\0" + previousPath, () => blobId(repository, left, previousPath)),
            once(blobs, right + "\0" + nextPath, () => blobId(repository, right, nextPath)),
        ]);
        if (!oldId || !newId) continue;
        let range = { start: opinion.start, end: opinion.end };
        if (oldId !== newId) {
            const diff = await once(edits, oldId + "\0" + newId, () =>
                git(repository, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "-U0", oldId, newId, "--"]));
            range = shiftRange(diff, opinion.start, opinion.end);
        }
        if (!range) continue;
        let current = after.files.find(item => sidePath(item, side) === nextPath);
        if (!current) {
            extraFiles.push(nextPath);
            addedFiles(after, [nextPath]);
            current = after.files.at(-1);
        }
        opinions.push({ ...structuredClone(opinion), ...range, fileId: current.id, path: current.path, digest: current.digest });
    }
    const kept = new Map(after.files.map(file => [file.id, file.digest]));
    return {
        opinions, extraFiles,
        read: Object.fromEntries(Object.entries(prior.read).filter(([id]) => kept.has(id))),
        clarifications: Object.fromEntries(Object.entries(prior.clarifications).filter(([id, value]) => kept.get(id) === value.digest)),
        summaries: Object.fromEntries(Object.entries(prior.summaries || {}).filter(([id, value]) => kept.get(id) === value.digest)),
    };
}

async function pin(repository, range) {
    for (const commit of new Set([range.head, range.base])) {
        await git(repository, ["update-ref", "refs/workspace-pr-review/objects/" + commit, commit]);
    }
}

async function currentRange(repository, target, source, stored) {
    const [targetCommit, sourceCommit] = await Promise.all([resolve(repository, target), resolve(repository, source)]);
    const base = (await git(repository, ["merge-base", targetCommit, sourceCommit]).catch(() => "")).trim();
    if (!base) throw new Error("所选分支没有共同祖先，无法生成评阅 diff。");
    const delivery = stored.delivery;
    const legacyPaths = delivery && !delivery.commit && delivery.head === sourceCommit ? delivery.paths : [];
    const knownPaths = [...new Set([...legacyPaths, ...(stored.workingPaths || [])])];
    const headTree = await workingTree(repository, source, sourceCommit, knownPaths);
    const committedTree = await resolve(repository, sourceCommit, "tree");
    return {
        targetCommit, base, head: headTree, headTree, sourceCommit,
        working: headTree !== committedTree,
    };
}

async function refresh(repository, target, source, stored) {
    if (!stored.versions) {
        stored.versions = [];
        if (Object.keys(stored.read || {}).length || Object.keys(stored.clarifications || {}).length || stored.opinions?.length) {
            const previous = await compare(repository, target, source);
            const label = number(0);
            const range = {
                targetCommit: previous.targetCommit, base: previous.base, head: previous.head,
                headTree: await resolve(repository, previous.head, "tree"), sourceCommit: previous.head, working: false, legacy: true,
            };
            await pin(repository, range);
            stored.versions.push({
                number: label, range, at: new Date().toISOString(),
                read: stored.read || {}, clarifications: stored.clarifications || {}, opinions: stored.opinions || [],
            });
        }
        delete stored.read;
        delete stored.clarifications;
        delete stored.opinions;
    }

    const range = await currentRange(repository, target, source, stored);
    const { base, headTree, sourceCommit, targetCommit } = range;
    const previous = stored.versions.at(-1);
    if (previous && previous.range.base === range.base && previous.range.headTree === headTree) {
        previous.range.sourceCommit = sourceCommit;
        previous.range.targetCommit = targetCommit;
        previous.range.working = range.working;
        return { version: previous, snapshot: await load(repository, target, source, previous) };
    }

    const snapshot = await comparison(repository, target, source, range);
    const annotations = previous ? await carry(repository, await load(repository, target, source, previous), snapshot, previous)
        : { read: {}, clarifications: {}, summaries: {}, opinions: [], extraFiles: [] };
    const restored = stored.versions.slice(0, -1).reverse().find(item =>
        item.range.base === base && item.range.headTree === headTree);
    if (restored) {
        const exact = await carry(repository, await load(repository, target, source, restored), snapshot, restored);
        const currentIds = new Set(annotations.opinions.map(note => note.id));
        for (const note of exact.opinions) {
            if (!currentIds.has(note.id)) {
                delete note.editRevision;
                annotations.opinions.push(note);
            }
        }
        annotations.extraFiles = [...new Set([...annotations.extraFiles, ...exact.extraFiles])];
        annotations.clarifications = { ...exact.clarifications, ...annotations.clarifications };
        annotations.summaries = { ...exact.summaries, ...annotations.summaries };
    }
    const label = number(stored.versions.length);
    const version = { number: label, range, at: new Date().toISOString(), ...annotations };
    await pin(repository, range);
    stored.versions.push(version);
    return { version, snapshot };
}

module.exports = { refresh, load, shiftRange, blobId, currentRange };

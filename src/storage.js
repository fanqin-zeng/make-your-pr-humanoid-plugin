"use strict";

const { isDeepStrictEqual } = require("node:util");
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");
const { digest, git } = require("./git");
const { mergePoints } = require("./clarifications");

function canonical(value) {
    const normalized = path.resolve(value);
    try {
        return fs.realpathSync.native(normalized);
    } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
        return normalized;
    }
}

function pathKey(value) {
    const resolved = canonical(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function comparisonKey(repository, target, source) {
    return digest([pathKey(repository), target, source].join("\0"));
}

async function reviewDatabase(repository) {
    const directory = (await git(repository, ["rev-parse", "--absolute-git-dir"])).trim();
    return path.join(directory, "workspace-pr-review.sqlite");
}

function snapshotKey(range) {
    return [range.targetCommit, range.sourceCommit, range.base, range.headTree || range.head].join("\0");
}

function hasReviewContent(version) {
    return Boolean(version.opinions?.length || Object.keys(version.clarifications || {}).length
        || Object.keys(version.summaries || {}).length);
}

function hasAnnotations(version) {
    return hasReviewContent(version) || Object.keys(version.read || {}).length > 0;
}

function mergeVersion(existing, incoming) {
    existing.read = { ...incoming.read, ...existing.read };
    existing.summaries = { ...incoming.summaries, ...existing.summaries };
    if (incoming.extraFiles?.length) {
        existing.extraFiles = [...new Set([...(existing.extraFiles || []), ...incoming.extraFiles])];
    }
    existing.clarifications ||= {};
    for (const [id, clarification] of Object.entries(incoming.clarifications || {})) {
        const stored = existing.clarifications[id];
        if (!stored) existing.clarifications[id] = clarification;
        else if (stored.digest === clarification.digest) {
            stored.points = mergePoints(stored.points, clarification.points);
        }
    }
    existing.opinions ||= [];
    for (const opinion of incoming.opinions || []) {
        const same = existing.opinions.find(item => item.id === opinion.id && item.revision === opinion.revision);
        if (!same) {
            const conflict = existing.opinions.some(item => item.id === opinion.id);
            const id = conflict ? digest(opinion.id + "\0" + opinion.revision) : opinion.id;
            if (!existing.opinions.some(item => item.id === id)) existing.opinions.push({ ...opinion, id });
            continue;
        }
        const replies = new Map([...(opinion.replies || []), ...(same.replies || [])]
            .map(reply => [reply.requestId + "\0" + reply.revision, reply]));
        same.replies = [...replies.values()].sort((a, b) => (a.at || "").localeCompare(b.at || ""));
        if (opinion.editRevision === same.revision) same.editRevision = same.revision;
    }
}

function importLegacy(current, legacy) {
    if (!legacy || !Object.keys(legacy).length) return current || { versions: [] };
    const fingerprint = digest(JSON.stringify(legacy));
    if (current?.legacyImports?.includes(fingerprint)) return current;
    const incoming = structuredClone(legacy);
    if (!current || (!current.versions?.length && !current.opinions?.length)) {
        return { ...incoming, legacyImports: [...new Set([...(current?.legacyImports || []), fingerprint])] };
    }
    if (!incoming.versions?.length) return current;

    // An IDE that has only opened a diff must not replace the other IDE's review history.
    const takeIncoming = !current.versions?.some(hasReviewContent) && !Object.keys(current.receipts || {}).length
        && (incoming.versions.some(hasAnnotations) || incoming.versions.length > current.versions.length);
    const primary = takeIncoming ? incoming : current;
    const secondary = takeIncoming ? current : incoming;
    const byNumber = new Map();
    const receiptVersions = new Set(Object.values(secondary.receipts || {}).map(receipt => receipt.version));
    for (const version of secondary.versions || []) {
        const identity = snapshotKey(version.range);
        let match = primary.versions.find(item => item.number === version.number && snapshotKey(item.range) === identity)
            || primary.versions.findLast(item => snapshotKey(item.range) === identity);
        if (match) mergeVersion(match, version);
        else if (hasReviewContent(version) || receiptVersions.has(version.number)) {
            match = { ...version, number: "v" + String(primary.versions.length + 1).padStart(4, "0") };
            primary.versions.push(match);
        }
        if (match) byNumber.set(version.number, match.number);
    }
    const receipts = { ...primary.receipts };
    for (const [id, receipt] of Object.entries(secondary.receipts || {})) {
        if (!receipts[id] && byNumber.has(receipt.version)) {
            receipts[id] = { ...receipt, version: byNumber.get(receipt.version) };
        }
    }
    primary.receipts = receipts;
    primary.workingPaths = [...new Set([...(primary.workingPaths || []), ...(secondary.workingPaths || [])])];
    primary.legacyImports = [...new Set([...(current.legacyImports || []), fingerprint])];
    return primary;
}

class ReviewStorage {
    constructor(roots, filename) {
        this.scope = digest(JSON.stringify([...new Set(roots.map(pathKey))].sort()));
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        this.db = new DatabaseSync(filename);
        this.db.exec("PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS reviews (key TEXT PRIMARY KEY, value TEXT NOT NULL, revision INTEGER NOT NULL)");
    }

    read(key) {
        const row = this.db.prepare("SELECT value, revision FROM reviews WHERE key = ?").get(this.scope + ":" + key);
        return row ? { data: JSON.parse(row.value), revision: row.revision } : { data: undefined, revision: 0 };
    }

    revision(key) {
        return this.db.prepare("SELECT revision FROM reviews WHERE key = ?").get(this.scope + ":" + key)?.revision || 0;
    }

    async change(key, transform) {
        const rowKey = this.scope + ":" + key;
        for (let attempt = 0; attempt < 8; attempt++) {
            const { data, revision } = this.read(key);
            const changed = structuredClone(data);
            const { data: next, result } = await transform(changed);
            if (isDeepStrictEqual(next, data) && this.revision(key) === revision) return { data: next, result, revision };
            if (next === undefined) continue;
            const value = JSON.stringify(next);
            const write = revision
                ? this.db.prepare("UPDATE reviews SET value = ?, revision = revision + 1 WHERE key = ? AND revision = ?")
                    .run(value, rowKey, revision)
                : this.db.prepare("INSERT OR IGNORE INTO reviews (key, value, revision) VALUES (?, ?, 1)")
                    .run(rowKey, value);
            if (write.changes) return { data: next, result, revision: revision + 1 };
        }
        throw new Error("评阅记录正在被另一窗口更新，请稍后重试。");
    }

    dispose() { this.db.close(); }
}

module.exports = { ReviewStorage, comparisonKey, importLegacy, reviewDatabase, snapshotKey };

"use strict";

const { execFile } = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");

const exec = promisify(execFile);
const skipped = new Set([
    "node_modules", ".cache", "__pycache__", ".venv", "site-packages", ".conda",
    ".tox", ".pytest_cache", ".ruff_cache", ".mypy_cache", ".git", "venv", "envs",
]);
const originTargets = ["refs/remotes/origin/main", "refs/remotes/origin/master"];
const upstreamTargets = ["refs/remotes/upstream/main", "refs/remotes/upstream/master"];
const upstreamHead = "refs/remotes/upstream/HEAD";
let executable;

function digest(text) {
    return createHash("sha256").update(text).digest("hex");
}

async function git(repository, args, options = {}) {
    const { env: environment, ...overrides } = options;
    const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", ...environment };
    // Qoder may pass an incomplete process-level Git config to extension hosts.
    const configCount = Number(env.GIT_CONFIG_COUNT || 0);
    if (Number.isInteger(configCount) && configCount > 0
        && Array.from({ length: Math.min(configCount, 100) }, (_, i) => i)
            .some(i => !env["GIT_CONFIG_KEY_" + i] || !env["GIT_CONFIG_VALUE_" + i])) {
        for (const name of Object.keys(env)) {
            if (/^GIT_CONFIG_(COUNT|(?:KEY|VALUE)_\d+)$/i.test(name)) delete env[name];
        }
    }
    const spawnOptions = {
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
        timeout: 120000,
        env,
        ...overrides,
    };
    const candidates = executable ? [executable] : [
        "git",
        ...(process.platform === "win32" ? [
            process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Git", "cmd", "git.exe"),
            process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Git", "cmd", "git.exe"),
        ].filter(Boolean) : []),
    ];
    for (const candidate of candidates) {
        try {
            const { stdout } = await exec(candidate, ["-C", repository, ...args], spawnOptions);
            executable = candidate;
            return stdout;
        } catch (error) {
            if (error.code !== "ENOENT") {
                executable = candidate;
                throw error;
            }
        }
    }
    throw new Error("未找到 Git 可执行文件。请安装 Git 或将其加入 PATH。");
}

async function repositories(roots) {
    if (roots.length) await git(roots[0], ["--version"]);
    const found = new Set();
    const scanned = new Set();
    async function inspect(directory) {
        if (scanned.has(directory)) return;
        scanned.add(directory);
        const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
        if (entries.some(entry => entry.name === ".git" && (entry.isDirectory() || entry.isFile()))) {
            const root = await git(directory, ["rev-parse", "--show-toplevel"]).catch(() => "");
            if (root) found.add(path.normalize(root.trim()));
            return;
        }
        const children = entries.filter(entry => entry.isDirectory() && !skipped.has(entry.name));
        for (let first = 0; first < children.length; first += 12) {
            await Promise.all(children.slice(first, first + 12).map(entry => inspect(path.join(directory, entry.name))));
        }
    }
    await Promise.all(roots.map(async root => {
        const containing = await git(root, ["rev-parse", "--show-toplevel"]).catch(() => "");
        if (containing) found.add(path.normalize(containing.trim()));
        await inspect(root);
    }));
    return [...found].sort((a, b) => a.localeCompare(b));
}

async function branches(repository) {
    const [listing, current, remotes] = await Promise.all([
        git(repository, ["for-each-ref", "--format=%(refname)%09%(symref)", "refs/heads", "refs/remotes"]),
        git(repository, ["symbolic-ref", "-q", "HEAD"]).catch(() => ""),
        git(repository, ["remote"]),
    ]);
    const entries = listing.trim().split("\n").map(line => line.trimEnd().split("\t"));
    const refs = entries
        .filter(([id, symref]) => id && !symref)
        .map(([id]) => ({ id, label: id.replace(/^refs\/(heads|remotes)\//, "") }));
    const remoteHead = entries.find(([id]) => id === upstreamHead)?.[1];
    const defaults = [remoteHead?.startsWith("refs/remotes/upstream/") ? remoteHead : null, ...upstreamTargets, ...originTargets];
    if (!current.trim()) refs.unshift({ id: "HEAD", label: "HEAD（分离）" });
    return {
        refs,
        source: current.trim() || "HEAD",
        defaultTargets: [...new Set(defaults)].filter(id => refs.some(ref => ref.id === id)),
        hasUpstream: remotes.split(/\r?\n/).includes("upstream"),
    };
}

async function conflictFiles(repository, source, commit) {
    try {
        await git(repository, ["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", source, commit]);
        return null;
    } catch (error) {
        if (error.code !== 1) throw error;
        return error.stdout.split("\0").slice(1).filter(Boolean);
    }
}

async function safeUpstream(repository, source, tip) {
    const files = await conflictFiles(repository, source, tip);
    if (!files) return { commit: tip };

    let blocked = { commit: tip, files };
    const commits = (await git(repository, ["rev-list", "--first-parent", tip, "--not", source])).trim().split(/\r?\n/);
    for (const commit of commits.slice(1)) {
        const conflicts = await conflictFiles(repository, source, commit);
        if (!conflicts) return { commit, blocked };
        blocked = { commit, files: conflicts };
    }
    // The next first parent, when present, is already in the source history.
    const boundary = await git(repository, ["rev-parse", "--verify", "--quiet",
        "--end-of-options", commits.at(-1) + "^1"]).catch(error => {
        if (error.code !== 1) throw error;
        return "";
    });
    if (!boundary.trim()) throw new Error("上游主分支的第一父提交链上找不到可无冲突比较的提交。");
    return { commit: boundary.trim(), blocked };
}

async function updateUpstream(repository, source) {
    const sourceCommit = await resolve(repository, source);
    const head = await git(repository, ["ls-remote", "--symref", "upstream", "HEAD"]);
    const branch = head.match(/^ref: (refs\/heads\/[^\t\r\n]+)\tHEAD\r?$/m)?.[1];
    if (!branch) throw new Error("无法识别 upstream 远端的默认分支。");
    const target = "refs/remotes/upstream/" + branch.slice("refs/heads/".length);
    if (source === target) throw new Error("当前来源就是上游主分支，请先选择其他来源分支。");
    const old = await git(repository, ["rev-parse", "--verify", "--quiet", "--end-of-options", target]).catch(error => {
        if (error.code !== 1) throw error;
        return "";
    });
    const fetched = "refs/workspace-pr-review/fetch/" + randomUUID();
    try {
        await git(repository, ["fetch", "--no-tags", "--no-prune", "--no-recurse-submodules",
            "--no-write-fetch-head", "--refmap=", "upstream", branch + ":" + fetched]);
        const tip = await resolve(repository, fetched);
        const { commit, blocked } = await safeUpstream(repository, sourceCommit, tip);
        if (await resolve(repository, source) !== sourceCommit) {
            throw new Error("来源分支在检查期间发生了变化，请重新拉取上游更新。");
        }
        if (blocked) {
            await git(repository, ["update-ref", "refs/workspace-pr-review/objects/" + blocked.commit, blocked.commit]);
        }
        await git(repository, ["update-ref", "--no-deref", "-m", "workspace-pr-review: update upstream",
            target, commit, old.trim() || "0".repeat(tip.length)]);
        await git(repository, ["symbolic-ref", upstreamHead, target]);
        return { target, commit, tip, blocked };
    } finally {
        await git(repository, ["update-ref", "-d", fetched]);
    }
}

function namedChanges(raw) {
    const values = raw.split("\0");
    const files = [];
    for (let index = 0; index < values.length - 1;) {
        const status = values[index++];
        const oldPath = /^[RC]/.test(status) ? values[index++] : null;
        const file = values[index++];
        files.push({ path: file, oldPath, status });
    }
    return files;
}

function diffRows(patch) {
    const rows = [];
    let oldLine = null;
    let newLine = null;
    for (const text of patch.split("\n")) {
        const hunk = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hunk) {
            oldLine = Number(hunk[1]);
            newLine = Number(hunk[2]);
        } else if (oldLine !== null && /^[ +\-]/.test(text)) {
            rows.push({
                old: text.startsWith("+") ? 0 : oldLine++,
                new: text.startsWith("-") ? 0 : newLine++,
                text,
            });
        }
    }
    return rows;
}

async function compare(repository, target, source) {
    const [targetCommit, head] = await Promise.all([resolve(repository, target), resolve(repository, source)]);
    const base = (await git(repository, ["merge-base", targetCommit, head]).catch(() => "")).trim();
    if (!base) throw new Error("所选分支没有共同祖先，无法生成评阅 diff。");
    return comparison(repository, target, source, { targetCommit, base, head, sourceCommit: head });
}

async function resolve(repository, ref, kind = "commit") {
    return (await git(repository, ["rev-parse", "--verify", "--end-of-options", ref + "^{" + kind + "}"])).trim();
}

async function comparison(repository, target, source, range) {
    const { base, head } = range;
    const args = ["diff", "--find-renames", "--no-ext-diff", "--no-textconv", "--no-color", "--submodule=short"];
    const [names, content] = await Promise.all([
        git(repository, [...args, "--name-status", "-z", base, head, "--"]),
        git(repository, [...args, "--patch", "--full-index", "-U3", base, head, "--"]),
    ]);
    const list = namedChanges(names);
    const patches = content ? content.split(/(?=^diff --git )/m) : [];
    if (list.length !== patches.length) throw new Error("Git 返回的变更文件与补丁不一致。");
    return {
        repository, target, source, ...range,
        files: list.map((file, index) => ({
            ...file, id: digest(file.path).slice(0, 24), digest: digest(patches[index]),
            patch: patches[index], rows: diffRows(patches[index]),
        })),
    };
}

async function renamedPaths(repository, before, after) {
    if (before === after) return new Map();
    const names = await git(repository, ["diff", "--find-renames", "--no-ext-diff", "--no-textconv",
        "--name-status", "-z", before, after, "--"]);
    return new Map(namedChanges(names).filter(file => file.status.startsWith("R")).map(file => [file.oldPath, file.path]));
}

async function blob(snapshot, file, side) {
    if ((side === "old" && file.status === "A") || (side === "new" && file.status === "D")) return "";
    const commit = side === "old" ? snapshot.base : snapshot.head;
    const name = side === "old" ? file.oldPath || file.path : file.path;
    return git(snapshot.repository, ["show", "--no-ext-diff", "--no-textconv", commit + ":" + name]);
}

module.exports = { git, repositories, branches, updateUpstream, compare, resolve, comparison, renamedPaths, blob, digest,
    originTargets, upstreamTargets };

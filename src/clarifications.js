"use strict";

const submodule = /^(?:new file mode |deleted file mode |index [0-9a-f]+\.\.[0-9a-f]+ )160000\r?$/m;

function missingOnSide(rows, points, side) {
    const ranges = points.filter(point => point.side === side && Number.isSafeInteger(point.start)
        && Number.isSafeInteger(point.end) && point.start > 0 && point.end >= point.start)
        .sort((left, right) => left.start - right.start);
    const marker = side === "old" ? "-" : "+";
    const missing = [];
    let next = 0;
    let coveredThrough = 0;
    for (const row of rows) {
        if (!row.text.startsWith(marker)) continue;
        const line = row[side];
        while (next < ranges.length && ranges[next].start <= line) {
            coveredThrough = Math.max(coveredThrough, ranges[next++].end);
        }
        if (line <= coveredThrough) continue;
        const previous = missing.at(-1);
        if (previous?.end === line - 1) previous.end = line;
        else missing.push({ side, start: line, end: line });
    }
    return missing;
}

function uncoveredFiles(files, annotations) {
    const missing = [];
    for (const file of files) {
        if (!file.rows.length || submodule.test(file.patch)) continue;
        const current = annotations[file.id];
        const points = current?.digest === file.digest ? current.points : [];
        const ranges = [...missingOnSide(file.rows, points, "old"), ...missingOnSide(file.rows, points, "new")];
        if (ranges.length) {
            const { path, oldPath, status, digest } = file;
            missing.push({ path, oldPath, status, digest, ranges });
        }
    }
    return missing;
}

function mergePoints(previous, incoming) {
    const unique = new Map();
    for (const point of [...previous, ...incoming]) {
        unique.set(JSON.stringify([point.side, point.start, point.end, point.text]), point);
    }
    return [...unique.values()];
}

module.exports = { uncoveredFiles, mergePoints };
